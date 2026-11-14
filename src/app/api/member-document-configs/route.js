import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { ensureMemberConfigurationDefaults } from '@/lib/member-config.js';

const MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    await ensureMemberConfigurationDefaults(perm.auth.organizationId);
    const result = await query('SELECT * FROM member_document_type_configs ORDER BY sort_order, label');
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    if (perm.auth?.role !== 'superadmin') return NextResponse.json({ success: false, error: 'Only the organization administrator can change document settings' }, { status: 403 });
    await ensureMemberConfigurationDefaults(perm.auth.organizationId);
    const { updates } = await request.json();
    if (!Array.isArray(updates)) return NextResponse.json({ success: false, error: 'updates array required' }, { status: 400 });
    for (const update of updates) {
      if (!update.document_key) continue;
      const before = await query('SELECT * FROM member_document_type_configs WHERE document_key = $1', [update.document_key]);
      if (!before.rows[0]) {
        const key = String(update.document_key);
        if (!/^[a-z][a-z0-9_]{1,99}$/.test(key) || typeof update.label !== 'string' || !update.label.trim()) {
          return NextResponse.json({ success: false, error: `Invalid document type: ${key}` }, { status: 400 });
        }
        const accepted = update.accepted_mime_types ?? ['application/pdf', 'image/jpeg', 'image/png'];
        const maxSize = Number(update.max_size_bytes ?? 10485760);
        if (!Array.isArray(accepted) || accepted.length === 0 || accepted.some((type) => !MIME_TYPES.has(type)) ||
            !Number.isInteger(maxSize) || maxSize < 1 || maxSize > 10485760) {
          return NextResponse.json({ success: false, error: `Invalid file rules for ${key}` }, { status: 400 });
        }
        const created = await query(`INSERT INTO member_document_type_configs
          (document_key, label, is_enabled, is_required, accepted_mime_types, max_size_bytes, sort_order)
          VALUES ($1,$2,COALESCE($3,true),COALESCE($4,false),$5::jsonb,$6,COALESCE($7,100)) RETURNING *`,
          [key, update.label.trim(), typeof update.is_enabled === 'boolean' ? update.is_enabled : null,
            typeof update.is_required === 'boolean' ? update.is_required : null, JSON.stringify(accepted), maxSize,
            Number.isInteger(update.sort_order) ? update.sort_order : null]);
        await query(`INSERT INTO member_configuration_audit (setting_type, setting_key, old_value, new_value, changed_by)
          VALUES ('document_type', $1, NULL, $2::jsonb, $3)`, [key, JSON.stringify(created.rows[0]), perm.auth.userId]);
        continue;
      }
      const current = before.rows[0];
      const accepted = update.accepted_mime_types ?? current.accepted_mime_types;
      const maxSize = update.max_size_bytes ?? current.max_size_bytes;
      if (!Array.isArray(accepted) || accepted.some((type) => !MIME_TYPES.has(type)) ||
          !Number.isInteger(Number(maxSize)) || Number(maxSize) < 1 || Number(maxSize) > 10485760) {
        return NextResponse.json({ success: false, error: `Invalid file rules for ${update.document_key}` }, { status: 400 });
      }
      const next = await query(
        `UPDATE member_document_type_configs SET is_enabled = COALESCE($2, is_enabled),
           is_required = COALESCE($3, is_required), accepted_mime_types = $4::jsonb,
           max_size_bytes = $5, label = COALESCE($6, label), sort_order = COALESCE($7, sort_order), updated_at = NOW()
          WHERE document_key = $1 RETURNING *`,
        [update.document_key, typeof update.is_enabled === 'boolean' ? update.is_enabled : null,
          typeof update.is_required === 'boolean' ? update.is_required : null, JSON.stringify(accepted), Number(maxSize),
          typeof update.label === 'string' && update.label.trim() ? update.label.trim() : null,
          Number.isInteger(update.sort_order) ? update.sort_order : null]
      );
      await query(
        `INSERT INTO member_configuration_audit (setting_type, setting_key, old_value, new_value, changed_by)
         VALUES ('document_type', $1, $2::jsonb, $3::jsonb, $4)`,
        [update.document_key, JSON.stringify(current), JSON.stringify(next.rows[0]), perm.auth.userId]
      );
    }
    const result = await query('SELECT * FROM member_document_type_configs ORDER BY sort_order, label');
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
