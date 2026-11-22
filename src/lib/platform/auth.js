import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { queryPlatform, getPlatformPool } from '@/lib/db.js';

const scrypt = promisify(scryptCallback);
export const PLATFORM_COOKIE = 'xhaira_platform_session';
const SESSION_HOURS = 8;

export function hashPlatformToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPlatformPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(key).toString('hex')}`;
}

export async function verifyPlatformPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !/^[a-f\d]{128}$/i.test(hash || '')) return false;
  const key = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function getClientIp(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || null;
}

export async function hasPlatformAdmins() {
  const result = await queryPlatform('SELECT 1 FROM public.platform_admins LIMIT 1');
  return result.rows.length > 0;
}

export async function getPlatformSession(token) {
  if (!token || !/^[a-f\d]{96}$/i.test(token)) return null;
  const tokenHash = hashPlatformToken(token);
  const result = await queryPlatform(
    `SELECT a.id, a.name, a.email, a.role, a.status, s.id AS session_id, s.expires_at
       FROM public.platform_admin_sessions s
       JOIN public.platform_admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        AND s.expires_at > NOW() AND a.status = 'active'
      LIMIT 1`, [tokenHash]
  );
  const user = result.rows[0];
  if (!user) return null;
  await queryPlatform('UPDATE public.platform_admin_sessions SET last_activity_at = NOW() WHERE id = $1', [user.session_id]);
  return { id: user.id, name: user.name, email: user.email, role: user.role, sessionId: user.session_id, expiresAt: user.expires_at };
}

export async function createPlatformSession(adminId, token, request) {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  await queryPlatform(
    `INSERT INTO public.platform_admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminId, hashPlatformToken(token), getClientIp(request), request.headers.get('user-agent')?.slice(0, 500) || null, expiresAt]
  );
  await queryPlatform('UPDATE public.platform_admins SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [adminId]);
}

export async function revokePlatformSession(token) {
  if (!token || !/^[a-f\d]{96}$/i.test(token)) return;
  await queryPlatform(
    'UPDATE public.platform_admin_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashPlatformToken(token)]
  );
}

export async function platformAudit(adminId, action, entityType, entityId, details, request) {
  await queryPlatform(
    `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [adminId || null, action, entityType, entityId ? String(entityId) : null,
      JSON.stringify(details || {}), request ? getClientIp(request) : null]
  );
}

export async function bootstrapPlatformAdmin({ name, email, password }, request) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 160 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return { ok: false, error: 'Enter a valid name and email address' };
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    return { ok: false, error: 'Password must be between 12 and 200 characters' };
  }
  const passwordHash = await hashPlatformPassword(password);
  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('xhaira-platform-bootstrap', 0))");
    const existing = await client.query('SELECT 1 FROM public.platform_admins LIMIT 1');
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Platform setup has already been completed' };
    }
    const inserted = await client.query(
      `INSERT INTO public.platform_admins (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'super_admin') RETURNING id, name, email, role`,
      [cleanName, cleanEmail, passwordHash]
    );
    await client.query('COMMIT');
    await platformAudit(inserted.rows[0].id, 'platform_bootstrap', 'platform_admin', inserted.rows[0].id, { email: cleanEmail }, request);
    return { ok: true, user: inserted.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createPlatformAdmin({ name, email, password, role }, request, actor) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2 || cleanName.length > 160 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return { ok: false, error: 'Enter a valid name and email address' };
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    return { ok: false, error: 'Password must be between 12 and 200 characters' };
  }
  if (!['super_admin', 'analyst', 'viewer'].includes(role)) return { ok: false, error: 'Select a valid platform role' };
  const passwordHash = await hashPlatformPassword(password);
  try {
    const inserted = await queryPlatform(
      `INSERT INTO public.platform_admins (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, status`,
      [cleanName, cleanEmail, passwordHash, role]
    );
    await platformAudit(actor.id, 'platform_admin_created', 'platform_admin', inserted.rows[0].id, { email: cleanEmail, role }, request);
    return { ok: true, user: inserted.rows[0] };
  } catch (error) {
    if (error.code === '23505') return { ok: false, error: 'A platform administrator with this email already exists' };
    throw error;
  }
}

export async function loginPlatformAdmin(email, password, request) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail.length > 254 || typeof password !== 'string' || password.length > 200) {
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }
  const ip = getClientIp(request);
  const recent = await queryPlatform(
    `SELECT COUNT(*)::int AS failures, MAX(attempted_at) AS last_attempt
       FROM public.platform_login_attempts
      WHERE succeeded = false
        AND attempted_at > GREATEST(
          NOW() - INTERVAL '15 minutes',
          COALESCE((SELECT MAX(attempted_at) FROM public.platform_login_attempts WHERE LOWER(email) = $1 AND succeeded = true), '-infinity'::timestamptz)
        )
        AND (LOWER(email) = $1 OR ($2::text IS NOT NULL AND ip_address = $2))`, [cleanEmail, ip]
  );
  const failures = Number(recent.rows[0]?.failures || 0);
  if (failures >= 5) {
    await platformAudit(null, 'platform_login_throttled', 'platform_session', null, { email: cleanEmail, failures }, request);
    return { ok: false, status: 429, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  const result = await queryPlatform(
    `SELECT id, name, email, password_hash, role, status
       FROM public.platform_admins WHERE LOWER(email) = $1 LIMIT 1`, [cleanEmail]
  );
  const account = result.rows[0];
  const matches = account
    ? await verifyPlatformPassword(String(password || ''), account.password_hash)
    : (() => null)();
  const constantTimeNoUserCheck = account ? null : await scrypt(String(password || ''), Buffer.alloc(16, 0x5a), 64);
  if (!account && constantTimeNoUserCheck) timingSafeEqual(Buffer.from(constantTimeNoUserCheck), Buffer.alloc(64));
  if (!account || !matches || account.status !== 'active') {
    await queryPlatform(
      'INSERT INTO public.platform_login_attempts (email, ip_address, succeeded) VALUES ($1, $2, false)',
      [cleanEmail || 'unknown', ip]
    );
    await platformAudit(null, 'platform_login_failed', 'platform_session', null, { email: cleanEmail }, request);
    return { ok: false, status: 401, error: 'Invalid email or password' };
  }

  await queryPlatform(
    'INSERT INTO public.platform_login_attempts (email, ip_address, succeeded) VALUES ($1, $2, true)',
    [cleanEmail, ip]
  );
  const token = randomBytes(48).toString('hex');
  await createPlatformSession(account.id, token, request);
  await platformAudit(account.id, 'platform_login', 'platform_session', null, {}, request);
  return { ok: true, token, user: { id: account.id, name: account.name, email: account.email, role: account.role } };
}
