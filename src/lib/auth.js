/**
 * Authentication Utilities
 * Password hashing, user lookup, and user creation
 */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { getPool, query, isDatabaseConnectionError } from './db.js';
import { getOrganizationContext } from './organization-context.js';

const SALT_ROUNDS = 10;

/**
 * Hash a password
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare password with hash
 * @param {string} password - Plain text password
 * @param {string} hash - Password hash
 * @returns {Promise<boolean>} True if password matches
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Find user by email
 * @param {string} email - User email
 * @returns {Promise<Object|null>} User object or null
 */
export async function findUserByEmail(email) {
  try {
    const result = await query('SELECT * FROM public.lookup_login_user($1)', [email]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error finding user by email:', error.message);
    // A failed DB connection is not the same as an email with no account.
    // Let the route return a service error instead of a misleading 401.
    if (isDatabaseConnectionError(error)) throw error;
    return null;
  }
}

/**
 * Find user by ID
 * @param {string} userId - User ID (UUID)
 * @returns {Promise<Object|null>} User object or null
 */
export async function findUserById(userId) {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
    return result.rows[0] || null;
  } catch (error) {
    console.error('Error finding user by ID:', error.message);
    if (isDatabaseConnectionError(error)) throw error;
    return null;
  }
}

/**
 * Create a new user
 * @param {Object} userData - User data
 * @param {string} userData.email - User email
 * @param {string} userData.passwordHash - Hashed password
 * @param {string} userData.name - Full name
 * @param {string} [userData.username] - Username (auto-derived from email if omitted)
 * @param {string} [userData.role] - User role (default: 'user')
 * @param {boolean} [userData.isActive] - Whether user is active
 * @param {string} [userData.status] - User status (active/pending)
 * @param {string|null} [userData.staffId] - Linked staff record ID
 * @param {boolean} [userData.mustResetPassword] - Force password change on first login
 * @returns {Promise<Object|null>} Created user or null on error
 */
export async function createUser({
  email,
  passwordHash,
  name,
  username,
  role = 'user',
  isActive = true,
  status = 'active',
  staffId = null,
  roleId = null,
  mustResetPassword = false,
}) {
  if (typeof email !== 'string' || typeof passwordHash !== 'string' || typeof name !== 'string') {
    throw new TypeError('Email, password hash, and name are required to create a user');
  }
  const cleanEmail = email.trim().toLowerCase();
  const resolvedUsername = typeof username === 'string' && username.trim()
    ? username.trim().toLowerCase()
    : `${cleanEmail.split('@')[0].replace(/[^a-z0-9_]/g, '_').slice(0, 80)}_${randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9_]{3,100}$/.test(resolvedUsername)) {
    throw new TypeError('Username must be 3 to 100 characters and contain only letters, numbers, or underscores');
  }
  if (!['user', 'admin', 'superadmin', 'viewer'].includes(role)) {
    throw new TypeError('User role must be a supported base role');
  }
  try {
    const organizationId = getOrganizationContext();
    if (!organizationId) throw new Error('Organization context is required to create a user');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      let authorityLevel = 10;
      if (roleId) {
        const selectedRole = await client.query(
          `SELECT name, authority_level
             FROM public.roles
            WHERE id = $1 AND organization_id = $2 AND is_active = true
            FOR SHARE`,
          [roleId, organizationId]
        );
        if (!selectedRole.rows[0]) {
          throw new TypeError('Selected role is not active in this organization');
        }
        authorityLevel = selectedRole.rows[0].authority_level ?? authorityLevel;
      }

      const result = await client.query(
        `INSERT INTO public.users (
           email, password_hash, name, username, role, role_id, authority_level,
           is_active, status, staff_id, must_reset_password, first_login_completed,
           organization_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
         RETURNING id, email, name, username, role, role_id, authority_level,
                   is_active, status, organization_id, created_at`,
        [
          cleanEmail,
          passwordHash,
          name.trim(),
          resolvedUsername,
          role,
          roleId,
          authorityLevel,
          isActive,
          status,
          staffId,
          mustResetPassword,
          !mustResetPassword,
          organizationId,
        ]
      );
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) {
        console.error('Failed to roll back user creation:', rollbackError);
      }
      if (error.code === '23505') {
        if (error.constraint?.includes('username')) return { error: 'Username already taken' };
        if (error.constraint?.includes('email')) return { error: 'Email already exists' };
      }
      throw error;
    } finally {
      await client.release();
    }
  } catch (error) {
    console.error('Error creating user:', { code: error.code, constraint: error.constraint, message: error.message });
    throw error;
  }
}

/**
 * Count total users in the system
 * Used for superadmin bootstrap (first user = superadmin)
 * @returns {Promise<number>} User count
 */
export async function getUserCount() {
  try {
    const result = await query('SELECT COUNT(*)::int AS count FROM users');
    return result.rows[0]?.count || 0;
  } catch (error) {
    console.error('Error counting users:', error.message);
    return 0;
  }
}

/**
 * Update user's last login timestamp
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} True if successful
 */
export async function updateUserLastLogin(userId) {
  try {
    const result = await query(
      'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id',
      [userId]
    );
    return !!result.rows[0];
  } catch (error) {
    console.error('Error updating last login:', error.message);
    return false;
  }
}

/**
 * Verify user credentials (email and password)
 * @param {string} email - User email
 * @param {string} password - Plain text password
 * @returns {Promise<Object|null>} User object, error object, or null if invalid
 */
export async function verifyCredentials(email, password) {
  try {
    const user = await findUserByEmail(email);

    if (!user) {
      return null;
    }

    if (!user.is_active) {
      return { error: 'ACCOUNT_DISABLED', message: 'Your account has been disabled. Contact an administrator.' };
    }

    // Check status-based activation
    if (user.status === 'pending') {
      return { error: 'ACCOUNT_PENDING', message: 'Your account is pending activation. Please wait for admin approval.' };
    }

    if (user.status === 'suspended') {
      return { error: 'ACCOUNT_SUSPENDED', message: 'Your account has been suspended. Contact an administrator.' };
    }

    const organizationStatus = await query(
      'SELECT public.organization_status_for_user($1) AS status',
      [user.id]
    );
    if (organizationStatus.rows[0]?.status !== 'active') {
      return { error: 'ORGANIZATION_SUSPENDED', message: 'This institution is not currently active. Contact Xhenvolt support.' };
    }

    const isPasswordValid = await comparePassword(password, user.password_hash);

    if (!isPasswordValid) {
      return null;
    }

    // Return user without password hash
    const { password_hash, ...userWithoutPassword } = user;
    return userWithoutPassword;
  } catch (error) {
    console.error('Error verifying credentials:', error.message);
    if (isDatabaseConnectionError(error)) throw error;
    return null;
  }
}

export default {
  hashPassword,
  comparePassword,
  findUserByEmail,
  findUserById,
  createUser,
  getUserCount,
  updateUserLastLogin,
  verifyCredentials,
};
