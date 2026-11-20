import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  const permission = await requirePermission(request, 'users.view');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  try {
    const result = await withOrganizationRbac(auth, () => query(
      `SELECT r.id, r.name, r.alias, r.hierarchy_level, r.authority_level, r.department_id,
              COALESCE(d.name, d.department_name) AS department_name
         FROM public.roles r
         LEFT JOIN public.departments d
           ON d.id = r.department_id AND d.organization_id = r.organization_id
        WHERE r.organization_id = $1 AND r.is_active = true
          AND r.name <> 'superadmin'
          AND ($2::boolean OR r.name <> 'admin')
        ORDER BY r.authority_level DESC, r.name`,
      [auth.organizationId, auth.role === 'superadmin']
    ));
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to fetch assignable organization roles:', error);
    return NextResponse.json({ success: false, error: 'Failed to load organization roles' }, { status: 500 });
  }
}
