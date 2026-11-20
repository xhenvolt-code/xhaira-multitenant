/**
 * Create a linked user account for an existing organization staff member.
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db.js';
import { requirePermission, assertAuthorityOver, invalidateAllPermissionCaches } from '@/lib/permissions.js';
import { hashPassword } from '@/lib/auth.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function POST(request, { params }) {
  const permission = await requirePermission(request, 'staff.create');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { staffId } = await params;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { username, password, email: bodyEmail } = body;
  if (typeof username !== 'string' || username.trim().length < 3) {
    return NextResponse.json({ success: false, error: 'username must be at least 3 characters' }, { status: 400 });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return NextResponse.json({ success: false, error: 'Temporary password must be at least 8 characters' }, { status: 400 });
  }

  const client = await withOrganizationRbac(auth, () => getPool().connect());
  try {
    await client.query('BEGIN');
    const staffResult = await client.query(
      `SELECT s.*, COALESCE(s.linked_user_id, s.user_id) AS existing_user_id
         FROM public.staff s
        WHERE s.id = $1 AND s.organization_id = $2
        FOR UPDATE`,
      [staffId, auth.organizationId]
    );
    if (!staffResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 });
    }
    const staff = staffResult.rows[0];
    if (staff.existing_user_id) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'This staff member already has a linked user account' }, { status: 409 });
    }

    const email = String(bodyEmail || staff.email || '').trim().toLowerCase();
    if (!email) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'An email address is required' }, { status: 400 });
    }

    let roleId = staff.role_id;
    if (!roleId) {
      const staffRole = await client.query(
        `SELECT role_id FROM public.staff_roles
          WHERE staff_id = $1 AND organization_id = $2
          ORDER BY assigned_at LIMIT 1`,
        [staffId, auth.organizationId]
      );
      roleId = staffRole.rows[0]?.role_id || null;
    }
    if (!roleId) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Assign an organization role to this staff member before creating an account' }, { status: 400 });
    }

    const roleResult = await client.query(
      `SELECT id, name, authority_level
         FROM public.roles
        WHERE id = $1 AND organization_id = $2 AND is_active = true`,
      [roleId, auth.organizationId]
    );
    if (!roleResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'The staff role is unavailable in this organization' }, { status: 400 });
    }
    const role = roleResult.rows[0];
    if (role.name === 'superadmin') {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'A new organization superadmin can only be created through organization registration' }, { status: 403 });
    }
    if (role.name === 'admin' && auth.role !== 'superadmin') {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Only the organization superadmin can create administrators' }, { status: 403 });
    }
    const authorityBlock = await assertAuthorityOver(auth, role.authority_level ?? 0);
    if (authorityBlock) {
      await client.query('ROLLBACK');
      return authorityBlock;
    }

    const [emailCheck, usernameCheck] = await Promise.all([
      client.query('SELECT id FROM public.users WHERE LOWER(email) = $1 AND organization_id = $2', [email, auth.organizationId]),
      client.query('SELECT id FROM public.users WHERE LOWER(username) = $1 AND organization_id = $2', [username.trim().toLowerCase(), auth.organizationId]),
    ]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'A user account with this email already exists' }, { status: 409 });
    }
    if (usernameCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Username is already taken' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO public.users
         (email, username, name, password_hash, role, role_id, staff_id, organization_id,
          status, is_active, must_reset_password, first_login_completed, authority_level,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', true, true, false, $9, NOW(), NOW())
       RETURNING id, email, username, name, role, authority_level`,
      [
        email,
        username.trim().toLowerCase(),
        staff.name || staff.full_name || email.split('@')[0],
        passwordHash,
        'user',
        role.id,
        staffId,
        auth.organizationId,
        role.authority_level ?? 10,
      ]
    );
    const user = userResult.rows[0];

    await client.query(
      `UPDATE public.staff
          SET linked_user_id = $1, user_id = $1, role_id = $2, updated_at = NOW()
        WHERE id = $3 AND organization_id = $4`,
      [user.id, role.id, staffId, auth.organizationId]
    );
    await client.query(
      `INSERT INTO public.staff_roles (staff_id, role_id, assigned_by, organization_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (staff_id, role_id) DO NOTHING`,
      [staffId, role.id, auth.userId, auth.organizationId]
    );
    await client.query('COMMIT');
    invalidateAllPermissionCaches();
    return NextResponse.json({ success: true, user }, { status: 201 });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back staff account creation:', rollbackError);
    }
    if (error.code === '23505') {
      return NextResponse.json({ success: false, error: 'Email or username is already in use' }, { status: 409 });
    }
    console.error('[create-account] Organization staff account creation failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to create account' }, { status: 500 });
  } finally {
    client.release();
  }
}
