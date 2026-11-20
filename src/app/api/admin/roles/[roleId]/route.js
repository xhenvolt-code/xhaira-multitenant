/**
 * Organization-scoped role details, updates, and soft deletion.
 */
import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { assertAuthorityOver, invalidateAllPermissionCaches, requirePermission } from '@/lib/permissions.js';
import { dispatch } from '@/lib/system-events.js';
import { normalizePermissionIds, replaceRolePermissions, withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;

  try {
    return await withOrganizationRbac(auth, async () => {
      const roleResult = await query(
        `SELECT r.*, COALESCE(d.name, d.department_name) AS department_name
           FROM roles r
           LEFT JOIN departments d ON d.id = r.department_id AND d.organization_id = r.organization_id
          WHERE r.id = $1 AND r.organization_id = $2`,
        [roleId, auth.organizationId]
      );
      if (!roleResult.rows[0]) {
        return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
      }

      const [permsResult, usersResult] = await Promise.all([
        query(
          `SELECT p.id, p.module, p.action, p.description, p.name AS perm_name, p.route_path, p.method
             FROM role_permissions rp
             JOIN permissions p ON rp.permission_id = p.id
            WHERE rp.role_id = $1 AND rp.organization_id = $2
            ORDER BY p.module, p.action`,
          [roleId, auth.organizationId]
        ),
        query(
          `SELECT u.id, u.name, u.email, COALESCE(s.name, s.full_name) AS staff_name,
                  u.status AS account_status, COALESCE(d.name, d.department_name) AS department
             FROM staff_roles sr
             JOIN staff s ON sr.staff_id = s.id AND s.organization_id = sr.organization_id
             JOIN users u ON u.staff_id = s.id AND u.organization_id = s.organization_id
             LEFT JOIN departments d ON s.department_id = d.id AND d.organization_id = s.organization_id
            WHERE sr.role_id = $1 AND sr.organization_id = $2
            ORDER BY COALESCE(s.name, s.full_name) ASC`,
          [roleId, auth.organizationId]
        ),
      ]);
      return NextResponse.json({
        success: true,
        data: { ...roleResult.rows[0], permissions: permsResult.rows, assigned_users: usersResult.rows },
      });
    });
  } catch (error) {
    console.error('Failed to fetch organization role:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch role' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;
  const client = await withOrganizationRbac(auth, () => getPool().connect());
  let changedRole;

  try {
    const body = await request.json();
    const permissionInput = body.permissionIds ?? body.permission_ids;
    let permissionIds;
    if (permissionInput !== undefined) {
      try {
        permissionIds = normalizePermissionIds(permissionInput);
      } catch (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
    }

    await client.query('BEGIN');
    const roleResult = await client.query(
      'SELECT id, name, is_system FROM public.roles WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [roleId, auth.organizationId]
    );
    if (!roleResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
    }
    if (roleResult.rows[0].is_system) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'System roles cannot be edited; create an organization role instead' }, { status: 400 });
    }

    const updates = [];
    const values = [];
    const addUpdate = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };
    if (body.description !== undefined) addUpdate('description', body.description);
    if (body.hierarchy_level !== undefined) {
      const level = Number(body.hierarchy_level);
      if (!Number.isInteger(level) || level < 1 || level > 100) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'hierarchy_level must be an integer from 1 to 100' }, { status: 400 });
      }
      addUpdate('hierarchy_level', level);
    }
    if (body.authority_level !== undefined) {
      const level = Number(body.authority_level);
      if (!Number.isInteger(level) || level < 1 || level > 100) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'authority_level must be an integer from 1 to 100' }, { status: 400 });
      }
      const authorityBlock = await assertAuthorityOver(auth, level);
      if (authorityBlock) {
        await client.query('ROLLBACK');
        return authorityBlock;
      }
      addUpdate('authority_level', level);
    }
    if (body.department_id !== undefined) addUpdate('department_id', body.department_id || null);
    if (body.alias !== undefined) addUpdate('alias', body.alias || null);
    if (body.responsibilities !== undefined) addUpdate('responsibilities', body.responsibilities || null);
    if (body.data_scope !== undefined) {
      if (!['OWN', 'DEPARTMENT', 'GLOBAL'].includes(body.data_scope)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'data_scope is invalid' }, { status: 400 });
      }
      addUpdate('data_scope', body.data_scope);
    }
    if (body.department_id) {
      const department = await client.query(
        'SELECT id FROM public.departments WHERE id = $1 AND organization_id = $2',
        [body.department_id, auth.organizationId]
      );
      if (!department.rows[0]) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Department was not found in this organization' }, { status: 400 });
      }
    }

    if (updates.length > 0) {
      values.push(roleId, auth.organizationId);
      const result = await client.query(
        `UPDATE public.roles SET ${updates.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND organization_id = $${values.length}
          RETURNING id, name, description, hierarchy_level, authority_level`,
        values
      );
      changedRole = result.rows[0];
    } else {
      changedRole = roleResult.rows[0];
    }
    if (permissionIds !== undefined) {
      await replaceRolePermissions(client, roleId, auth.organizationId, permissionIds);
    }
    await client.query('COMMIT');

    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'role_updated',
      entityType: 'role',
      entityId: roleId,
      details: { permissionCount: permissionIds?.length, hierarchyLevel: body.hierarchy_level, authorityLevel: body.authority_level },
      ...extractRbacMetadata(request),
    }));
    invalidateAllPermissionCaches();
    dispatch('role_updated', {
      entityType: 'role', entityId: roleId,
      description: 'Organization role was updated',
      metadata: { hierarchy_level: body.hierarchy_level, authority_level: body.authority_level },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, data: changedRole, message: 'Role updated' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back role update:', rollbackError);
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('Failed to update organization role:', error);
    return NextResponse.json({ success: false, error: 'Failed to update role' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;

  try {
    const result = await withOrganizationRbac(auth, async () => {
      const roleResult = await query(
        'SELECT id, name, is_system FROM public.roles WHERE id = $1 AND organization_id = $2',
        [roleId, auth.organizationId]
      );
      if (!roleResult.rows[0]) return { response: NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 }) };
      if (roleResult.rows[0].is_system) {
        return { response: NextResponse.json({ success: false, error: 'System roles cannot be deleted' }, { status: 400 }) };
      }

      const usersResult = await query(
        `SELECT COUNT(DISTINCT assigned.user_id)::int AS count
           FROM (
             SELECT u.id AS user_id
               FROM public.users u
              WHERE u.role_id = $1 AND u.organization_id = $2
             UNION
             SELECT u.id AS user_id
               FROM public.staff_roles sr
               JOIN public.staff s ON s.id = sr.staff_id AND s.organization_id = sr.organization_id
               JOIN public.users u ON u.staff_id = s.id AND u.organization_id = s.organization_id
              WHERE sr.role_id = $1 AND sr.organization_id = $2
           ) assigned`,
        [roleId, auth.organizationId]
      );
      if (Number(usersResult.rows[0].count) > 0) {
        return { response: NextResponse.json({ success: false, error: 'Remove this role from assigned staff before deactivating it' }, { status: 400 }) };
      }

      await query(
        'UPDATE public.roles SET is_active = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
        [roleId, auth.organizationId]
      );
      return { role: roleResult.rows[0] };
    });
    if (result.response) return result.response;

    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'role_deleted',
      entityType: 'role',
      entityId: roleId,
      details: { roleName: result.role.name },
      ...extractRbacMetadata(request),
    }));
    invalidateAllPermissionCaches();
    dispatch('role_deleted', {
      entityType: 'role', entityId: roleId,
      description: `Role "${result.role.name}" was deactivated`,
      metadata: { name: result.role.name },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, message: 'Role deactivated' });
  } catch (error) {
    console.error('Failed to delete organization role:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete role' }, { status: 500 });
  }
}
