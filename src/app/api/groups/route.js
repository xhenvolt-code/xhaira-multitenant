import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const [groups, policies] = await Promise.all([
        query(`SELECT g.id, COALESCE(m.full_name, g.group_name) AS full_name, g.group_member_id,
                      COUNT(link.member_id) FILTER (WHERE linked_member.trashed_at IS NULL)::int AS member_count
                 FROM member_groups g
                 LEFT JOIN members m ON m.id = g.group_member_id AND m.organization_id = g.organization_id AND m.trashed_at IS NULL
                 LEFT JOIN member_group_links link ON link.group_id = g.id AND link.organization_id = g.organization_id
                 LEFT JOIN members linked_member ON linked_member.id = link.member_id AND linked_member.organization_id = link.organization_id
                WHERE g.organization_id = $1 AND (g.group_member_id IS NULL OR m.id IS NOT NULL)
                GROUP BY g.id, m.full_name, g.group_name, g.group_member_id
                ORDER BY full_name`, [perm.auth.organizationId]),
        query(`SELECT config_key, config_value FROM sacco_configurations
          WHERE organization_id = $1 AND config_key IN
          ('groups.requirement', 'groups.nature', 'groups.cardinality')`, [perm.auth.organizationId]),
      ]);
      const policy = Object.fromEntries(policies.rows.map((row) => [row.config_key, row.config_value]));
      return NextResponse.json({ success: true, data: policy['groups.requirement'] === 'disabled' ? [] : groups.rows, policy });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'members.create');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ success: false, error: 'Group name is required' }, { status: 400 });
    const config = await query(
      `SELECT config_key, config_value FROM sacco_configurations
        WHERE organization_id = $1 AND config_key IN ('groups.requirement', 'groups.nature')`,
      [perm.auth.organizationId]
    );
    const values = Object.fromEntries(config.rows.map((row) => [row.config_key, row.config_value]));
    const requirement = values['groups.requirement'] ?? 'optional';
    const nature = values['groups.nature'] ?? 'member_type';
    if (requirement === 'disabled') return NextResponse.json({ success: false, error: 'Groups are disabled by organization policy' }, { status: 400 });
    if (!['sub_organization', 'both'].includes(nature)) {
      return NextResponse.json({ success: false, error: 'Create this group using the member registration form' }, { status: 400 });
    }
    const result = await query(
      `INSERT INTO member_groups (organization_id, group_name)
       VALUES ($1, $2) RETURNING id, group_name AS full_name`,
      [perm.auth.organizationId, name]
    );
    return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
