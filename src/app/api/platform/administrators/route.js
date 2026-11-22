import { NextResponse } from 'next/server';
import { getPlatformPool, queryPlatform } from '@/lib/db.js';
import { createPlatformAdmin, platformAudit } from '@/lib/platform/auth.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';

export async function GET(request) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  try {
    const result = await queryPlatform(
      `SELECT id, name, email, role, status, last_login_at, created_at
         FROM public.platform_admins ORDER BY created_at ASC`
    );
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Platform administrators] List failed:', error);
    return NextResponse.json({ success: false, error: 'Could not list platform administrators' }, { status: 500 });
  }
}

export async function POST(request) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ success: false, error: 'Administrator details are required' }, { status: 400 });
  try {
    const result = await createPlatformAdmin(body, request, auth.user);
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    return NextResponse.json({ success: true, data: result.user }, { status: 201 });
  } catch (error) {
    console.error('[Platform administrators] Create failed:', error);
    return NextResponse.json({ success: false, error: 'Could not create platform administrator' }, { status: 500 });
  }
}

export async function PATCH(request) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  const targetId = body?.id;
  const targetStatus = body?.status;
  if (!targetId || !['active', 'suspended', 'disabled'].includes(targetStatus)) return NextResponse.json({ success: false, error: 'Administrator and valid status are required' }, { status: 400 });
  if (String(targetId) === String(auth.user.id) && targetStatus !== 'active') return NextResponse.json({ success: false, error: 'You cannot suspend or disable your own platform account' }, { status: 400 });
  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('xhaira-platform-admin-status', 0))");
    const target = await client.query('SELECT id, name, email, role, status FROM public.platform_admins WHERE id = $1 FOR UPDATE', [targetId]);
    if (!target.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ success: false, error: 'Platform administrator not found' }, { status: 404 });
    }
    if (target.rows[0].role === 'super_admin' && targetStatus !== 'active') {
      const activeAdmins = await client.query("SELECT COUNT(*)::int AS total FROM public.platform_admins WHERE role = 'super_admin' AND status = 'active'");
      if (Number(activeAdmins.rows[0]?.total || 0) <= 1) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'At least one active platform super admin must remain' }, { status: 409 });
      }
    }
    await client.query('UPDATE public.platform_admins SET status = $2, updated_at = NOW() WHERE id = $1', [targetId, targetStatus]);
    if (targetStatus !== 'active') await client.query('UPDATE public.platform_admin_sessions SET revoked_at = NOW() WHERE admin_id = $1 AND revoked_at IS NULL', [targetId]);
    await client.query(
      `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, 'platform_admin_status_changed', 'platform_admin', $2, $3::jsonb, $4)`,
      [auth.user.id, String(targetId), JSON.stringify({ email: target.rows[0].email, old_status: target.rows[0].status, new_status: targetStatus }), request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null]
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Platform administrators] Status update failed:', error);
    return NextResponse.json({ success: false, error: 'Could not update platform administrator' }, { status: 500 });
  } finally { client.release(); }
}
