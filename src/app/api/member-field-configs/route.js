import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { ensureMemberConfigurationDefaults } from '@/lib/member-config.js';

function validValidationRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
  if (Object.keys(rules).some((key) => !['min', 'max', 'minLength', 'maxLength', 'pattern'].includes(key))) return false;
  for (const key of ['min', 'max', 'minLength', 'maxLength']) {
    if (rules[key] !== undefined && (!Number.isFinite(rules[key]) || rules[key] < 0)) return false;
  }
  if ((rules.min !== undefined && rules.max !== undefined && rules.min > rules.max) ||
      (rules.minLength !== undefined && rules.maxLength !== undefined && rules.minLength > rules.maxLength)) return false;
  if (rules.pattern !== undefined) {
    if (typeof rules.pattern !== 'string' || rules.pattern.length > 128 || /\(\?/.test(rules.pattern) || /\\[1-9]/.test(rules.pattern) || /\([^)]*[+*][^)]*\)[+*{]/.test(rules.pattern)) return false;
    try { new RegExp(rules.pattern); } catch { return false; }
  }
  return true;
}

function validOptions(options) {
  return Array.isArray(options) && options.length > 0 && options.every((option) =>
    typeof option === 'string' ? Boolean(option.trim()) && option.length <= 100 :
      option && typeof option === 'object' && typeof option.value === 'string' && option.value.trim() &&
      typeof option.label === 'string' && option.label.trim() && option.value.length <= 100 && option.label.length <= 200);
}

// GET /api/member-field-configs — List member form field configurations
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    await ensureMemberConfigurationDefaults();

    const result = await query(
      `SELECT * FROM member_field_configs ORDER BY section, sort_order, label`
    );
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// PUT /api/member-field-configs — Batch update field configs
export async function PUT(request) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;
    if (perm.auth?.role !== 'superadmin') {
      return NextResponse.json({ success: false, error: 'Only the organization administrator can change member fields' }, { status: 403 });
    }
    await ensureMemberConfigurationDefaults();

    const body = await request.json();
    const { updates } = body; // Array of { field_name, is_active, is_required }

    if (!Array.isArray(updates)) {
      return NextResponse.json({ success: false, error: 'updates array required' }, { status: 400 });
    }

    for (const u of updates) {
      if (!u.field_name || typeof u.field_name !== 'string') continue;
      const before = await query('SELECT * FROM member_field_configs WHERE field_name = $1', [u.field_name]);
      if (!before.rows[0]) {
        if (!/^[a-z][a-z0-9_]{1,99}$/.test(u.field_name) || typeof u.label !== 'string' || !u.label.trim()) {
          return NextResponse.json({ success: false, error: `Invalid custom field definition: ${u.field_name}` }, { status: 400 });
        }
        const fieldType = u.field_type || 'text';
        const section = u.section || 'other';
        if (!['text', 'email', 'phone', 'date', 'select', 'textarea', 'number'].includes(fieldType) ||
            (fieldType === 'select' && !validOptions(u.options)) || !validValidationRules(u.validation_rules || {}) ||
            !['personal', 'identification', 'contact', 'employment', 'kin', 'financial', 'other'].includes(section)) {
          return NextResponse.json({ success: false, error: 'Invalid member field type or section' }, { status: 400 });
        }
        const created = await query(
          `INSERT INTO member_field_configs
            (field_name, label, section, field_type, is_active, is_required, sort_order, options, validation_rules)
           VALUES ($1, $2, $3, $4, COALESCE($5, true), COALESCE($6, false), COALESCE($7, 100), $8::jsonb, $9::jsonb)
           RETURNING *`,
          [u.field_name, u.label.trim(), section, fieldType, typeof u.is_active === 'boolean' ? u.is_active : null,
            typeof u.is_required === 'boolean' ? u.is_required : null, Number.isInteger(u.sort_order) ? u.sort_order : null,
            JSON.stringify(u.options ?? null), JSON.stringify(u.validation_rules || {})]
        );
        await query(
          `INSERT INTO member_configuration_audit (setting_type, setting_key, old_value, new_value, changed_by)
           VALUES ('member_field', $1, NULL, $2::jsonb, $3)`,
          [u.field_name, JSON.stringify(created.rows[0]), perm.auth.userId]
        );
        continue;
      }
      const current = before.rows[0];
      const next = {
        is_active: typeof u.is_active === 'boolean' ? u.is_active : current.is_active,
        is_required: typeof u.is_required === 'boolean' ? u.is_required : current.is_required,
        label: typeof u.label === 'string' && u.label.trim() ? u.label.trim() : current.label,
        sort_order: Number.isInteger(u.sort_order) ? u.sort_order : current.sort_order,
        field_type: u.field_type || current.field_type,
        section: u.section || current.section,
        options: u.options === undefined ? current.options : u.options,
        validation_rules: u.validation_rules === undefined ? current.validation_rules : u.validation_rules,
      };
      if (!['text', 'email', 'phone', 'date', 'select', 'file', 'textarea', 'number'].includes(next.field_type) ||
          !['personal', 'identification', 'contact', 'employment', 'kin', 'financial', 'other'].includes(next.section) ||
          !validValidationRules(next.validation_rules) ||
          (next.field_type === 'select' && !validOptions(next.options)) || (next.is_active && next.field_type === 'file')) {
        return NextResponse.json({ success: false, error: `Invalid definition for ${u.field_name}` }, { status: 400 });
      }
      if (next.is_required && !next.is_active) {
        return NextResponse.json({ success: false, error: `Required field ${u.field_name} must be enabled` }, { status: 400 });
      }
      const after = await query(
        `UPDATE member_field_configs SET is_active = $2, is_required = $3, label = $4,
           sort_order = $5, field_type = $6, section = $7, options = $8::jsonb,
           validation_rules = $9::jsonb, updated_at = NOW()
          WHERE field_name = $1 RETURNING *`,
        [u.field_name, next.is_active, next.is_required, next.label, next.sort_order,
          next.field_type, next.section, JSON.stringify(next.options), JSON.stringify(next.validation_rules)]
      );
      if (JSON.stringify(current) !== JSON.stringify(after.rows[0])) {
        await query(
          `INSERT INTO member_configuration_audit (setting_type, setting_key, old_value, new_value, changed_by)
           VALUES ('member_field', $1, $2::jsonb, $3::jsonb, $4)`,
          [u.field_name, JSON.stringify(current), JSON.stringify(after.rows[0]), perm.auth.userId]
        );
      }
    }

    const result = await query(`SELECT * FROM member_field_configs ORDER BY section, sort_order`);
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
