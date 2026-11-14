import { getPool, query } from '@/lib/db.js';
import { getOrganizationContext, runWithOrganizationContext } from '@/lib/organization-context.js';
export { validateMemberFields, getMissingRequiredMemberFields } from '@/lib/member-field-validation.js';

// Useful member profile fields enabled by default. Each tenant can disable or
// require them from Member Field Settings; these are defaults, not policy.
const COMMON_MEMBER_FIELDS = [
  { field_name: 'marital_status', label: 'Marital Status', section: 'personal', field_type: 'select', is_active: true, is_required: false, sort_order: 22, options: ['single', 'married', 'widowed', 'divorced'] },
  { field_name: 'village', label: 'Village / Zone', section: 'contact', field_type: 'text', is_active: true, is_required: false, sort_order: 23 },
  { field_name: 'parish', label: 'Parish / Ward', section: 'contact', field_type: 'text', is_active: true, is_required: false, sort_order: 24 },
  { field_name: 'subcounty', label: 'Subcounty / Division', section: 'contact', field_type: 'text', is_active: true, is_required: false, sort_order: 25 },
  { field_name: 'district', label: 'District / City', section: 'contact', field_type: 'text', is_active: true, is_required: false, sort_order: 26 },
  { field_name: 'country', label: 'Country', section: 'contact', field_type: 'text', is_active: true, is_required: false, sort_order: 27 },
];

export async function ensureMemberConfigurationDefaults(organizationId = getOrganizationContext()) {
  if (!organizationId) {
    throw new Error('An authenticated organization is required to load member configuration.');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
    await client.query('SELECT public.seed_member_configuration_defaults($1::uuid)', [organizationId]);
    await client.query(
      `INSERT INTO member_field_configs
        (organization_id, field_name, label, section, field_type, is_active, is_required, sort_order, options, validation_rules)
       SELECT $1::uuid, field_name, label, section, field_type, is_active, is_required, sort_order, options, '{}'::jsonb
         FROM jsonb_to_recordset($2::jsonb) AS f(
           field_name text, label text, section text, field_type text, is_active boolean,
           is_required boolean, sort_order integer, options jsonb
         )
       ON CONFLICT (organization_id, field_name) DO NOTHING`,
      [organizationId, JSON.stringify(COMMON_MEMBER_FIELDS)]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '42883') {
      throw new Error('Database migration 957 is not applied. Run `npm run migrate:member-config` before using member and group registration.');
    }
    if (error.message?.includes('Member defaults can only be seeded for the active organization')) {
      throw new Error('Member configuration could not be loaded for your organization. Please sign in again and retry.');
    }
    throw error;
  } finally {
    await client.release();
  }
}

export async function getMemberFields(organizationId = getOrganizationContext()) {
  await ensureMemberConfigurationDefaults(organizationId);
  return runWithOrganizationContext(organizationId, async () => {
    const result = await query(
      `SELECT field_name, label, field_type, is_active, is_required, sort_order, options, validation_rules
         FROM member_field_configs ORDER BY section, sort_order, label`
    );
    return result.rows;
  });
}
