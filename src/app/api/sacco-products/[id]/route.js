import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

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
    const {
      name, description, product_type, price, currency,
      interest_rate, duration, repayment_cycle,
      min_amount, max_amount, requires_approval, is_active, metadata,
    } = body;

    const result = await query(
      `UPDATE products SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        product_type = COALESCE($3, product_type),
        price = COALESCE($4, price),
        currency = COALESCE($5, currency),
        interest_rate = COALESCE($6, interest_rate),
        duration = COALESCE($7, duration),
        repayment_cycle = COALESCE($8, repayment_cycle),
        min_amount = COALESCE($9, min_amount),
        max_amount = COALESCE($10, max_amount),
        requires_approval = COALESCE($11, requires_approval),
        is_active = COALESCE($12, is_active),
        metadata = COALESCE($13, metadata),
        updated_at = NOW()
       WHERE id = $14 AND organization_id = $15
       RETURNING *`,
      [name, description, product_type, price, currency, interest_rate, duration, repayment_cycle, min_amount, max_amount, requires_approval, is_active, metadata ? JSON.stringify(metadata) : null, id, organizationId]
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
