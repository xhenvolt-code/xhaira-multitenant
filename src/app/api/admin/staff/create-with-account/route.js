import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db.js';
import { hashPassword } from '@/lib/auth.js';
import { assertAuthorityOver, requirePermission, invalidateAllPermissionCaches } from '@/lib/permissions.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/staff/create-with-account
 * Create an organization staff record and linked user with an explicitly selected role.
 */
export async function POST(request) {
  const permission = await requirePermission(request, 'staff.create');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { staff_name: staffName, staff_email: staffEmail, username, password, department_id: departmentId } = body;
  const cleanName = typeof staffName === 'string' ? staffName.trim() : '';
  const cleanEmail = typeof staffEmail === 'string' ? staffEmail.trim().toLowerCase() : '';
  const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!cleanName || !cleanEmail || cleanUsername.length < 3 || typeof password !== 'string' || password.length < 8) {
    return NextResponse.json({ success: false, error: 'Name, email, username (min. 3 characters), and password (min. 8 characters) are required' }, { status: 400 });
  }
  if (!body.role_id && !body.role_name) {
    return NextResponse.json({ success: false, error: 'Select an organization role for this staff member' }, { status: 400 });
  }
  if (body.role_id !== undefined &&
      (typeof body.role_id !== 'string' || !UUID_PATTERN.test(body.role_id))) {
    return NextResponse.json({ success: false, error: 'role_id must be a valid role UUID' }, { status: 400 });
  }

  const client = await withOrganizationRbac(auth, () => getPool().connect());
  try {
    await client.query('BEGIN');
    const roleResult = await client.query(
      `SELECT id, name, authority_level
         FROM public.roles
        WHERE organization_id = $1 AND is_active = true
          AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($2::uuid IS NULL AND name = $3))
        LIMIT 1`,
      [auth.organizationId, body.role_id || null, body.role_name || '']
    );
    const role = roleResult.rows[0];
    if (!role) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Selected role was not found in this organization' }, { status: 400 });
    }
    if (role.name === 'superadmin' || (role.name === 'admin' && auth.role !== 'superadmin')) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'You cannot assign this role' }, { status: 403 });
    }
    const authorityBlock = await assertAuthorityOver(auth, role.authority_level ?? 0);
    if (authorityBlock) {
      await client.query('ROLLBACK');
      return authorityBlock;
    }

    if (departmentId) {
      const department = await client.query(
        'SELECT id FROM public.departments WHERE id = $1 AND organization_id = $2',
        [departmentId, auth.organizationId]
      );
      if (!department.rows[0]) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Department was not found in this organization' }, { status: 400 });
      }
    }

    const duplicate = await client.query(
      `SELECT 1 FROM public.users
        WHERE organization_id = $1 AND (LOWER(email) = $2 OR LOWER(username) = $3)
        LIMIT 1`,
      [auth.organizationId, cleanEmail, cleanUsername]
    );
    if (duplicate.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Email or username is already in use' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO public.users
         (username, email, name, password_hash, role, role_id, organization_id,
          status, is_active, must_reset_password, first_login_completed, authority_level,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', true, true, false, $8, NOW(), NOW())
       RETURNING id, username, email, name, role, role_id, authority_level`,
      [cleanUsername, cleanEmail, cleanName, passwordHash, 'user', role.id, auth.organizationId, role.authority_level ?? 10]
    );
    const user = userResult.rows[0];

    const staffResult = await client.query(
      `INSERT INTO public.staff
         (name, email, user_id, linked_user_id, role_id, department_id, organization_id, status)
       VALUES ($1, $2, $3, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [cleanName, cleanEmail, user.id, role.id, departmentId || null, auth.organizationId]
    );
    const staff = staffResult.rows[0];
    await client.query(
      'UPDATE public.users SET staff_id = $1 WHERE id = $2 AND organization_id = $3',
      [staff.id, user.id, auth.organizationId]
    );
    await client.query(
      `INSERT INTO public.staff_roles (staff_id, role_id, assigned_by, organization_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (staff_id, role_id) DO NOTHING`,
      [staff.id, role.id, auth.userId, auth.organizationId]
    );
    await client.query('COMMIT');

    invalidateAllPermissionCaches();
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'staff_created_with_account',
      entityType: 'staff',
      entityId: staff.id,
      details: { userId: user.id, roleId: role.id, roleName: role.name },
      ...extractRbacMetadata(request),
    }));
    return NextResponse.json({ success: true, staff, user_id: user.id }, { status: 201 });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back staff/user creation:', rollbackError);
    }
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'Email or username is already in use' }, { status: 409 });
    }
    console.error('Error creating organization staff with account:', error);
    return NextResponse.json({ success: false, error: 'Failed to create staff account' }, { status: 500 });
  } finally {
    client.release();
  }
}
