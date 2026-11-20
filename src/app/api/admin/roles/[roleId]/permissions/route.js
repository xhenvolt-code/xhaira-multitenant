/**
 * Organization-scoped permission assignments for a role.
 */
import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { invalidateAllPermissionCaches, requirePermission } from '@/lib/permissions.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { dispatch } from '@/lib/system-events.js';
import { normalizePermissionIds, replaceRolePermissions, withOrganizationRbac } from '@/lib/rbac-tenant.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;
  try {
    return await withOrganizationRbac(auth, async () => {
      const role = await query(
        'SELECT id FROM public.roles WHERE id = $1 AND organization_id = $2',
        [roleId, auth.organizationId]
      );
      if (!role.rows[0]) return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
      const result = await query(
        `SELECT p.id, p.module, p.action, p.description, p.name, p.route_path, p.method
           FROM public.role_permissions rp
           JOIN public.permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = $1 AND rp.organization_id = $2
          ORDER BY p.module, p.action`,
        [roleId, auth.organizationId]
      );
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('Failed to fetch role permissions:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch role permissions' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;
  const client = await withOrganizationRbac(auth, () => getPool().connect());

  try {
    const body = await request.json();
    let permissionIds;
    try {
      permissionIds = normalizePermissionIds(body.permission_ids ?? body.permissionIds);
    } catch (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    await client.query('BEGIN');
    const roleCheck = await client.query(
      'SELECT id, name, is_system FROM public.roles WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [roleId, auth.organizationId]
    );
    if (!roleCheck.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Role not found' }, { status: 404 });
    }
    if (roleCheck.rows[0].is_system) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'System role permissions are managed by the application' }, { status: 400 });
    }
    const count = await replaceRolePermissions(client, roleId, auth.organizationId, permissionIds);
    await client.query('COMMIT');

    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'role_permissions_replaced',
      entityType: 'role',
      entityId: roleId,
      details: { permissionCount: count, roleName: roleCheck.rows[0].name },
      ...extractRbacMetadata(request),
    }));
    invalidateAllPermissionCaches();
    dispatch('role_permissions_updated', {
      entityType: 'role', entityId: roleId,
      description: `Permissions updated for role "${roleCheck.rows[0].name}"`,
      metadata: { permissionCount: count },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, message: 'Role permissions updated', count });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back role permission update:', rollbackError);
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    console.error('Failed to update role permissions:', error);
    return NextResponse.json({ success: false, error: 'Failed to update role permissions' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function PATCH(request, { params }) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { roleId } = await params;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
  const { permission_id: permissionId, enabled } = body;
  if (typeof permissionId !== 'string' || !UUID_PATTERN.test(permissionId) || typeof enabled !== 'boolean') {
    return NextResponse.json({ success: false, error: 'permission_id and enabled are required' }, { status: 400 });
  }

  const client = await withOrganizationRbac(auth, () => getPool().connect());
  try {
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
      return NextResponse.json({ success: false, error: 'System role permissions are managed by the application' }, { status: 400 });
    }
    const permissionResult = await client.query(
      'SELECT id FROM public.permissions WHERE id = $1',
      [permissionId]
    );
    if (!permissionResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Permission not found' }, { status: 404 });
    }

    if (enabled) {
      await client.query(
        `INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
         VALUES ($1, $2, $3) ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [roleId, permissionId, auth.organizationId]
      );
    } else {
      await client.query(
        `DELETE FROM public.role_permissions
          WHERE role_id = $1 AND permission_id = $2 AND organization_id = $3`,
        [roleId, permissionId, auth.organizationId]
      );
    }
    await client.query('COMMIT');
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: enabled ? 'permission_granted' : 'permission_revoked',
      entityType: 'role',
      entityId: roleId,
      details: { permissionId, roleName: roleResult.rows[0].name },
      ...extractRbacMetadata(request),
    }));
    invalidateAllPermissionCaches();
    return NextResponse.json({ success: true, enabled });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back role permission toggle:', rollbackError);
    }
    console.error('Failed to toggle role permission:', error);
    return NextResponse.json({ success: false, error: 'Failed to toggle permission' }, { status: 500 });
  } finally {
    client.release();
  }
}
