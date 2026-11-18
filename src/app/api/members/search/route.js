import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const MAX_RESULTS = 15;
const PRIVATE_NO_STORE = { headers: { 'Cache-Control': 'private, no-store' } };

function escapeLikePrefix(value) {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function GET(request) {
  try {
    const permission = await requirePermission(request, 'members.view');
    if (permission instanceof NextResponse) return permission;

    return await runWithOrganizationContext(permission.auth.organizationId, async () => {
      const { searchParams } = new URL(request.url);
      const search = (searchParams.get('search') || '').trim();
      if (search.length < 2) {
        return NextResponse.json({ success: true, data: [] }, { headers: { 'Cache-Control': 'private, no-store' } });
      }
      if (search.length > 100) {
        return NextResponse.json({ success: false, error: 'Search text must be 100 characters or fewer.' },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
      }

      const groupPolicyResult = await query(
        `SELECT config_key, config_value FROM sacco_configurations
          WHERE organization_id = $1 AND config_key IN ('groups.requirement', 'groups.nature')`,
        [permission.auth.organizationId]
      );
      const groupPolicy = Object.fromEntries(
        groupPolicyResult.rows.map(({ config_key, config_value }) => [config_key, config_value])
      );
      const excludeGroups = groupPolicy['groups.requirement'] === 'disabled' ||
        groupPolicy['groups.nature'] === 'sub_organization';
      const groupFilter = excludeGroups
        ? `AND m.member_kind = 'individual'`
        : `AND (m.member_kind <> 'group' OR EXISTS (
             SELECT 1 FROM member_groups registered_group
              WHERE registered_group.group_member_id = m.id
                AND registered_group.organization_id = m.organization_id
           ))`;

      const result = await query(
        `SELECT m.id, m.full_name, m.membership_number, m.phone
           FROM members m
          WHERE m.organization_id = $1
            AND m.status = 'active'
            ${groupFilter}
            AND (
              lower(m.full_name) LIKE $2 ESCAPE '\\'
              OR lower(m.membership_number) LIKE $2 ESCAPE '\\'
              OR lower(m.phone) LIKE $2 ESCAPE '\\'
            )
          ORDER BY lower(m.full_name), m.id
          LIMIT ${MAX_RESULTS}`,
        [permission.auth.organizationId, escapeLikePrefix(search.toLowerCase())]
      );

      return NextResponse.json({ success: true, data: result.rows }, { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (error) {
    console.error('[Member Search] GET error:', error.message);
    return NextResponse.json({ success: false, error: 'Could not search members.' }, { status: 500, ...PRIVATE_NO_STORE });
  }
}
