import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// PUT /api/sacco-rules/[id] — Update a specific rule
export async function PUT(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;

    const { id } = await params;
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Rule update must be a JSON object' }, { status: 400 });
    }
    const { rule_value, description, is_active } = body;
    if (rule_value !== undefined &&
        (!rule_value || typeof rule_value !== 'object' || Array.isArray(rule_value))) {
      return NextResponse.json({ success: false, error: 'rule_value must be a JSON object' }, { status: 400 });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 1000)) {
      return NextResponse.json({ success: false, error: 'description must be 1000 characters or fewer' }, { status: 400 });
    }
    if (is_active !== undefined && typeof is_active !== 'boolean') {
      return NextResponse.json({ success: false, error: 'is_active must be true or false' }, { status: 400 });
    }

    const sets = [];
    const values = [];
    let idx = 1;

    if (rule_value !== undefined) {
      sets.push(`rule_value = $${idx++}`);
      values.push(JSON.stringify(rule_value));
    }
    if (description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(description);
    }
    if (is_active !== undefined) {
      sets.push(`is_active = $${idx++}`);
      values.push(is_active);
    }

    if (sets.length === 0) {
      return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 });
    }

    sets.push(`updated_at = NOW()`);
    values.push(id, perm.auth.organizationId);

    const result = await runWithOrganizationContext(perm.auth.organizationId, () => query(
      `UPDATE sacco_rules SET ${sets.join(', ')}
        WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      values
    ));

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE /api/sacco-rules/[id] — Soft-disable a rule
export async function DELETE(request, { params }) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;

    const { id } = await params;
    const result = await runWithOrganizationContext(perm.auth.organizationId, () => query(
      `UPDATE sacco_rules SET is_active = false, updated_at = NOW()
        WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [id, perm.auth.organizationId]
    ));

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
