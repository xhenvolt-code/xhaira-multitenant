/**
 * Organization-scoped role catalog and role creation.
 */
import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { assertAuthorityOver, invalidateAllPermissionCaches, requirePermission } from '@/lib/permissions.js';
import { dispatch } from '@/lib/system-events.js';
import { normalizePermissionIds, replaceRolePermissions, withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;

  try {
    const result = await withOrganizationRbac(auth, () => query(
      `SELECT r.id, r.name, r.description, r.is_system, r.is_active,
              r.hierarchy_level, r.authority_level, r.department_id, r.alias,
              r.responsibilities, r.created_by, r.created_at, r.updated_at,
              COALESCE(r.data_scope, 'OWN') AS data_scope,
              COALESCE(d.name, d.department_name) AS department_name,
              (SELECT COUNT(*) FROM role_permissions rp
                WHERE rp.role_id = r.id AND rp.organization_id = $1) AS permission_count,
              (SELECT COUNT(DISTINCT u.id)
                 FROM staff_roles sr
                 JOIN staff s ON s.id = sr.staff_id AND s.organization_id = sr.organization_id
                 JOIN users u ON u.staff_id = s.id AND u.organization_id = s.organization_id
                WHERE sr.role_id = r.id AND sr.organization_id = $1) AS user_count
         FROM roles r
         LEFT JOIN departments d ON d.id = r.department_id AND d.organization_id = r.organization_id
        WHERE r.organization_id = $1 AND r.is_active = true
        ORDER BY r.authority_level DESC, r.hierarchy_level ASC, r.name ASC`,
      [auth.organizationId]
    ));
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to fetch organization roles:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch roles. Verify the RBAC migration is applied.' }, { status: 500 });
  }
}

export async function POST(request) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const client = await withOrganizationRbac(auth, () => getPool().connect());
  let role;
  let permissionCount = 0;

  try {
    const body = await request.json();
    const { name, description, hierarchy_level, authority_level, department_id, alias, responsibilities } = body;
    let permissionIds;
    try {
      permissionIds = normalizePermissionIds(body.permissionIds ?? body.permission_ids ?? []);
    } catch (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
      return NextResponse.json({ success: false, error: 'Role name must contain 1 to 100 characters' }, { status: 400 });
    }
    const sanitizedName = name.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
    const hierarchyLevel = Number.isInteger(Number(hierarchy_level)) ? Math.max(1, Math.min(100, Number(hierarchy_level))) : 5;
    const authorityLevel = Number.isInteger(Number(authority_level)) ? Math.max(1, Math.min(100, Number(authority_level))) : 20;
    const authorityBlock = await assertAuthorityOver(auth, authorityLevel);
    if (authorityBlock) return authorityBlock;

    await client.query('BEGIN');
    if (department_id) {
      const department = await client.query(
        'SELECT id FROM public.departments WHERE id = $1 AND organization_id = $2',
        [department_id, auth.organizationId]
      );
      if (!department.rows[0]) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Department was not found in this organization' }, { status: 400 });
      }
    }
    const inserted = await client.query(
      `INSERT INTO public.roles
         (organization_id, name, description, is_system, hierarchy_level, authority_level,
          department_id, alias, responsibilities, created_by, data_scope)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9, 'OWN')
       RETURNING id, name, description, hierarchy_level, authority_level, department_id, alias, is_active`,
      [
        auth.organizationId, sanitizedName, description || '', hierarchyLevel, authorityLevel,
        department_id || null, alias || null, responsibilities || null, auth.userId,
      ]
    );
    role = inserted.rows[0];
    permissionCount = await replaceRolePermissions(client, role.id, auth.organizationId, permissionIds);
    await client.query('COMMIT');

    const meta = extractRbacMetadata(request);
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'role_created',
      entityType: 'role',
      entityId: role.id,
      details: { roleName: role.name, hierarchyLevel, authorityLevel, permissionCount },
      ...meta,
    }));
    invalidateAllPermissionCaches();
    dispatch('role_created', {
      entityType: 'role', entityId: role.id,
      description: `Role "${role.name}" was created (authority: ${authorityLevel})`,
      metadata: { name: role.name, hierarchy_level: hierarchyLevel, authority_level: authorityLevel },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, data: role }, { status: 201 });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back role creation:', rollbackError);
    }
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'A role with this name already exists in this organization' }, { status: 409 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('Failed to create organization role:', error);
    return NextResponse.json({ success: false, error: 'Failed to create role' }, { status: 500 });
  } finally {
    client.release();
  }
}
