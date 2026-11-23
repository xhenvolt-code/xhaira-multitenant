import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/members/[id]/audit — Audit trail for a member
export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(100, parseInt(searchParams.get('limit') || '50'));

    const result = await query(
      `SELECT al.*, u.name as performed_by_name, u.email as performed_by_email
       FROM member_audit_log al
       LEFT JOIN users u ON al.performed_by = u.id AND u.organization_id = al.organization_id
       WHERE al.member_id = $1 AND al.organization_id = $2
         AND EXISTS (SELECT 1 FROM members m WHERE m.id = $1 AND m.organization_id = $2 AND m.trashed_at IS NULL)
       ORDER BY al.created_at DESC
       LIMIT $3`,
      [id, perm.auth.organizationId, limit]
    );

    return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
