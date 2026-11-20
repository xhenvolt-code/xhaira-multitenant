/**
 * Organization-scoped staff role assignments.
 */
import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { invalidateAllPermissionCaches, requirePermission } from '@/lib/permissions.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { dispatch } from '@/lib/system-events.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const permission = await requirePermission(request, 'staff.update');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { staffId } = await params;

  try {
    const result = await withOrganizationRbac(auth, () => query(
      `SELECT r.id, r.name, r.description, r.hierarchy_level, r.authority_level,
              r.is_system, r.department_id,
              COALESCE(d.name, d.department_name) AS department_name,
              sr.assigned_by, sr.assigned_at
         FROM public.staff_roles sr
         JOIN public.staff s ON s.id = sr.staff_id AND s.organization_id = sr.organization_id
         JOIN public.roles r ON r.id = sr.role_id AND r.organization_id = sr.organization_id
         LEFT JOIN public.departments d ON d.id = r.department_id AND d.organization_id = r.organization_id
        WHERE sr.staff_id = $1 AND sr.organization_id = $2
        ORDER BY r.authority_level DESC`,
      [staffId, auth.organizationId]
    ));
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Failed to fetch staff roles:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch staff roles' }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  const permission = await requirePermission(request, 'staff.update');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { staffId } = await params;

  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
  const roleIds = body.role_ids ?? body.roleIds ?? [];
  if (!Array.isArray(roleIds) || roleIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    return NextResponse.json({ success: false, error: 'role_ids must be an array of role UUIDs' }, { status: 400 });
  }
  const uniqueRoleIds = [...new Set(roleIds)];
  const client = await withOrganizationRbac(auth, () => getPool().connect());

  try {
    await client.query('BEGIN');
    const staffResult = await client.query(
      'SELECT id, role_id, linked_user_id, user_id FROM public.staff WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [staffId, auth.organizationId]
    );
    if (!staffResult.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 });
    }

    const targetRoles = uniqueRoleIds.length
      ? await client.query(
        'SELECT id, name, authority_level FROM public.roles WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
        [uniqueRoleIds, auth.organizationId]
      )
      : { rows: [] };
    if (targetRoles.rows.length !== uniqueRoleIds.length) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'One or more selected roles are unavailable in this organization' }, { status: 400 });
    }
    if (targetRoles.rows.some((role) => role.name === 'superadmin')) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'The superadmin role cannot be assigned to staff' }, { status: 403 });
    }
    if (auth.role !== 'superadmin' && targetRoles.rows.some((role) => role.name === 'admin')) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Only the organization superadmin can assign the admin role' }, { status: 403 });
    }

    if (auth.role !== 'superadmin' && uniqueRoleIds.length > 0) {
      const authority = await client.query(
        `SELECT COALESCE(MAX(r.authority_level), 0) AS max_authority
           FROM public.users u
           JOIN public.staff s ON s.id = u.staff_id AND s.organization_id = u.organization_id
           JOIN public.staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
           JOIN public.roles r ON r.id = sr.role_id AND r.organization_id = sr.organization_id
          WHERE u.id = $1 AND u.organization_id = $2`,
        [auth.userId, auth.organizationId]
      );
      const assignerAuthority = Number(authority.rows[0]?.max_authority || 0);
      if (targetRoles.rows.some((role) => Number(role.authority_level || 0) >= assignerAuthority)) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'You cannot assign a role at or above your authority level' }, { status: 403 });
      }
    }

    const previous = await client.query(
      'SELECT role_id FROM public.staff_roles WHERE staff_id = $1 AND organization_id = $2',
      [staffId, auth.organizationId]
    );
    await client.query(
      'DELETE FROM public.staff_roles WHERE staff_id = $1 AND organization_id = $2',
      [staffId, auth.organizationId]
    );
    for (const roleId of uniqueRoleIds) {
      await client.query(
        `INSERT INTO public.staff_roles (staff_id, role_id, assigned_by, organization_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (staff_id, role_id) DO NOTHING`,
        [staffId, roleId, auth.userId, auth.organizationId]
      );
    }

    const primaryRole = targetRoles.rows.find((role) => role.id === uniqueRoleIds[0]);
    await client.query(
      'UPDATE public.staff SET role_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [primaryRole?.id || null, staffId, auth.organizationId]
    );
    const linkedUserId = staffResult.rows[0].linked_user_id || staffResult.rows[0].user_id;
    if (linkedUserId) {
      await client.query(
        `UPDATE public.users
            SET role_id = $1, role = $2, authority_level = $3, updated_at = NOW()
          WHERE id = $4 AND organization_id = $5`,
        [primaryRole?.id || null, 'user', primaryRole?.authority_level || 10, linkedUserId, auth.organizationId]
      );
    }
    await client.query('COMMIT');

    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'staff_roles_replaced',
      entityType: 'staff',
      entityId: staffId,
      details: { previousRoleIds: previous.rows.map((row) => row.role_id), newRoleIds: uniqueRoleIds },
      ...extractRbacMetadata(request),
    }));
    invalidateAllPermissionCaches();
    dispatch('role_assigned', {
      entityType: 'staff', entityId: staffId,
      description: `Role assignments updated for staff member (${uniqueRoleIds.length} role(s))`,
      metadata: { roleIds: uniqueRoleIds, assignedBy: auth.userId },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, message: `${uniqueRoleIds.length} role(s) assigned`, assigned: uniqueRoleIds.length });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back staff role update:', rollbackError);
    }
    console.error('Failed to assign staff roles:', error);
    return NextResponse.json({ success: false, error: 'Failed to assign staff roles' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(request, { params }) {
  const permission = await requirePermission(request, 'staff.update');
  if (permission instanceof NextResponse) return permission;
  const { auth } = permission;
  const { staffId } = await params;
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof body.role_id !== 'string' || !UUID_PATTERN.test(body.role_id)) {
    return NextResponse.json({ success: false, error: 'role_id must be a role UUID' }, { status: 400 });
  }

  const client = await withOrganizationRbac(auth, () => getPool().connect());
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
        `DELETE FROM public.staff_roles
          WHERE staff_id = $1 AND role_id = $2 AND organization_id = $3
          RETURNING staff_id`,
        [staffId, body.role_id, auth.organizationId]
    );
    if (!deleted.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Role assignment not found' }, { status: 404 });
    }
    const remaining = await client.query(
        `SELECT r.id, r.name, r.authority_level
           FROM public.staff_roles sr
           JOIN public.roles r ON r.id = sr.role_id AND r.organization_id = sr.organization_id
          WHERE sr.staff_id = $1 AND sr.organization_id = $2
          ORDER BY sr.assigned_at LIMIT 1`,
        [staffId, auth.organizationId]
    );
    await client.query(
        'UPDATE public.staff SET role_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
        [remaining.rows[0]?.id || null, staffId, auth.organizationId]
    );
    const user = await client.query(
        'SELECT COALESCE(linked_user_id, user_id) AS user_id FROM public.staff WHERE id = $1 AND organization_id = $2',
        [staffId, auth.organizationId]
    );
    if (user.rows[0]?.user_id) {
      await client.query(
          `UPDATE public.users SET role_id = $1, role = $2, authority_level = $3, updated_at = NOW()
            WHERE id = $4 AND organization_id = $5`,
          [remaining.rows[0]?.id || null, 'user', remaining.rows[0]?.authority_level || 10, user.rows[0].user_id, auth.organizationId]
      );
    }
    await client.query('COMMIT');
    invalidateAllPermissionCaches();
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'staff_role_removed',
      entityType: 'staff',
      entityId: staffId,
      details: { roleId: body.role_id },
      ...extractRbacMetadata(request),
    }));
    dispatch('role_removed', {
      entityType: 'staff', entityId: staffId,
      description: 'Role removed from staff member',
      metadata: { roleId: body.role_id, removedBy: auth.userId },
      actorId: auth.userId,
    });
    return NextResponse.json({ success: true, message: 'Role removed from staff' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('Failed to roll back staff role removal:', rollbackError);
    }
    console.error('Failed to remove staff role:', error);
    return NextResponse.json({ success: false, error: 'Failed to remove staff role' }, { status: 500 });
  } finally {
    client.release();
  }
}
