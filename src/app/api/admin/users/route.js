import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { assertAuthorityOver, requirePermission, getUserAuthorityLevel, buildAuthorityFilter } from '@/lib/permissions.js';
import { createUser, hashPassword } from '@/lib/auth.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';
import { validateRegister } from '@/lib/validation.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request) {
  const perm = await requirePermission(request, 'users.view');
  if (perm instanceof NextResponse) return perm;
  try {
    const { auth } = perm;

    // Hierarchy filter: viewer only sees users whose authority_level <= their own
    // Superadmin always gets authority 100 (bypasses filter entirely via 1=1).
    const viewerAuthority = auth.role === 'superadmin' ? 100 : await withOrganizationRbac(auth, () => getUserAuthorityLevel(auth.userId));
    const { clause, params } = buildAuthorityFilter(viewerAuthority, {
      actorAuthorityCol: 'u.authority_level',
      startIdx: 1,
    });

    const result = await withOrganizationRbac(auth, () => query(
      `SELECT u.id, u.email, u.username, u.name, u.role, u.status, u.is_active,
              u.authority_level, u.first_login_completed, u.must_reset_password,
              u.last_login, u.created_at, u.staff_id, u.role_id,
              u.email AS staff_email,
              r.name  AS role_name,
              r.hierarchy_level,
              r.authority_level AS role_authority_level
         FROM users u
         LEFT JOIN roles  r ON r.id = u.role_id AND r.organization_id = u.organization_id
        WHERE ${clause} AND u.organization_id = $${params.length + 1}
        ORDER BY u.created_at DESC`,
      [...params, auth.organizationId]
    ));

    // Safety valve: never silently return empty when records exist but were
    // filtered by authority. Surface a clear message instead.
    if (result.rows.length === 0 && viewerAuthority < 100) {
      const total = await withOrganizationRbac(auth, () => query(
        'SELECT COUNT(*) AS cnt FROM users WHERE organization_id = $1',
        [auth.organizationId]
      ));
      if (parseInt(total.rows[0].cnt, 10) > 0) {
        return NextResponse.json({
          success: true,
          data: [],
          restricted: true,
          message: 'Access restricted to higher authority users',
        });
      }
    }

    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[admin/users] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch users' }, { status: 500 });
  }
}

/**
 * POST /api/admin/users
 * Create a new user
 * Required permission: users.create
 */
export async function POST(request) {
  const perm = await requirePermission(request, 'users.create');
  if (perm instanceof NextResponse) return perm;

  try {
    const { auth } = perm;
    const body = await request.json();

    const validation = validateRegister(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Validation failed', fields: validation.errors }, { status: 400 });
    }
    const { email, name, password } = validation.data;
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : undefined;
    if (username !== undefined && !/^[a-z0-9_]{3,100}$/.test(username)) {
      return NextResponse.json(
        { error: 'Username must be 3 to 100 characters and contain only letters, numbers, or underscores' },
        { status: 400 }
      );
    }
    if (body.role_id !== undefined && body.role_id !== null && body.role_id !== '' &&
        (typeof body.role_id !== 'string' || !UUID_PATTERN.test(body.role_id))) {
      return NextResponse.json({ error: 'role_id must be a valid role UUID' }, { status: 400 });
    }

    const selectedRoleResult = await withOrganizationRbac(auth, () => query(
      `SELECT id, name, authority_level
         FROM public.roles
        WHERE organization_id = $1 AND is_active = true
          AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($2::uuid IS NULL AND name = $3))
        LIMIT 1`,
      [auth.organizationId, body.role_id || null, body.role || 'staff']
    ));
    const selectedRole = selectedRoleResult.rows[0];
    if (!selectedRole) return NextResponse.json({ error: 'Select an active organization role' }, { status: 400 });
    if (selectedRole.name === 'superadmin' || (selectedRole.name === 'admin' && auth.role !== 'superadmin')) {
      return NextResponse.json({ error: 'You cannot assign this role' }, { status: 403 });
    }
    const authorityBlock = await assertAuthorityOver(auth, selectedRole.authority_level ?? 0);
    if (authorityBlock) return authorityBlock;

    // Check if email already exists
    const existing = await withOrganizationRbac(auth, () => query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND organization_id = $2',
      [email, auth.organizationId]
    ));
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 409 }
      );
    }

    // Prepare user data
    const passwordHash = await hashPassword(password);
    const created = await withOrganizationRbac(auth, () => createUser({
      email,
      passwordHash,
      name,
      username,
      role: 'user',
      roleId: selectedRole.id,
      status: body.status || 'pending',
      mustResetPassword: true,
    }));

    if (created?.error) {
      return NextResponse.json({ error: created.error }, { status: 409 });
    }
    if (!created?.id) {
      return NextResponse.json(
        { error: 'Failed to create user' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: 'User created successfully',
        data: created
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('[admin/users] POST error:', {
      code: error.code,
      constraint: error.constraint,
      message: error.message,
    });
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error.code === '42703' || error.code === '42P01') {
      return NextResponse.json(
        { error: 'The database schema is missing required user/RBAC fields. Apply the pending organization RBAC migration, then retry.' },
        { status: 503 }
      );
    }
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Email or username is already in use' }, { status: 409 });
    }
    return NextResponse.json(
      { error: 'Failed to create user' },
      { status: 500 }
    );
  }
}
