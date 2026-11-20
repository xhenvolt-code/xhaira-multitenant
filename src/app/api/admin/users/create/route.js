/**
 * POST /api/admin/users/create
 * 
 * Admin-only endpoint for creating new users
 * Only accessible by SUPER_ADMIN and ADMIN roles
 * 
 * Request body:
 * {
 *   email: string (required)
 *   password: string (required, min 8 chars)
 *   name: string (required)
 *   role: string (default: 'staff', can be 'admin' or 'staff')
 * }
 * 
 * Response:
 * - 201: User created successfully
 * - 400: Validation failed
 * - 403: Unauthorized (not admin)
 * - 409: Email already exists
 * - 500: Server error
 */

import { NextResponse } from 'next/server';
import { assertAuthorityOver, requirePermission } from '@/lib/permissions.js';
import { query } from '@/lib/db.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';
import { validateRegister } from '@/lib/validation.js';
import {
  createUser,
  hashPassword,
} from '@/lib/auth.js';
import { logAuthEvent, extractRequestMetadata } from '@/lib/audit.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request) {
  try {
    // Verify admin permission
    const perm = await requirePermission(request, 'users.create');
    if (perm instanceof NextResponse) return perm;

    const { auth } = perm;
    const body = await request.json();

    // Validate input
    const validation = validateRegister(body);
    if (!validation.success) {
      await logAuthEvent({
        action: 'USER_CREATE_VALIDATION_FAILED',
        created_by: auth.userId,
        reason: 'Validation failed',
        requestMetadata: extractRequestMetadata(request),
      });

      return NextResponse.json(
        {
          error: 'Validation failed',
          fields: validation.errors,
        },
        { status: 400 }
      );
    }

    const { email, password, name } = validation.data;
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
    if (!selectedRole) {
      return NextResponse.json({ error: 'Select an active role belonging to this organization' }, { status: 400 });
    }

    if (selectedRole.name === 'superadmin' || (selectedRole.name === 'admin' && auth.role !== 'superadmin')) {
      await logAuthEvent({
        action: 'USER_CREATE_ADMIN_BLOCKED',
        created_by: auth.userId,
        email,
        reason: 'Role assignment exceeds the creator privilege',
        requestMetadata: extractRequestMetadata(request),
      });

      return NextResponse.json(
        {
          error: 'Permission denied',
          message: 'Only the organization superadmin can create administrators; a new superadmin must use organization registration',
        },
        { status: 403 }
      );
    }
    const authorityBlock = await assertAuthorityOver(auth, selectedRole.authority_level ?? 0);
    if (authorityBlock) return authorityBlock;

    const requestMetadata = extractRequestMetadata(request);

    // Check if email already exists
    const existingUser = await withOrganizationRbac(auth, () => query(
      'SELECT id FROM public.users WHERE LOWER(email) = LOWER($1) AND organization_id = $2',
      [email, auth.organizationId]
    ));
    if (existingUser.rows.length > 0) {
      await logAuthEvent({
        action: 'USER_CREATE_DUPLICATE',
        created_by: auth.userId,
        email,
        reason: 'Email already exists',
        requestMetadata,
      });

      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user with specified role
    const user = await withOrganizationRbac(auth, () => createUser({
      email,
      passwordHash,
      name,
      username,
      role: 'user',
      roleId: selectedRole.id,
      status: 'active', // Admin-created users are immediately active
      mustResetPassword: true,
    }));

    if (user?.error) {
      return NextResponse.json({ error: user.error }, { status: 409 });
    }
    if (!user || !user.id) {
      await logAuthEvent({
        action: 'USER_CREATE_FAILED',
        created_by: auth.userId,
        email,
        reason: 'Database error',
        requestMetadata,
      });

      return NextResponse.json(
        {
          error: 'Failed to create user',
          message: 'An error occurred during user creation.',
        },
        { status: 500 }
      );
    }

    await logAuthEvent({
      action: 'USER_CREATE_SUCCESS',
      created_by: auth.userId,
      user_id: user.id,
      email: user.email,
      role: user.role,
      requestMetadata,
    });

    return NextResponse.json(
      {
        success: true,
        message: `User ${user.email} created successfully`,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('User creation error:', {
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
      {
        error: 'User creation failed',
        message: 'An unexpected error occurred. Please try again.',
      },
      { status: 500 }
    );
  }
}
