/**
 * RBAC Audit Logger
 * Dedicated audit logging for permission-sensitive actions
 */

import { query } from './db.js';
import { getOrganizationContext } from './organization-context.js';

/**
 * Log an RBAC-related action to the dedicated rbac_audit_logs table
 * @param {Object} params
 * @param {string} params.userId - Acting user's ID
 * @param {string} params.action - Action performed (e.g., 'role_created', 'permission_changed')
 * @param {string} [params.entityType] - Entity type (e.g., 'role', 'permission', 'approval_request')
 * @param {string} [params.entityId] - Entity ID
 * @param {Object} [params.details] - Additional details
 * @param {string} [params.ipAddress] - Client IP
 * @param {string} [params.userAgent] - Client user agent
 */
export async function logRbacEvent({
  userId,
  action,
  entityType = null,
  entityId = null,
  details = {},
  ipAddress = null,
  userAgent = null,
}) {
  try {
    const organizationId = getOrganizationContext();
    if (!organizationId) throw new Error('Organization context is required to write RBAC audit events');
    await query(
      `INSERT INTO public.rbac_audit_logs
         (organization_id, user_id, action, entity_type, entity_id, details, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [organizationId, userId, action, entityType, entityId, JSON.stringify(details), ipAddress, userAgent]
    );
  } catch (err) {
    // Also write to general audit_logs as fallback
    console.error('[RBAC Audit] Failed to log:', err.message);
    try {
      await query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, String(action).slice(0, 100), entityType, entityId, JSON.stringify(details)]
      );
    } catch (_) {
      // Silent fallback failure
    }
  }
}

/**
 * Extract request metadata for RBAC audit logging
 */
export function extractRbacMetadata(request) {
  return {
    ipAddress: request?.headers?.get('x-forwarded-for') || request?.headers?.get('x-real-ip') || null,
    userAgent: request?.headers?.get('user-agent') || null,
  };
}
