import test from 'node:test';
import assert from 'node:assert/strict';
import { getMissingRequiredMemberFields, validateMemberFields } from '../src/lib/member-field-validation.js';

const fields = [
  { field_name: 'first_name', label: 'First name', field_type: 'text', is_active: true, is_required: true },
  { field_name: 'email', label: 'Email', field_type: 'email', is_active: true, is_required: false },
  { field_name: 'parish_name', label: 'Parish', field_type: 'text', is_active: true, is_required: true, validation_rules: { minLength: 2 } },
  { field_name: 'legacy_code', label: 'Legacy code', field_type: 'text', is_active: false, is_required: false },
];

test('required fields and custom fields are validated from organization definitions', () => {
  assert.deepEqual(validateMemberFields(fields, { full_name: 'Mariam N' }), { error: 'Parish is required' });
  const result = validateMemberFields(fields, { full_name: 'Mariam N', parish_name: 'Kira' });
  assert.equal(result.customFields.parish_name, 'Kira');
});

test('disabled and unknown fields cannot be submitted', () => {
  assert.match(validateMemberFields(fields, { full_name: 'Mariam N', parish_name: 'Kira', legacy_code: 'x' }).error, /disabled/i);
  assert.match(validateMemberFields(fields, { full_name: 'Mariam N', parish_name: 'Kira', unexpected: 'x' }).error, /unknown/i);
});

test('partial profile edits do not retroactively require missing fields', () => {
  assert.equal(validateMemberFields(fields, { parish_name: 'Kira' }, { enforceRequired: false }).customFields.parish_name, 'Kira');
});

test('existing incomplete profiles are flagged instead of rejected', () => {
  const missing = getMissingRequiredMemberFields(fields, { full_name: 'Mariam N', custom_fields: {} });
  assert.deepEqual(missing, ['Parish']);
});

test('configured type and range checks are applied server-side', () => {
  const configured = [{ field_name: 'amount', label: 'Amount', field_type: 'number', is_active: true, is_required: true, validation_rules: { min: 10, max: 50 } }];
  assert.match(validateMemberFields(configured, { amount: 9 }).error, /minimum/i);
  assert.equal(validateMemberFields(configured, { amount: 20 }).customFields.amount, 20);
});
