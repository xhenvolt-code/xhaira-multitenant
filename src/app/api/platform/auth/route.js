import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  bootstrapPlatformAdmin, createPlatformSession, getPlatformSession,
  hasPlatformAdmins, loginPlatformAdmin, platformAudit, PLATFORM_COOKIE,
  revokePlatformSession,
} from '@/lib/platform/auth.js';
import { isSameOriginRequest } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: 8 * 60 * 60,
};

function matchesBootstrapSecret(supplied, expected) {
  if (!expected || typeof supplied !== 'string') return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function sessionFromRequest(request) {
  return getPlatformSession(request.cookies?.get(PLATFORM_COOKIE)?.value);
}

export async function GET(request) {
  try {
    const [hasAdmins, user] = await Promise.all([hasPlatformAdmins(), sessionFromRequest(request)]);
    return NextResponse.json({
      success: true,
      setup_required: !hasAdmins,
      setup_available: !hasAdmins && Boolean(process.env.XHAIRA_PLATFORM_BOOTSTRAP_SECRET),
      authenticated: Boolean(user),
      user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform auth] GET failed:', error);
    return NextResponse.json({ success: false, error: 'Platform authentication service is unavailable' }, { status: 503 });
  }
}

export async function POST(request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json({ success: false, error: 'Email and password are required' }, { status: 400 });
  }
  try {
    const result = await loginPlatformAdmin(body.email, body.password, request);
    if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    const response = NextResponse.json({ success: true, user: result.user });
    response.cookies.set(PLATFORM_COOKIE, result.token, cookieOptions);
    return response;
  } catch (error) {
    console.error('[Platform auth] Login failed:', error);
    return NextResponse.json({ success: false, error: 'Platform authentication service is unavailable' }, { status: 503 });
  }
}

export async function PUT(request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const bootstrapSecret = process.env.XHAIRA_PLATFORM_BOOTSTRAP_SECRET;
  if (!bootstrapSecret) return NextResponse.json({ success: false, error: 'Platform bootstrap is disabled. Configure XHAIRA_PLATFORM_BOOTSTRAP_SECRET first.' }, { status: 503 });
  if (!matchesBootstrapSecret(body?.bootstrap_secret, bootstrapSecret)) {
    return NextResponse.json({ success: false, error: 'Invalid bootstrap secret' }, { status: 403 });
  }
  if (body?.password !== body?.confirm_password) return NextResponse.json({ success: false, error: 'Passwords do not match' }, { status: 400 });
  try {
    const created = await bootstrapPlatformAdmin(body, request);
    if (!created.ok) return NextResponse.json({ success: false, error: created.error }, { status: 400 });
    const token = randomBytes(48).toString('hex');
    await createPlatformSession(created.user.id, token, request);
    await platformAudit(created.user.id, 'platform_bootstrap_session_created', 'platform_admin', created.user.id, {}, request);
    const response = NextResponse.json({ success: true, user: { id: created.user.id, name: created.user.name, email: created.user.email, role: created.user.role } }, { status: 201 });
    response.cookies.set(PLATFORM_COOKIE, token, cookieOptions);
    return response;
  } catch (error) {
    console.error('[Platform auth] Bootstrap failed:', error);
    return NextResponse.json({ success: false, error: 'Platform setup is unavailable' }, { status: 503 });
  }
}

export async function DELETE(request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 });
  const token = request.cookies?.get(PLATFORM_COOKIE)?.value;
  try {
    const user = await getPlatformSession(token);
    if (token) await revokePlatformSession(token);
    if (user) await platformAudit(user.id, 'platform_logout', 'platform_session', user.sessionId, {}, request);
    const response = NextResponse.json({ success: true });
    response.cookies.set(PLATFORM_COOKIE, '', { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    console.error('[Platform auth] Logout failed:', error);
    return NextResponse.json({ success: false, error: 'Could not end platform session' }, { status: 500 });
  }
}
