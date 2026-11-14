import { query } from '@/lib/db.js';
import { getOrganizationContext, runWithOrganizationContext } from '@/lib/organization-context.js';
export { validateMemberFields, getMissingRequiredMemberFields } from '@/lib/member-field-validation.js';

export async function getMemberFields(organizationId = getOrganizationContext()) {
  return runWithOrganizationContext(organizationId, async () => {
    const result = await query(
      `SELECT field_name, label, field_type, is_active, is_required, sort_order, options, validation_rules
         FROM member_field_configs ORDER BY section, sort_order, label`
    );
    return result.rows;
  });
}
