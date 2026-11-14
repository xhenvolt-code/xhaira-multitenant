import { query } from '@/lib/db.js';
export { validateMemberFields, getMissingRequiredMemberFields } from '@/lib/member-field-validation.js';

export async function ensureMemberConfigurationDefaults() {
  await query('SELECT public.seed_member_configuration_defaults(public.current_organization_id())');
}

export async function getMemberFields() {
  await ensureMemberConfigurationDefaults();
  const result = await query(
    `SELECT field_name, label, field_type, is_active, is_required, sort_order, options, validation_rules
       FROM member_field_configs ORDER BY section, sort_order, label`
  );
  return result.rows;
}
