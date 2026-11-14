const CORE_FIELDS = new Set([
  'first_name', 'last_name', 'other_name', 'email', 'phone', 'national_id', 'id_type',
  'gender', 'date_of_birth', 'address', 'photo_url', 'id_photo_url', 'occupation',
  'employer', 'monthly_income', 'emergency_contact_name', 'emergency_contact_phone',
  'next_of_kin_name', 'next_of_kin_phone', 'next_of_kin_relationship', 'notes',
]);

export function validateMemberFields(fields, body, { enforceRequired = true } = {}) {
  const custom = body.custom_fields && typeof body.custom_fields === 'object' && !Array.isArray(body.custom_fields) ? { ...body.custom_fields } : {};
  for (const field of fields) {
    if (!field.is_active) continue;
    if (field.field_type === 'file') return { error: `Configure ${field.label} in secure member document settings` };
    let value = CORE_FIELDS.has(field.field_name) ? body[field.field_name] : custom[field.field_name] ?? body[field.field_name];
    if ((field.field_name === 'first_name' || field.field_name === 'last_name') && !value && body.full_name) {
      const parts = body.full_name.trim().split(/\s+/);
      value = field.field_name === 'first_name' ? parts[0] : parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    const supplied = Object.hasOwn(body, field.field_name) || Object.hasOwn(custom, field.field_name);
    if (field.is_required && (enforceRequired || supplied) && (value === undefined || value === null || String(value).trim() === '')) return { error: `${field.label} is required` };
    if (value === undefined || value === null || value === '') continue;
    const rules = field.validation_rules || {};
    const stringValue = String(value);
    if (Number.isFinite(rules.minLength) && stringValue.length < rules.minLength) return { error: `${field.label} is too short` };
    if (Number.isFinite(rules.maxLength) && stringValue.length > rules.maxLength) return { error: `${field.label} is too long` };
    if (Number.isFinite(rules.min) && Number(value) < rules.min) return { error: `${field.label} is below the allowed minimum` };
    if (Number.isFinite(rules.max) && Number(value) > rules.max) return { error: `${field.label} exceeds the allowed maximum` };
    if (field.field_type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue)) return { error: `${field.label} must be a valid email address` };
    if (field.field_type === 'number' && !Number.isFinite(Number(value))) return { error: `${field.label} must be a number` };
    if (field.field_type === 'phone' && !/^\+?[0-9 ()-]{7,20}$/.test(stringValue)) return { error: `${field.label} must be a valid phone number` };
    if (field.field_type === 'date' && (Number.isNaN(Date.parse(stringValue)) || !/^\d{4}-\d{2}-\d{2}$/.test(stringValue))) return { error: `${field.label} must be a valid date` };
    if (field.field_type === 'select') {
      let options = field.options;
      if (typeof options === 'string') { try { options = JSON.parse(options); } catch { options = []; } }
      const values = Array.isArray(options) ? options.map((option) => typeof option === 'object' ? option.value : option) : [];
      if (!values.includes(value)) return { error: `${field.label} has an invalid selection` };
    }
    if (rules.pattern) {
      if (typeof rules.pattern !== 'string' || rules.pattern.length > 128 || /\(\?/.test(rules.pattern) || /\\[1-9]/.test(rules.pattern) || /\([^)]*[+*][^)]*\)[+*{]/.test(rules.pattern)) {
        return { error: `Validation pattern for ${field.label} is not supported` };
      }
      try { if (!new RegExp(rules.pattern).test(stringValue)) return { error: `${field.label} has an invalid format` }; }
      catch { return { error: `Validation pattern for ${field.label} is invalid` }; }
    }
    if (!CORE_FIELDS.has(field.field_name)) custom[field.field_name] = value;
  }
  const activeCustom = new Set(fields.filter((field) => field.is_active && !CORE_FIELDS.has(field.field_name)).map((field) => field.field_name));
  for (const key of Object.keys(custom)) if (!activeCustom.has(key)) return { error: `Unknown or disabled member field: ${key}` };
  const standardKeys = new Set(['full_name', 'custom_fields', 'group_id', 'member_kind', 'user_id', 'joined_date']);
  const knownKeys = new Set([...CORE_FIELDS, ...standardKeys, ...fields.map((field) => field.field_name)]);
  for (const key of Object.keys(body)) {
    if (key !== 'custom_fields' && !knownKeys.has(key)) return { error: `Unknown member field: ${key}` };
    const definition = fields.find((field) => field.field_name === key);
    if (definition && !definition.is_active && body[key] !== undefined && body[key] !== null && body[key] !== '') return { error: `Member field is disabled: ${key}` };
  }
  return { customFields: custom };
}

export function getMissingRequiredMemberFields(fields, member) {
  const missing = [];
  for (const field of fields) {
    if (!field.is_active || !field.is_required) continue;
    let value = member[field.field_name];
    if ((field.field_name === 'first_name' || field.field_name === 'last_name') && !value && member.full_name) {
      const parts = member.full_name.trim().split(/\s+/);
      value = field.field_name === 'first_name' ? parts[0] : parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    if (!CORE_FIELDS.has(field.field_name)) value = member.custom_fields?.[field.field_name] ?? value;
    if (value === undefined || value === null || String(value).trim() === '') missing.push(field.label);
  }
  return missing;
}
