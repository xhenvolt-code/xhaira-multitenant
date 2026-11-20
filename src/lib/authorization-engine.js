/**
 * AuthorizationEngine
 * =====================================================================
 * Central Domain Service — Identity & Access Core
 *
 * This is the SINGLE SOURCE OF TRUTH for all access decisions in Xhaira.
 * Every module that needs to check user permissions MUST call this
 * service instead of implementing its own authorization logic.
 *
 * Architecture:
 *   users → staff → staff_roles → roles → role_permissions → permissions
 *
 * Public API (server-side / API routes):
 *   requirePermission(request, 'module.action')
 *   requirePermissionWithHierarchy(request, module, action, recordCreatorId)
 *   hasPermission(userId, module, action, userRole)
 *   getUserPermissions(userId)
 *   getUserAuthorityLevel(userId)
 *   getUserHierarchyLevel(userId)
 *   getUserIdentity(userId)          ← new: full identity + roles in one call
 *   checkHierarchyAuthority(actingUserId, recordCreatorId, action)
 *   assignRole(userId, roleName, assignedBy)
 *   removeRole(userId, roleName)
 *   invalidatePermissionCache(userId)
 *   invalidateAllPermissionCaches()
 *
 * Re-exports all functions from permissions.js so callers only need
 * to import from this one module.
 * =====================================================================
 */

export {
  // Core permission checks
  hasPermission,
  getUserPermissions,
  getUserHierarchyLevel,
  getUserAuthorityLevel,
  getRolePermissionsFromDB,

  // Middleware helpers (for API routes)
  requirePermission,
  requirePermissionWithHierarchy,

  // Hierarchy / authority
  checkHierarchyAuthority,

  // Cache management
  invalidatePermissionCache,
  invalidateAllPermissionCaches,

  // Approval workflow
  createApprovalRequest,
  resolveApprovalRequest,
  getPendingApprovalsForUser,

  // Role management
  assignRole,
  removeRole,
  getAllPermissionsGrouped,

  // Legacy role helpers (kept for backward-compatibility)
  canAccess,
  canManageUser,
  isStaffAdmin,
  isFinanceUser,
  isSalesUser,
  isAuditor,
  canSoftDelete,
  canLock,
  canExport,
  getAllRoles,
  getRolePermissions,
  getRoleLevel,
} from './permissions.js';

import { query } from './db.js';
import { getOrganizationContext } from './organization-context.js';

/**
 * getUserIdentity
 * -----------------------------------------------------------------------
 * Load a complete user identity object in one call: user record, linked
 * staff record, assigned roles, and effective permissions.
 *
 * Used by the dashboard and any component that needs full context.
 *
 * @param {string} userId  UUID of the authenticated user
 * @returns {Promise<{
 *   user: object,
 *   staff: object|null,
 *   roles: string[],
 *   permissions: string[],
 *   authorityLevel: number,
 *   hierarchyLevel: number,
 *   isSuperadmin: boolean,
 * }>}
 */
export async function getUserIdentity(userId) {
  try {
    const organizationId = getOrganizationContext();
    if (!organizationId) throw new Error('Organization context is required for user authorization');
    const [userRow, staffRow, rolesRow, permsRow] = await Promise.all([
      // User record
      query(
        `SELECT id, email, name, role, status, staff_id, organization_id
           FROM users WHERE id = $1 AND organization_id = $2`,
        [userId, organizationId]
      ),
      // Staff record via foreign key
      query(
        `SELECT s.id, COALESCE(s.name, s.full_name) AS name, s.email,
                s.department_id, s.staff_status,
                COALESCE(d.name, d.department_name) AS department_name
         FROM users u
         JOIN staff s ON u.staff_id = s.id
         LEFT JOIN departments d ON s.department_id = d.id AND d.organization_id = s.organization_id
         WHERE u.id = $1 AND u.organization_id = $2 AND s.organization_id = $2`,
        [userId, organizationId]
      ),
      // Assigned roles
      query(
        `SELECT DISTINCT r.name, r.authority_level, r.hierarchy_level
         FROM users u
         JOIN staff s ON u.staff_id = s.id AND s.organization_id = u.organization_id
         JOIN staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
         JOIN roles r ON sr.role_id = r.id AND r.organization_id = sr.organization_id AND r.is_active = true
         WHERE u.id = $1 AND u.organization_id = $2
         ORDER BY r.authority_level DESC`,
        [userId, organizationId]
      ),
      // Effective permissions
      query(
        `SELECT DISTINCT p.module, p.action
         FROM users u
         JOIN staff s ON u.staff_id = s.id AND s.organization_id = u.organization_id
         JOIN staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
         JOIN roles r ON sr.role_id = r.id AND r.organization_id = sr.organization_id AND r.is_active = true
         JOIN role_permissions rp ON sr.role_id = rp.role_id AND rp.organization_id = sr.organization_id
         JOIN permissions p ON rp.permission_id = p.id
         WHERE u.id = $1 AND u.organization_id = $2`,
        [userId, organizationId]
      ),
    ]);

    const user = userRow.rows[0] || null;
    if (!user) return null;

    const isSuperadmin = user.role === 'superadmin';
    const permissions = isSuperadmin
      ? ['*']
      : permsRow.rows.map((r) => `${r.module}.${r.action}`);

    const authorityLevel = isSuperadmin
      ? 100
      : Math.max(0, ...rolesRow.rows.map((r) => r.authority_level ?? 0));

    const hierarchyLevel = isSuperadmin
      ? 1
      : Math.min(5, ...rolesRow.rows.map((r) => r.hierarchy_level ?? 5));

    return {
      user,
      staff: staffRow.rows[0] || null,
      roles: rolesRow.rows.map((r) => r.name),
      permissions,
      authorityLevel,
      hierarchyLevel,
      isSuperadmin,
    };
  } catch (error) {
    console.error('[AuthorizationEngine] getUserIdentity failed:', error.message);
    return null;
  }
}

/**
 * canAccessModule
 * -----------------------------------------------------------------------
 * Quick boolean check: does the user have ANY permission in a given module?
 *
 * @param {string}   userId
 * @param {string}   module  e.g. 'finance'
 * @param {string}   role    optional — superadmin shortcut
 * @returns {Promise<boolean>}
 */
export async function canAccessModule(userId, module, role) {
  if (role === 'superadmin') return true;
  try {
    const organizationId = getOrganizationContext();
    if (!organizationId) throw new Error('Organization context is required for permission checks');
    const result = await query(
      `SELECT 1
       FROM users u
       JOIN staff s ON u.staff_id = s.id AND s.organization_id = u.organization_id
       JOIN staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
       JOIN roles r ON sr.role_id = r.id AND r.organization_id = sr.organization_id AND r.is_active = true
       JOIN role_permissions rp ON sr.role_id = rp.role_id AND rp.organization_id = sr.organization_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE u.id = $1 AND u.organization_id = $3 AND p.module = $2
       LIMIT 1`,
      [userId, module, organizationId]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('[AuthorizationEngine] canAccessModule failed:', error.message);
    return false;
  }
}

/**
 * getDashboardModules
 * -----------------------------------------------------------------------
 * Returns the list of modules the user can access, for building a
 * role-scoped dashboard.
 *
 * @param {string} userId
 * @param {string} role  — user.role from session (superadmin shortcut)
 * @returns {Promise<string[]>}  e.g. ['dashboard', 'finance', 'deals']
 */
export async function getDashboardModules(userId, role) {
  if (role === 'superadmin') return null; // null = all modules
  try {
    const organizationId = getOrganizationContext();
    if (!organizationId) throw new Error('Organization context is required for dashboard permissions');
    const result = await query(
      `SELECT DISTINCT p.module
       FROM users u
       JOIN staff s ON u.staff_id = s.id AND s.organization_id = u.organization_id
       JOIN staff_roles sr ON sr.staff_id = s.id AND sr.organization_id = s.organization_id
       JOIN roles r ON sr.role_id = r.id AND r.organization_id = sr.organization_id AND r.is_active = true
       JOIN role_permissions rp ON sr.role_id = rp.role_id AND rp.organization_id = sr.organization_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE u.id = $1 AND u.organization_id = $2`,
      [userId, organizationId]
    );
    return result.rows.map((r) => r.module);
  } catch (error) {
    console.error('[AuthorizationEngine] getDashboardModules failed:', error.message);
    return [];
  }
}
