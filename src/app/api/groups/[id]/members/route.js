import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const result = await query(`SELECT m.id, m.full_name, m.membership_number, m.status
        FROM member_group_links l JOIN members m ON m.id = l.member_id
        WHERE l.group_id = $1 ORDER BY m.full_name`, [id]);
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const { id } = await params;
    const body = await request.json();
    const requestedIds = Array.isArray(body.member_ids) ? body.member_ids : [body.member_id];
    const memberIds = [...new Set(requestedIds.filter((memberId) => typeof memberId === 'string'))];
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!memberIds.length || memberIds.some((memberId) => !uuidPattern.test(memberId))) {
      return NextResponse.json({ success: false, error: 'Select one or more valid individual members' }, { status: 400 });
    }
    const settings = await query(`SELECT config_key, config_value FROM sacco_configurations
      WHERE config_key IN ('groups.requirement', 'groups.nature', 'groups.cardinality')`);
    const policy = Object.fromEntries(settings.rows.map((row) => [row.config_key, row.config_value]));
    if (policy['groups.requirement'] === 'disabled') return NextResponse.json({ success: false, error: 'Groups are disabled by organization policy' }, { status: 400 });
    if (!['sub_organization', 'both'].includes(policy['groups.nature'])) return NextResponse.json({ success: false, error: 'This organization policy does not use individual group memberships' }, { status: 400 });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const [group, members] = await Promise.all([
        client.query('SELECT id FROM member_groups WHERE id = $1 FOR UPDATE', [id]),
        client.query("SELECT id FROM members WHERE id = ANY($1::uuid[]) AND member_kind = 'individual' ORDER BY id", [memberIds]),
      ]);
      if (!group.rows[0] || members.rows.length !== memberIds.length) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Group or one or more individual members were not found in your organization' }, { status: 404 });
      }
      if (policy['groups.cardinality'] === 'one') {
        await client.query('DELETE FROM member_group_links WHERE member_id = ANY($1::uuid[]) AND group_id <> $2', [memberIds, id]);
      }
      const result = await client.query(
        `INSERT INTO member_group_links (group_id, member_id)
         SELECT $1, selected.member_id
           FROM unnest($2::uuid[]) AS selected(member_id)
          ORDER BY selected.member_id
         ON CONFLICT (organization_id, group_id, member_id) DO NOTHING
         RETURNING member_id`,
        [id, memberIds]
      );
      await client.query('COMMIT');
      return NextResponse.json({ success: true, added_count: result.rowCount, data: result.rows }, { status: 201 });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { await client.release(); }
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: /only one group|belongs to the same organization/i.test(error.message) ? 409 : 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const { id } = await params;
    const { member_id: memberId } = await request.json();
    if (!memberId) return NextResponse.json({ success: false, error: 'member_id is required' }, { status: 400 });
    const config = await query(`SELECT config_value FROM sacco_configurations WHERE config_key = 'groups.requirement'`);
    const requirement = config.rows[0]?.config_value ?? 'optional';
    const nature = await query(`SELECT config_value FROM sacco_configurations WHERE config_key = 'groups.nature'`);
    if (!['sub_organization', 'both'].includes(nature.rows[0]?.config_value ?? 'member_type')) return NextResponse.json({ success: false, error: 'This organization policy does not use individual group memberships' }, { status: 400 });
    if (requirement === 'required') {
      const other = await query(`SELECT 1 FROM member_group_links WHERE member_id = $1 AND group_id <> $2 LIMIT 1`, [memberId, id]);
      if (!other.rows[0]) return NextResponse.json({ success: false, error: 'This organization requires each member to belong to a group' }, { status: 400 });
    }
    const result = await query(`DELETE FROM member_group_links WHERE group_id = $1 AND member_id = $2 RETURNING id`, [id, memberId]);
    if (!result.rows[0]) return NextResponse.json({ success: false, error: 'Group membership was not found' }, { status: 404 });
    return NextResponse.json({ success: true });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
