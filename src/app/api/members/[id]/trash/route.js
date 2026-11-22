import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(request, { params }) {
  try {
    const permission = await requirePermission(request, 'members.manage');
    if (permission instanceof NextResponse) return permission;
    const { id } = await params;
    if (!UUID_PATTERN.test(String(id || ''))) return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });

    return await runWithOrganizationContext(permission.auth.organizationId, async () => {
      const result = await query(
        `UPDATE public.members
            SET trashed_at = COALESCE(trashed_at, NOW()),
                trashed_by = COALESCE(trashed_by, $3),
                trashed_from_status = COALESCE(trashed_from_status, status),
                status = 'exited', exit_date = COALESCE(exit_date, CURRENT_DATE), updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND trashed_at IS NULL
          RETURNING id, full_name, status, trashed_at`,
        [id, permission.auth.organizationId, permission.auth.userId]
      );
      if (!result.rows[0]) return NextResponse.json({ success: false, error: 'Member not found or already in Trash' }, { status: 404 });
      await query(
        `INSERT INTO member_audit_log (member_id, action, performed_by, new_values)
         VALUES ($1, 'status_changed', $2, $3)`,
        [id, permission.auth.userId || null, JSON.stringify({ status: 'exited', trashed_at: result.rows[0].trashed_at })]
      ).catch(() => {});
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Members Trash] DELETE error:', error.message);
    return NextResponse.json({ success: false, error: 'Could not move member to Trash.' }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const permission = await requirePermission(request, 'members.manage');
    if (permission instanceof NextResponse) return permission;
    const { id } = await params;
    if (!UUID_PATTERN.test(String(id || ''))) return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });

    return await runWithOrganizationContext(permission.auth.organizationId, async () => {
      const result = await query(
        `UPDATE public.members
            SET status = COALESCE(NULLIF(trashed_from_status, 'exited'), 'active'),
                trashed_at = NULL, trashed_by = NULL, trashed_from_status = NULL,
                updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND trashed_at IS NOT NULL
          RETURNING id, full_name, status`,
        [id, permission.auth.organizationId]
      );
      if (!result.rows[0]) return NextResponse.json({ success: false, error: 'Member not found in Trash' }, { status: 404 });
      await query(
        `INSERT INTO member_audit_log (member_id, action, performed_by, new_values)
         VALUES ($1, 'status_changed', $2, $3)`,
        [id, permission.auth.userId || null, JSON.stringify({ status: result.rows[0].status })]
      ).catch(() => {});
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[Members Trash] restore error:', error.message);
    return NextResponse.json({ success: false, error: 'Could not restore member.' }, { status: 500 });
  }
}
