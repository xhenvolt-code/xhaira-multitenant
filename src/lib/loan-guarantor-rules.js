export const EXTERNAL_GUARANTOR_FIELDS = {
  full_name: 'Full name',
  phone: 'Telephone',
  national_id: 'National ID',
  physical_address: 'Physical address',
  occupation: 'Occupation',
  relationship: 'Relationship to applicant',
};

export const EXTERNAL_GUARANTOR_FIELD_MAX_LENGTH = {
  full_name: 255,
  phone: 50,
  national_id: 100,
  physical_address: 1000,
  occupation: 255,
  relationship: 100,
};

export const DEFAULT_EXTERNAL_GUARANTOR_FIELDS = Object.keys(EXTERNAL_GUARANTOR_FIELDS);

function readCount(value, fallback, fieldName) {
  if (value === undefined || value === null) return fallback;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 10) {
    throw new TypeError(`${fieldName} must be a whole number between 0 and 10`);
  }
  return count;
}

export function resolveGuarantorRequirements(ruleValue) {
  const value = ruleValue && typeof ruleValue === 'object' && !Array.isArray(ruleValue)
    ? ruleValue
    : {};
  const memberCount = readCount(value.member_count ?? value.count, 2, 'Required member guarantors');
  const externalCount = readCount(value.external_count, 1, 'Required outside guarantors');
  const memberScope = value.member_scope ?? 'SAME_GROUP';
  if (!['SAME_GROUP', 'ANY_ORGANIZATION_MEMBER'].includes(memberScope)) {
    throw new TypeError('Member guarantor scope must be SAME_GROUP or ANY_ORGANIZATION_MEMBER');
  }
  const configuredFields = value.external_required_fields ?? DEFAULT_EXTERNAL_GUARANTOR_FIELDS;

  if (!Array.isArray(configuredFields) ||
      configuredFields.some((field) => typeof field !== 'string' || !Object.hasOwn(EXTERNAL_GUARANTOR_FIELDS, field))) {
    throw new TypeError('External guarantor fields contain an unsupported field');
  }

  return {
    member_count: memberCount,
    external_count: externalCount,
    member_scope: memberScope,
    external_required_fields: [...new Set(configuredFields)],
  };
}

export function validateExternalGuarantor(guarantor, requiredFields) {
  if (!guarantor || typeof guarantor !== 'object' || Array.isArray(guarantor)) {
    return 'Each outside guarantor must be an object';
  }

  for (const field of requiredFields) {
    const value = guarantor[field];
    if (typeof value !== 'string' || !value.trim()) {
      return `${EXTERNAL_GUARANTOR_FIELDS[field]} is required for each outside guarantor`;
    }
    if (value.trim().length > EXTERNAL_GUARANTOR_FIELD_MAX_LENGTH[field]) {
      return `${EXTERNAL_GUARANTOR_FIELDS[field]} must be ${EXTERNAL_GUARANTOR_FIELD_MAX_LENGTH[field]} characters or fewer`;
    }
  }

  const guaranteedAmount = Number(guarantor.guaranteed_amount);
  if (!Number.isFinite(guaranteedAmount) || guaranteedAmount <= 0) {
    return 'Each outside guarantor must have a positive guaranteed amount';
  }

  return null;
}
