/**
 * GET /api/auth/me
 * Get current user information from session with roles, permissions,
 * hierarchy level, and pending approval count
 */

import { NextResponse } from 'next/server.js';
import { cookies } from 'next/headers.js';
import { getSession } from '@/lib/session.js';
import { logRouteAccess, extractRequestMetadata } from '@/lib/audit.js';
import { query } from '@/lib/db.js';
import { getUserPermissions, getUserHierarchyLevel, getUserAuthorityLevel } from '@/lib/permissions.js';
import { enterOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request) {
  try {
    const requestMetadata = extractRequestMetadata(request);

    // Get session from cookies
    const cookieStore = await cookies();
    const sessionId = cookieStore.get('xhaira_session')?.value;

    if (!sessionId) {
      await logRouteAccess({
        action: 'ROUTE_DENIED',
        route: '/api/auth/me',
        reason: 'No session provided',
        requestMetadata,
      });

      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Validate session
    const session = await getSession(sessionId);

    if (!session) {
      await logRouteAccess({
        action: 'ROUTE_DENIED',
        route: '/api/auth/me',
        reason: 'Invalid or expired session',
        requestMetadata,
      });

      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    enterOrganizationContext(session.organizationId);

    // Fetch detailed user information with RBAC roles
    const userResult = await query(
      `SELECT 
        u.id,
        u.email,
        u.name,
        u.role,
        u.role_id,
        u.status,
        u.is_active,
        u.authority_level,
        u.first_login_completed,
        u.created_at,
        u.organization_id,
        o.name AS organization_name,
        o.slug AS organization_slug,
        b.contact_phones AS organization_contact_phones,
        b.contact_email AS organization_contact_email,
        b.website AS organization_website,
        b.address AS organization_address,
        b.use_organization_name_as_app_name,
        b.sidebar_app_name_mode,
        b.logo_url AS organization_logo_url
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      LEFT JOIN company_branding b
        ON b.organization_id = o.id AND b.is_active = true
      WHERE u.id = $1 AND u.organization_id = $2`,
      [session.userId, session.organizationId]
    );

    if (userResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const user = userResult.rows[0];
    const isSuperadmin = user.role === 'superadmin';

    // Fetch RBAC roles for the user
    let rbacRoles = [];
    const rolesResult = await query(
      `SELECT DISTINCT r.name, r.hierarchy_level
         FROM public.users u
         LEFT JOIN public.staff s ON u.staff_id = s.id AND s.organization_id = u.organization_id
         LEFT JOIN public.staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
         JOIN public.roles r
           ON r.organization_id = u.organization_id AND r.is_active = true
          AND (r.id = COALESCE(sr.role_id, u.role_id) OR (sr.role_id IS NULL AND u.role_id IS NULL AND r.name = u.role))
        WHERE u.id = $1 AND u.organization_id = $2`,
      [user.id, session.organizationId]
    );
    rbacRoles = rolesResult.rows.map(r => r.name);

    // Fetch permissions using cached system
    let permissions = [];
    let hierarchyLevel = 5;
    let authorityLevel = user.authority_level ?? 10;
    if (isSuperadmin) {
      permissions = ['*'];
      hierarchyLevel = 1;
      authorityLevel = 100;
    } else {
      [permissions, hierarchyLevel, authorityLevel] = await Promise.all([
        getUserPermissions(user.id),
        getUserHierarchyLevel(user.id),
        getUserAuthorityLevel(user.id),
      ]);
    }

    // Count pending approval requests for this user (if they have authority)
    let pendingApprovals = 0;
    try {
      if (hierarchyLevel <= 3) {
        const approvalResult = await query(
          `SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending' AND organization_id = $1`,
          [session.organizationId]
        );
        pendingApprovals = parseInt(approvalResult.rows[0]?.cnt || 0, 10);
      }
    } catch (_) { /* approval_requests table may not exist yet */ }

    // Log successful access
    await logRouteAccess({
      action: 'PROTECTED_ROUTE_ACCESS',
      route: '/api/auth/me',
      userId: session.userId,
      requestMetadata,
    });

    return NextResponse.json(
      {
        user: {
          id: user.id,
          organizationId: user.organization_id,
          organization: {
            id: user.organization_id,
            name: user.organization_name,
            slug: user.organization_slug,
            branding: {
              organization_name: user.organization_name,
              contact_phones: user.organization_contact_phones || '',
              contact_email: user.organization_contact_email || '',
              website: user.organization_website || '',
              address: user.organization_address || '',
              use_organization_name_as_app_name: user.use_organization_name_as_app_name === true,
              sidebar_app_name_mode: user.sidebar_app_name_mode || (user.use_organization_name_as_app_name ? 'organization_name' : 'xhaira'),
              logo_url: user.organization_logo_url || '',
            },
          },
          email: user.email,
          name: user.name,
          full_name: user.name,
          role: user.role,
          status: user.status,
          is_active: user.is_active,
          is_superadmin: isSuperadmin,
          roles: rbacRoles.length > 0 ? rbacRoles : [user.role],
          permissions: permissions,
          hierarchy_level: hierarchyLevel,
          authority_level: authorityLevel,
          first_login_completed: user.first_login_completed ?? true,
          pending_approvals: pendingApprovals,
          created_at: user.created_at,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
