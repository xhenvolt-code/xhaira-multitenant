import { NextResponse } from 'next/server';
import { queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') || '50', 10) || 50));
  const offset = (page - 1) * limit;
  try {
    const result = await queryPlatform(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.ip_address, a.created_at,
              u.name AS administrator_name, u.email AS administrator_email
         FROM public.platform_audit_logs a
         LEFT JOIN public.platform_admins u ON u.id = a.admin_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $1 OFFSET $2`, [limit, offset]
    );
    return NextResponse.json({ success: true, data: result.rows, page, limit });
  } catch (error) {
    console.error('[Platform audit] Read failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load platform audit trail' }, { status: 500 });
  }
}
