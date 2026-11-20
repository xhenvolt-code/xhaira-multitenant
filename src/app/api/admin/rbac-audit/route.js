/**
 * GET /api/admin/rbac-audit - List RBAC audit log entries
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'audit.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');

    let sql = `
      SELECT ral.*, u.name AS user_name, u.email AS user_email
      FROM public.rbac_audit_logs ral
      LEFT JOIN public.users u
        ON ral.user_id = u.id AND u.organization_id = ral.organization_id
    `;
    const params = [auth.organizationId];
    const conditions = ['ral.organization_id = $1'];

    if (action) {
      conditions.push(`ral.action = $${params.length + 1}`);
      params.push(action);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ` ORDER BY ral.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await withOrganizationRbac(auth, () => query(sql, params));

    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to fetch RBAC audit logs:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch RBAC audit logs' }, { status: 500 });
  }
}
