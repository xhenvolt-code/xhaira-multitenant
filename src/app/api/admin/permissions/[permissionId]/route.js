import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/permissions.js';

const catalogIsShared = () => NextResponse.json(
  { success: false, error: 'The permission catalog is shared across organizations and is managed by application migrations.' },
  { status: 403 }
);

export async function PUT(request) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  return catalogIsShared();
}

export async function DELETE(request) {
  const permission = await requirePermission(request, 'roles.manage');
  if (permission instanceof NextResponse) return permission;
  return catalogIsShared();
}
