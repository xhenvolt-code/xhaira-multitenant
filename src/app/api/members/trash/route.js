import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request) {
  try {
    const permission = await requirePermission(request, 'members.manage');
    if (permission instanceof NextResponse) return permission;
    return await runWithOrganizationContext(permission.auth.organizationId, async () => {
      const result = await query(
        `SELECT m.id, m.full_name, m.membership_number, m.phone, m.email, m.member_kind,
                m.status, m.exit_date, m.trashed_at, m.trashed_from_status,
                (SELECT COUNT(*)::int FROM member_accounts ma
                  WHERE ma.organization_id = m.organization_id AND ma.member_id = m.id) AS account_count
           FROM members m
          WHERE m.organization_id = $1 AND m.trashed_at IS NOT NULL
          ORDER BY m.trashed_at DESC`,
        [permission.auth.organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows }, { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (error) {
    console.error('[Members Trash] GET error:', error.message);
    return NextResponse.json({ success: false, error: 'Could not load member trash.' }, { status: 500 });
  }
}
