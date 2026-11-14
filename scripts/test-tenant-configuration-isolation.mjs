import assert from 'node:assert/strict';
import pg from 'pg';

const connectionString = process.env.XHAIRA_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('Set XHAIRA_TEST_DATABASE_URL to an isolated database with migrations 956 and 957 applied. This test is read-only.');
}

const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  const organizations = await client.query('SELECT id FROM public.organizations ORDER BY created_at, id LIMIT 2');
  assert.equal(organizations.rows.length, 2, 'tenant isolation test requires two organizations');
  const [orgA, orgB] = organizations.rows.map((row) => row.id);
  await client.query('SET ROLE xhaira_runtime');

  await client.query("SELECT set_config('app.organization_id', $1, false)", [orgA]);
  const configA = await client.query('SELECT id, organization_id FROM public.member_field_configs ORDER BY id LIMIT 1');
  assert.ok(configA.rows.length, 'tenant A should have seeded member field definitions');
  assert.ok(configA.rows.every((row) => row.organization_id === orgA));
  const auditA = await client.query('SELECT id FROM public.member_configuration_audit ORDER BY id LIMIT 1');
  const docsA = await client.query('SELECT id FROM public.member_documents ORDER BY id LIMIT 1');

  await client.query("SELECT set_config('app.organization_id', $1, false)", [orgB]);
  const configB = await client.query('SELECT organization_id FROM public.member_field_configs');
  assert.ok(configB.rows.every((row) => row.organization_id === orgB));
  assert.equal((await client.query('SELECT id FROM public.member_field_configs WHERE id = $1', [configA.rows[0].id])).rowCount, 0,
    'tenant B must not see tenant A field configuration');
  if (auditA.rows[0]) assert.equal((await client.query('SELECT id FROM public.member_configuration_audit WHERE id = $1', [auditA.rows[0].id])).rowCount, 0);
  if (docsA.rows[0]) assert.equal((await client.query('SELECT id FROM public.member_documents WHERE id = $1', [docsA.rows[0].id])).rowCount, 0);
  assert.ok((await client.query('SELECT organization_id FROM public.member_document_type_configs')).rows.every((row) => row.organization_id === orgB));
  assert.ok((await client.query('SELECT organization_id FROM public.member_groups')).rows.every((row) => row.organization_id === orgB));
  console.log('Tenant configuration isolation checks passed.');
} finally {
  try { await client.query("SELECT set_config('app.organization_id', '', false)"); await client.query('RESET ROLE'); } catch {}
  client.release();
  await pool.end();
}
