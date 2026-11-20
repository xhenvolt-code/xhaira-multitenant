import { runWithOrganizationContext } from '@/lib/organization-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function withOrganizationRbac(auth, callback) {
  if (!auth?.organizationId || !UUID_PATTERN.test(auth.organizationId)) {
    throw new TypeError('An authenticated organization is required for RBAC access');
  }
  return runWithOrganizationContext(auth.organizationId, callback);
}

export function normalizePermissionIds(permissionIds) {
  if (!Array.isArray(permissionIds) || permissionIds.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    throw new TypeError('permission_ids must be an array of permission UUIDs');
  }
  return [...new Set(permissionIds)];
}

export async function replaceRolePermissions(client, roleId, organizationId, permissionIds) {
  const ids = normalizePermissionIds(permissionIds);
  if (ids.length > 0) {
    const available = await client.query(
      'SELECT id FROM public.permissions WHERE id = ANY($1::uuid[])',
      [ids]
    );
    if (available.rows.length !== ids.length) {
      throw new TypeError('One or more selected permissions do not exist');
    }
  }

  await client.query(
    'DELETE FROM public.role_permissions WHERE role_id = $1 AND organization_id = $2',
    [roleId, organizationId]
  );
  if (ids.length > 0) {
    await client.query(
      `INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
       SELECT $1, p.id, $2
         FROM public.permissions p
        WHERE p.id = ANY($3::uuid[])
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, organizationId, ids]
    );
  }
  return ids.length;
}
