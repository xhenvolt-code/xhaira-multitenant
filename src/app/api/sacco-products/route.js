import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const PRODUCT_TYPES = new Set([
  'LOAN', 'SAVINGS', 'INVESTMENT', 'INSTALLMENT', 'SERVICE', 'SHARES', 'FIXED_DEPOSIT',
]);
const REPAYMENT_CYCLES = new Set([
  'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY',
]);
const DURATION_UNITS = new Set(['DAYS', 'WEEKS', 'MONTHS', 'YEARS']);
const PRODUCT_STORAGE_ERROR_CODES = new Set(['42P01', '42703']);

function isOptionalFiniteNumber(value) {
  return value === undefined || value === null || value === '' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
}

// GET /api/sacco-products — List SACCO financial products
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'products.view');
    if (perm instanceof NextResponse) return perm;
    const organizationId = perm.auth.organizationId;

    return await runWithOrganizationContext(organizationId, async () => {
      const { searchParams } = new URL(request.url);
      const type = searchParams.get('type') || '';
      const active = searchParams.get('active');

      let where = 'WHERE organization_id = $1';
      const params = [organizationId];

      if (type) {
        params.push(type);
        where += ` AND product_type = $${params.length}`;
      }
      if (active !== null && active !== '') {
        params.push(active === 'true');
        where += ` AND is_active = $${params.length}`;
      }

      const result = await query(
        `SELECT * FROM products ${where} ORDER BY created_at DESC`, params
      );

      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[SACCO Products] GET error:', error.message);
    const schemaUnavailable = PRODUCT_STORAGE_ERROR_CODES.has(error.code);
    return NextResponse.json({
      success: false,
      error: schemaUnavailable
        ? 'Loan product storage is unavailable. Verify that the SACCO loan-product schema is installed.'
        : 'Failed to fetch loan products',
    }, { status: schemaUnavailable ? 503 : 500 });
  }
}

// POST /api/sacco-products — Create a SACCO financial product
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'products.create');
    if (perm instanceof NextResponse) return perm;
    const organizationId = perm.auth.organizationId;

    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Product details must be a JSON object' }, { status: 400 });
    }
    const {
      name, description, product_type, price, currency,
      interest_rate, duration, duration_unit, repayment_cycle,
      min_amount, max_amount, requires_approval, metadata, is_active,
    } = body;

    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 || !product_type) {
      return NextResponse.json({ success: false, error: 'name and product_type are required' }, { status: 400 });
    }

    if (!PRODUCT_TYPES.has(product_type)) {
      return NextResponse.json({
        success: false,
        error: `Invalid product_type. Must be one of: ${Array.from(PRODUCT_TYPES).join(', ')}`,
      }, { status: 400 });
    }
    if (![price, interest_rate, duration, min_amount, max_amount].every(isOptionalFiniteNumber)) {
      return NextResponse.json({ success: false, error: 'Product numeric fields must contain valid numbers' }, { status: 400 });
    }
    if (duration !== undefined && duration !== null && duration !== '' && !Number.isInteger(Number(duration))) {
      return NextResponse.json({ success: false, error: 'Duration must be a whole number of periods' }, { status: 400 });
    }
    if (duration !== undefined && duration !== null && duration !== '' && Number(duration) < 1) {
      return NextResponse.json({ success: false, error: 'Duration must be at least one period' }, { status: 400 });
    }
    const normalizedDurationUnit = String(duration_unit || 'MONTHS').toUpperCase();
    if (!DURATION_UNITS.has(normalizedDurationUnit)) {
      return NextResponse.json({ success: false, error: 'Duration unit must be DAYS, WEEKS, MONTHS, or YEARS' }, { status: 400 });
    }
    if (repayment_cycle && !REPAYMENT_CYCLES.has(repayment_cycle)) {
      return NextResponse.json({ success: false, error: 'Invalid repayment cycle' }, { status: 400 });
    }
    if (requires_approval !== undefined && typeof requires_approval !== 'boolean') {
      return NextResponse.json({ success: false, error: 'requires_approval must be true or false' }, { status: 400 });
    }
    if (is_active !== undefined && typeof is_active !== 'boolean') {
      return NextResponse.json({ success: false, error: 'is_active must be true or false' }, { status: 400 });
    }
    const normalizedCurrency = String(currency || 'UGX').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      return NextResponse.json({ success: false, error: 'Currency must be a three-letter code' }, { status: 400 });
    }

    return await runWithOrganizationContext(organizationId, async () => {
      const result = await query(
        `INSERT INTO products
           (organization_id, name, description, product_type, price, currency,
            interest_rate, duration, duration_unit, repayment_cycle, min_amount, max_amount,
            requires_approval, is_active, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [
          organizationId,
          name.trim(),
          typeof description === 'string' ? description.trim() || null : null,
          product_type,
          price === '' ? null : price ?? null,
          normalizedCurrency,
          interest_rate === '' ? null : interest_rate ?? null,
          duration === '' ? null : duration ?? null,
          normalizedDurationUnit,
          repayment_cycle || null,
          min_amount === '' ? null : min_amount ?? null,
          max_amount === '' ? null : max_amount ?? null,
          requires_approval ?? true,
          is_active ?? true,
          JSON.stringify(metadata || {}),
          perm.auth.userId,
        ]
      );

      return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
    });
  } catch (error) {
    console.error('[SACCO Products] POST error:', error.message);
    const schemaUnavailable = PRODUCT_STORAGE_ERROR_CODES.has(error.code);
    return NextResponse.json({
      success: false,
      error: schemaUnavailable
        ? 'Loan product storage is unavailable. Verify that the SACCO loan-product schema is installed.'
        : 'Failed to create loan product',
    }, { status: schemaUnavailable ? 503 : 500 });
  }
}
