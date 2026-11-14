import { query } from '@/lib/db.js';
export { validateMemberFields, getMissingRequiredMemberFields } from '@/lib/member-field-validation.js';

export async function ensureMemberConfigurationDefaults() {
  try {
    await query('SELECT public.seed_member_configuration_defaults(public.current_organization_id())');
  } catch (error) {
    if (error.code === '42883') {
      throw new Error('Database migration 957 is not applied. Run `npm run migrate:member-config` before using member and group registration.');
    }
    throw error;
  }
}

export async function getMemberFields() {
  await ensureMemberConfigurationDefaults();
  const result = await query(
    `SELECT field_name, label, field_type, is_active, is_required, sort_order, options, validation_rules
       FROM member_field_configs ORDER BY section, sort_order, label`
  );
  return result.rows;
}
