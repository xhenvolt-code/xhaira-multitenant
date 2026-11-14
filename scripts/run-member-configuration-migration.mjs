#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config as loadEnv } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(root, '.env.local') });
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL before running the migration.');
const isDown = process.argv.includes('--down');
const isDefaults = process.argv.includes('--defaults');
const isConfiguredAccountTypes = process.argv.includes('--account-types');
const migration = isConfiguredAccountTypes
  ? '959_configured_member_account_types'
  : isDefaults ? '958_database_member_configuration_defaults' : '957_tenant_member_configuration';
const filename = `${migration}${isDown ? '.down' : ''}.sql`;
const sql = fs.readFileSync(path.join(root, 'migrations', filename), 'utf8');
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  // Application URLs may set role=xhaira_runtime in their PostgreSQL startup
  // options. Schema migrations require the login role's DDL privileges.
  await client.query('BEGIN');
  await client.query('RESET ROLE');
  const { rows: [privileges] } = await client.query(`
    SELECT current_user,
           has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public
  `);
  if (!privileges.can_use_public || !privileges.can_create_public) {
    throw new Error(
      `Database login role "${privileges.current_user}" lacks required USAGE/CREATE privileges on schema public. ` +
      'Set MIGRATION_DATABASE_URL to a database-owner connection and retry.'
    );
  }
  await client.query(sql);
  console.log(`${filename} completed successfully.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  if (error.code === '42501') {
    throw new Error(
      'The migration database role lacks required schema/table privileges. ' +
      'Use MIGRATION_DATABASE_URL for a database-owner connection.',
      { cause: error }
    );
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
