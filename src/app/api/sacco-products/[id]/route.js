import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const DURATION_UNITS = new Set(['DAYS', 'WEEKS', 'MONTHS', 'YEARS']);

function failureResponse(error, operation) {
  console.error(`[SACCO Product Detail] ${operation} error:`, error.message);
  const schemaUnavailable = error.code === '42P01' || error.code === '42703';
  return NextResponse.json({
    success: false,
    error: schemaUnavailable
      ? 'Loan product storage is unavailable. Verify that the SACCO loan-product schema is installed.'
      : `Failed to ${operation.toLowerCase()} loan product`,
  }, { status: schemaUnavailable ? 503 : 500 });
}

// GET /api/sacco-products/[id]
export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'products.view');
    if (perm instanceof NextResponse) return perm;
    const organizationId = perm.auth.organizationId;

    return await runWithOrganizationContext(organizationId, async () => {
      const { id } = await params;
      const result = await query(
        `SELECT * FROM products WHERE id = $1 AND organization_id = $2`,
        [id, organizationId]
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    return failureResponse(error, 'fetch');
  }
}

// PUT /api/sacco-products/[id]
export async function PUT(request, { params }) {
  try {
    const perm = await requirePermission(request, 'products.edit');
    if (perm instanceof NextResponse) return perm;
    const organizationId = perm.auth.organizationId;

    return await runWithOrganizationContext(organizationId, async () => {
    const { id } = await params;
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Product update must be a JSON object' }, { status: 400 });
    }
    const {
      name, description, product_type, price, currency,
      interest_rate, duration, duration_unit, repayment_cycle,
      min_amount, max_amount, requires_approval, is_active, metadata,
    } = body;
    if (duration !== undefined && duration !== null &&
        (!Number.isInteger(Number(duration)) || Number(duration) < 1)) {
      return NextResponse.json({ success: false, error: 'Duration must be a positive whole number of periods' }, { status: 400 });
    }
    const normalizedDurationUnit = duration_unit === undefined
      ? null
      : String(duration_unit).toUpperCase();
    if (normalizedDurationUnit !== null && !DURATION_UNITS.has(normalizedDurationUnit)) {
      return NextResponse.json({ success: false, error: 'Duration unit must be DAYS, WEEKS, MONTHS, or YEARS' }, { status: 400 });
    }

    const result = await query(
      `UPDATE products SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        product_type = COALESCE($3, product_type),
        price = COALESCE($4, price),
        currency = COALESCE($5, currency),
        interest_rate = COALESCE($6, interest_rate),
        duration = COALESCE($7, duration),
        duration_unit = COALESCE($8, duration_unit),
        repayment_cycle = COALESCE($9, repayment_cycle),
        min_amount = COALESCE($10, min_amount),
        max_amount = COALESCE($11, max_amount),
        requires_approval = COALESCE($12, requires_approval),
        is_active = COALESCE($13, is_active),
        metadata = COALESCE($14, metadata),
        updated_at = NOW()
       WHERE id = $15 AND organization_id = $16
       RETURNING *`,
      [name, description, product_type, price, currency, interest_rate, duration, normalizedDurationUnit,
        repayment_cycle, min_amount, max_amount, requires_approval, is_active,
        metadata ? JSON.stringify(metadata) : null, id, organizationId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
    });
  } catch (error) {
    return failureResponse(error, 'update');
  }
}
