/**
 * Organization-scoped identity integrity diagnostics for the organization owner.
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  const permission = await requirePermission(request, 'users.view');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  if (auth.role !== 'superadmin') {
    return NextResponse.json({ error: 'Organization superadmin only' }, { status: 403 });
  }

  try {
    const [
      totalUsers,
      totalStaff,
      totalRoles,
      linkedUsers,
      orphanUsers,
      staffWithoutUser,
      staffWithoutRole,
      staffRolesCount,
      activeUsers,
      pendingUsers,
    ] = await withOrganizationRbac(auth, () => Promise.all([
      query('SELECT COUNT(*) AS cnt FROM public.users WHERE organization_id = $1', [auth.organizationId]),
      query('SELECT COUNT(*) AS cnt FROM public.staff WHERE organization_id = $1', [auth.organizationId]),
      query('SELECT COUNT(*) AS cnt FROM public.roles WHERE organization_id = $1', [auth.organizationId]),
      query('SELECT COUNT(*) AS cnt FROM public.users WHERE staff_id IS NOT NULL AND organization_id = $1', [auth.organizationId]),
      query('SELECT COUNT(*) AS cnt FROM public.users WHERE staff_id IS NULL AND organization_id = $1', [auth.organizationId]),
      query(
        `SELECT COUNT(*) AS cnt FROM public.staff s
          WHERE s.organization_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM public.users u
               WHERE u.staff_id = s.id AND u.organization_id = s.organization_id
            )
            AND s.linked_user_id IS NULL`,
        [auth.organizationId]
      ),
      query('SELECT COUNT(*) AS cnt FROM public.staff WHERE role_id IS NULL AND organization_id = $1', [auth.organizationId]),
      query('SELECT COUNT(*) AS cnt FROM public.staff_roles WHERE organization_id = $1', [auth.organizationId]),
      query(
        `SELECT COUNT(*) AS cnt FROM public.users
          WHERE is_active = true AND status = 'active' AND organization_id = $1`,
        [auth.organizationId]
      ),
      query(
        `SELECT COUNT(*) AS cnt FROM public.users
          WHERE status = 'pending' AND organization_id = $1`,
        [auth.organizationId]
      ),
    ]));

    const orphanList = await withOrganizationRbac(auth, () => query(
      `SELECT id, username, email, name, role, authority_level, created_at
         FROM public.users
        WHERE staff_id IS NULL AND organization_id = $1
        ORDER BY created_at DESC`,
      [auth.organizationId]
    ));
    const staffNoUserList = await withOrganizationRbac(auth, () => query(
      `SELECT s.id, s.name, s.email, s.role_id, r.name AS role_name
         FROM public.staff s
         LEFT JOIN public.roles r ON s.role_id = r.id AND r.organization_id = s.organization_id
        WHERE s.organization_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM public.users u
             WHERE u.staff_id = s.id AND u.organization_id = s.organization_id
          )
          AND s.linked_user_id IS NULL`,
      [auth.organizationId]
    ));
    const staffNoRoleList = await withOrganizationRbac(auth, () => query(
      'SELECT id, name, email FROM public.staff WHERE role_id IS NULL AND organization_id = $1',
      [auth.organizationId]
    ));

    return NextResponse.json({
      success: true,
      data: {
        totals: {
          users: parseInt(totalUsers.rows[0].cnt, 10),
          staff: parseInt(totalStaff.rows[0].cnt, 10),
          roles: parseInt(totalRoles.rows[0].cnt, 10),
          staffRoles: parseInt(staffRolesCount.rows[0].cnt, 10),
        },
        users: {
          linked: parseInt(linkedUsers.rows[0].cnt, 10),
          orphan: parseInt(orphanUsers.rows[0].cnt, 10),
          active: parseInt(activeUsers.rows[0].cnt, 10),
          pending: parseInt(pendingUsers.rows[0].cnt, 10),
        },
        staff: {
          withoutUser: parseInt(staffWithoutUser.rows[0].cnt, 10),
          withoutRole: parseInt(staffWithoutRole.rows[0].cnt, 10),
        },
        integrity: {
          healthy: parseInt(orphanUsers.rows[0].cnt, 10) === 0 &&
            parseInt(staffWithoutUser.rows[0].cnt, 10) === 0 &&
            parseInt(staffWithoutRole.rows[0].cnt, 10) === 0,
        },
        orphanUsers: orphanList.rows,
        staffWithoutUser: staffNoUserList.rows,
        staffWithoutRole: staffNoRoleList.rows,
      },
    });
  } catch (error) {
    console.error('[debug] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load debug data' }, { status: 500 });
  }
}
