import { NextResponse } from 'next/server';
import { PLATFORM_COOKIE, getPlatformSession } from '@/lib/platform/auth.js';

export function isSameOriginRequest(request) {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const expected = new URL(request.url).origin;
  try {
    if (origin) return new URL(origin).origin === expected;
    if (referer) return new URL(referer).origin === expected;
  } catch { return false; }
  return false;
}

export async function requirePlatformAdmin(request, { write = false } = {}) {
  const token = request.cookies?.get(PLATFORM_COOKIE)?.value;
  const user = await getPlatformSession(token);
  if (!user) return { response: NextResponse.json({ success: false, error: 'Platform authentication required' }, { status: 401 }) };
  if (write && user.role !== 'super_admin') {
    return { response: NextResponse.json({ success: false, error: 'Platform super admin access required' }, { status: 403 }) };
  }
  if (write && !isSameOriginRequest(request)) {
    return { response: NextResponse.json({ success: false, error: 'Invalid request origin' }, { status: 403 }) };
  }
  return { user };
}
