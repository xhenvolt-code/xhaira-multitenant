/**
 * GET    /api/account-type-rules/[id]  — fetch single rule
 * PUT    /api/account-type-rules/[id]  — update rule value / enabled flag
 * DELETE /api/account-type-rules/[id]  — delete rule
 */

import { NextResponse } from 'next/server';
import { query }         from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;

    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `SELECT r.*, at.name AS account_type_name, at.code AS account_type_code
           FROM account_type_rules r
           JOIN account_types at ON at.id = r.account_type_id AND at.organization_id = $2
          WHERE r.id = $1 AND r.organization_id = $2`,
        [id, perm.auth.organizationId]
      );
      if (result.rows.length === 0) return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[AccountTypeRules] GET[id] error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;

    const { id } = await params;
    const body = await request.json();
    const updates = [];
    const values  = [];
    let i = 1;

    if (body.rule_value !== undefined) {
      updates.push(`rule_value = $${i++}::JSONB`);
      values.push(JSON.stringify(body.rule_value));
    }
    if (body.description !== undefined) {
      updates.push(`description = $${i++}`);
      values.push(body.description);
    }
    if (body.is_enabled !== undefined) {
      if (typeof body.is_enabled !== 'boolean') {
        return NextResponse.json({ success: false, error: 'is_enabled must be true or false' }, { status: 400 });
      }
      updates.push(`is_enabled = $${i++}`);
      values.push(body.is_enabled);
    }

    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    values.push(id, perm.auth.organizationId);
    const result = await runWithOrganizationContext(perm.auth.organizationId, () => query(
      `UPDATE account_type_rules SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${i} AND organization_id = $${i + 1}
       RETURNING *`,
      values
    ));
    if (result.rows.length === 0) return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('[AccountTypeRules] PUT error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;

    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `DELETE FROM account_type_rules WHERE id = $1 AND organization_id = $2 RETURNING id, rule_key`,
        [id, perm.auth.organizationId]
      );
      if (result.rows.length === 0) return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    console.error('[AccountTypeRules] DELETE error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
