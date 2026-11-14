/**
 * POST /api/auth/register
 *
 * Public registration with system-state aware logic:
 *
 * FIRST USER (system not initialized):
 *   - Automatically becomes SUPER_ADMIN
 *   - Initializes base role system
 *   - Status: active (immediate access)
 *
 * SUBSEQUENT USERS (system initialized):
 *   - Public registration blocked
 *   - Returns 410 Gone / "System registration closed"
 *   - Users must be created by admin via /api/admin/users
 */

import { NextResponse } from 'next/server.js';
import { randomUUID } from 'crypto';
import { validateOrganizationRegister } from '@/lib/validation.js';
import {
  findUserByEmail,
  hashPassword,
  getUserCount,
} from '@/lib/auth.js';
import { logAuthEvent, extractRequestMetadata } from '@/lib/audit.js';
import { createSession, getSecureCookieOptions } from '@/lib/session.js';
import { query, isDatabaseConnectionError } from '@/lib/db.js';
import { enterOrganizationContext } from '@/lib/organization-context.js';

/**
 * Parse user-agent string into { deviceName, browser, os }
 * Mirrors the parser in the login route.
 */
function parseUserAgent(ua = '') {
  let browser = 'Unknown';
  if (/Edg\//.test(ua))               browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua))    browser = 'Opera';
  else if (/Firefox\//.test(ua))      browser = 'Firefox';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Browser';
  else if (/Chrome\//.test(ua))       browser = 'Chrome';
  else if (/Safari\//.test(ua))       browser = 'Safari';
  else if (/MSIE|Trident/.test(ua))   browser = 'Internet Explorer';

  let os = 'Unknown';
  if (/Windows NT 10/.test(ua))       os = 'Windows 10';
  else if (/Windows NT 11/.test(ua))  os = 'Windows 11';
  else if (/Windows NT/.test(ua))     os = 'Windows';
  else if (/Android/.test(ua)) {
    const m = ua.match(/Android ([\d.]+)/);
    os = m ? `Android ${m[1]}` : 'Android';
  } else if (/iPhone|iPad/.test(ua)) {
    const m = ua.match(/OS ([\d_]+)/);
    os = m ? `iOS ${m[1].replace(/_/g, '.')}` : 'iOS';
  } else if (/Macintosh/.test(ua))    os = 'macOS';
  else if (/Linux/.test(ua))          os = 'Linux';
  else if (/CrOS/.test(ua))           os = 'Chrome OS';

  let deviceName = 'Desktop';
  if (/Mobile|Android|iPhone/.test(ua)) deviceName = 'Mobile';
  else if (/Tablet|iPad/.test(ua))      deviceName = 'Tablet';

  return { deviceName, browser, os };
}

export async function POST(request) {
  try {
    const body = await request.json();

    // Validate input
    const validation = validateOrganizationRegister(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          fields: validation.errors,
        },
        { status: 400 }
      );
    }

    const { organizationName, email, password, name } = validation.data;
    const requestMetadata = extractRequestMetadata(request);

    // Check if email already exists
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      await logAuthEvent({
        action: 'REGISTER_DUPLICATE',
        email,
        reason: 'Email already exists',
        requestMetadata,
      });

      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    const organizationSlug = `${organizationName.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 180) || 'organization'}-${randomUUID().slice(0, 8)}`;
    const userResult = await query(
      'SELECT public.create_organization_owner($1, $2, $3, $4, $5, $6) AS user',
      [organizationName, organizationSlug, email, passwordHash, name, `${email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)}_${randomUUID().slice(0, 8)}`]
    );
    const user = userResult.rows[0]?.user;

    if (!user || !user.id) {
      return NextResponse.json(
        {
          error: 'Failed to create user',
          message: 'An error occurred during account creation.',
        },
        { status: 500 }
      );
    }

    enterOrganizationContext(user.organizationId);

    await logAuthEvent({
      action: 'REGISTER_SUCCESS_FIRST_USER',
      email,
      user_id: user.id,
      role: 'superadmin',
      requestMetadata,
    });

    // Collect device metadata (same approach as login route)
    const rawUA = request.headers.get('user-agent') || '';
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null;
    const { deviceName, browser, os } = parseUserAgent(rawUA);
    const deviceInfo = {
      ipAddress,
      userAgent: rawUA || null,
      deviceName,
      browser,
      os,
    };

    // Create session for newly registered user
    // createSession(userId: string, deviceInfo: object) — must pass userId as string
    const sessionId = await createSession(user.id, deviceInfo, user.organizationId);

    const response = NextResponse.json(
      {
        success: true,
        message: 'Registration successful. Welcome to Xhaira!',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organizationId,
          organizationName: user.organizationName,
          isFirstUser: true,
        },
      },
      { status: 201 }
    );

    // Set session cookie
    const cookieOptions = getSecureCookieOptions();
    response.cookies.set('xhaira_session', sessionId, cookieOptions);

    return response;
  } catch (error) {
    console.error('Registration error:', error?.message || error);
    if (isDatabaseConnectionError(error)) {
      return NextResponse.json(
        {
          error: 'Registration service is temporarily unavailable. Check the database connection configuration.',
          code: 'DATABASE_UNAVAILABLE',
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error: 'Registration failed',
        message: 'An unexpected error occurred. Please try again.',
      },
      { status: 500 }
    );
  }
}
