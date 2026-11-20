import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { assertAuthorityOver, requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';
import { invalidateAllPermissionCaches } from '@/lib/permissions.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'users.view');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { userId } = await params;
  try {
    const result = await withOrganizationRbac(auth, () => query(
      `SELECT id, email, name, role, role_id, status, is_active, last_login, created_at, updated_at
         FROM public.users
        WHERE id = $1 AND organization_id = $2`,
      [userId, auth.organizationId]
    ));
    if (!result.rows[0]) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Failed to fetch organization user:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch user' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  const permission = await requirePermission(request, 'users.update');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { userId } = await params;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
  const allowedStatuses = ['active', 'pending', 'suspended', 'disabled'];
  if (body.status !== undefined && !allowedStatuses.includes(body.status)) {
    return NextResponse.json({ success: false, error: 'Invalid account status' }, { status: 400 });
  }
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
    return NextResponse.json({ success: false, error: 'is_active must be a boolean' }, { status: 400 });
  }
  if (body.role_id !== undefined && body.role_id !== null && body.role_id !== '' &&
      (typeof body.role_id !== 'string' || !UUID_PATTERN.test(body.role_id))) {
    return NextResponse.json({ success: false, error: 'role_id must be a valid role UUID' }, { status: 400 });
  }

  const client = await withOrganizationRbac(auth, () => getPool().connect());
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `SELECT id, role, role_id, staff_id
         FROM public.users
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [userId, auth.organizationId]
    );
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }
    const currentUser = userResult.rows[0];
    if (currentUser.role === 'superadmin') {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Organization superadmin accounts cannot be changed here' }, { status: 403 });
    }

    const updates = [];
    const values = [];
    const addUpdate = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Name must not be empty' }, { status: 400 });
      }
      addUpdate('name', body.name.trim());
    }
    if (body.status !== undefined) addUpdate('status', body.status);
    if (body.is_active !== undefined) addUpdate('is_active', body.is_active);

    const roleWasProvided = body.role_id !== undefined || body.role !== undefined;
    let selectedRole = null;
    if (roleWasProvided) {
      const roleResult = await client.query(
        `SELECT id, name, authority_level
           FROM public.roles
          WHERE organization_id = $1 AND is_active = true
            AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($2::uuid IS NULL AND name = $3))
          LIMIT 1`,
        [auth.organizationId, body.role_id || null, body.role || '']
      );
      selectedRole = roleResult.rows[0];
      if (!selectedRole) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Select an active organization role' }, { status: 400 });
      }
      if (selectedRole.name === 'superadmin' || (selectedRole.name === 'admin' && auth.role !== 'superadmin')) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'You cannot assign this role' }, { status: 403 });
      }
      const authorityBlock = await assertAuthorityOver(auth, selectedRole.authority_level ?? 0);
      if (authorityBlock) {
        await client.query('ROLLBACK');
        return authorityBlock;
      }
      addUpdate('role', 'user');
      addUpdate('role_id', selectedRole.id);
      addUpdate('authority_level', selectedRole.authority_level ?? 10);
    }

    let updatedUser = currentUser;
    if (updates.length > 0) {
      values.push(userId, auth.organizationId);
      const updated = await client.query(
        `UPDATE public.users SET ${updates.join(', ')}, updated_at = NOW()
          WHERE id = $${values.length - 1} AND organization_id = $${values.length}
          RETURNING id, email, name, role, role_id, status, is_active`,
        values
      );
      updatedUser = updated.rows[0];
    }
    if (roleWasProvided && currentUser.staff_id) {
      await client.query(
        'DELETE FROM public.staff_roles WHERE staff_id = $1 AND organization_id = $2',
        [currentUser.staff_id, auth.organizationId]
      );
      await client.query(
        `INSERT INTO public.staff_roles (staff_id, role_id, assigned_by, organization_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (staff_id, role_id) DO NOTHING`,
        [currentUser.staff_id, selectedRole.id, auth.userId, auth.organizationId]
      );
      await client.query(
        'UPDATE public.staff SET role_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
        [selectedRole.id, currentUser.staff_id, auth.organizationId]
      );
    }
    await client.query('COMMIT');
    invalidateAllPermissionCaches();
    return NextResponse.json({ success: true, data: updatedUser });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back user update:', rollbackError);
    }
    console.error('Failed to update organization user:', error);
    return NextResponse.json({ success: false, error: 'Failed to update user' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(request, { params }) {
  const permission = await requirePermission(request, 'users.delete');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { userId } = await params;
  try {
    const result = await withOrganizationRbac(auth, () => query(
      `DELETE FROM public.users
        WHERE id = $1 AND organization_id = $2 AND role <> 'superadmin'
        RETURNING id, email`,
      [userId, auth.organizationId]
    ));
    if (!result.rows[0]) {
      const exists = await withOrganizationRbac(auth, () => query(
        'SELECT role FROM public.users WHERE id = $1 AND organization_id = $2',
        [userId, auth.organizationId]
      ));
      if (!exists.rows[0]) return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
      return NextResponse.json({ success: false, error: 'Cannot delete organization superadmin users' }, { status: 403 });
    }
    invalidateAllPermissionCaches();
    return NextResponse.json({
      success: true,
      message: `User ${result.rows[0].email} deleted successfully`,
      data: { id: result.rows[0].id, email: result.rows[0].email },
    });
  } catch (error) {
    console.error('Failed to delete organization user:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete user' }, { status: 500 });
  }
}
