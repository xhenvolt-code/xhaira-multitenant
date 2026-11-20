/**
 * GET /api/admin/permissions - List all permissions grouped by module
 * POST /api/admin/permissions - Create a new permission
 */
import { NextResponse } from 'next/server';
import { getAllPermissionsGrouped } from '@/lib/permissions.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'roles.manage');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { flat, grouped } = await withOrganizationRbac(auth, getAllPermissionsGrouped);

    return NextResponse.json({ success: true, data: flat, grouped });
  } catch (error) {
    console.error('Failed to fetch permissions:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch permissions' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'roles.manage');
    if (perm instanceof NextResponse) return perm;
    return NextResponse.json(
      { success: false, error: 'The permission catalog is shared across organizations and is managed by application migrations.' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Failed to create permission:', error);
    return NextResponse.json({ success: false, error: 'Failed to create permission' }, { status: 500 });
  }
}
