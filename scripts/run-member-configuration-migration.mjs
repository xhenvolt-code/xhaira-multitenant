#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config as loadEnv } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(root, '.env.local') });
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL before running the migration.');
const isDown = process.argv.includes('--down');
const filename = isDown ? '957_tenant_member_configuration.down.sql' : '957_tenant_member_configuration.sql';
const sql = fs.readFileSync(path.join(root, 'migrations', filename), 'utf8');
const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(sql);
  console.log(`${filename} completed successfully.`);
} finally {
  await pool.end();
}
