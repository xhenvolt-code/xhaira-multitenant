import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { dispatch } from '@/lib/system-events.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

// GET /api/departments — list departments belonging to the authenticated organization.
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'departments.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('active_only') !== 'false';
    const search = searchParams.get('search');

    let sql = `
      SELECT d.*,
        COALESCE(d.name, d.department_name) AS display_name,
        (SELECT COUNT(*) FROM staff s
          WHERE s.organization_id = d.organization_id
            AND (to_jsonb(s)->>'department_id' = d.id::text
              OR to_jsonb(s)->>'department' = COALESCE(d.name, d.department_name))
            AND COALESCE(to_jsonb(s)->>'status', 'active') = 'active') AS staff_count,
        (SELECT COUNT(*) FROM roles r
          WHERE r.organization_id = d.organization_id
            AND to_jsonb(r)->>'department_id' = d.id::text) AS role_count,
        (SELECT COUNT(*) FROM department_policies dp
          WHERE dp.organization_id = d.organization_id AND dp.department_id = d.id AND dp.is_active = true) AS policy_count,
        p.name AS parent_name,
        hu.name AS head_name
      FROM departments d
      LEFT JOIN departments p ON d.parent_department_id = p.id AND p.organization_id = d.organization_id
      LEFT JOIN users hu ON d.head_user_id = hu.id AND hu.organization_id = d.organization_id
      WHERE d.organization_id = $1
    `;
    const params = [auth.organizationId];
    if (activeOnly) sql += ' AND d.is_active = true';
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (COALESCE(d.name, d.department_name) ILIKE $${params.length} OR d.alias ILIKE $${params.length})`;
    }
    sql += ' ORDER BY COALESCE(d.name, d.department_name) ASC';

    const result = await withOrganizationRbac(auth, () => query(sql, params));
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Departments] GET error:', { code: error.code || 'UNKNOWN', constraint: error.constraint || null, message: error.message });
    return NextResponse.json({ success: false, error: 'Failed to fetch departments' }, { status: 500 });
  }
}

// POST /api/departments — create a department in the authenticated organization.
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'departments.manage');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    let body;
    try { body = await request.json(); } catch {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }
    const { name, description, alias, parent_department_id, head_user_id, color, icon } = body;
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ success: false, error: 'name is required' }, { status: 400 });
    }

    if (parent_department_id) {
      const parent = await withOrganizationRbac(auth, () => query(
        'SELECT id FROM public.departments WHERE id = $1 AND organization_id = $2',
        [parent_department_id, auth.organizationId]
      ));
      if (!parent.rows[0]) {
        return NextResponse.json({ success: false, error: 'Parent department was not found in this organization' }, { status: 400 });
      }
    }
    if (head_user_id) {
      const head = await withOrganizationRbac(auth, () => query(
        'SELECT id FROM public.users WHERE id = $1 AND organization_id = $2',
        [head_user_id, auth.organizationId]
      ));
      if (!head.rows[0]) {
        return NextResponse.json({ success: false, error: 'Department head was not found in this organization' }, { status: 400 });
      }
    }

    const result = await withOrganizationRbac(auth, () => query(
      `INSERT INTO public.departments
         (name, department_name, description, alias, parent_department_id, head_user_id, color, icon, organization_id)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [name.trim(), description || null, alias || null, parent_department_id || null, head_user_id || null,
       color || '#3b82f6', icon || null, auth.organizationId]
    ));

    await withOrganizationRbac(auth, () => query(
      `INSERT INTO public.audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [auth.userId, 'CREATE', 'department', result.rows[0].id, JSON.stringify({ name: name.trim() })]
    ));

    dispatch('department_created', {
      entityType: 'department', entityId: result.rows[0].id,
      description: `Department "${name.trim()}" was created`, actorId: auth.userId,
    });

    return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
  } catch (error) {
    if (error.code === '23505') return NextResponse.json({ success: false, error: 'Department already exists' }, { status: 409 });
    console.error('[Departments] POST error:', { code: error.code || 'UNKNOWN', constraint: error.constraint || null });
    return NextResponse.json({ success: false, error: 'Failed to create department' }, { status: 500 });
  }
}
