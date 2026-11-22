import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getPlatformPool, queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TYPES = new Set(['institution_deposit', 'operational_expense', 'operational_advance', 'reimbursement', 'platform_revenue', 'other']);
const AMOUNT = /^\d{1,15}(?:\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeText(value, max = 1000) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null; }

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const organizationId = searchParams.get('institution_id');
  const params = [];
  let where = 'TRUE';
  if (status && ['pending', 'approved', 'rejected', 'reversed'].includes(status)) { params.push(status); where += ` AND p.status = $${params.length}`; }
  if (organizationId && UUID.test(organizationId)) { params.push(organizationId); where += ` AND p.organization_id = $${params.length}`; }
  try {
    const result = await queryPlatform(
      `SELECT p.*, o.name AS institution_name, o.slug AS institution_code,
              a.name AS institution_account_name,
              creator.name AS requested_by_name, approver.name AS approved_by_name
         FROM public.platform_operations p
         JOIN public.organizations o ON o.id = p.organization_id
         LEFT JOIN public.accounts a ON a.id = p.institution_account_id AND a.organization_id = p.organization_id
         JOIN public.platform_admins creator ON creator.id = p.created_by
         LEFT JOIN public.platform_admins approver ON approver.id = p.approved_by
        WHERE ${where}
        ORDER BY p.created_at DESC LIMIT 250`, params
    );
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Platform funding] List failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load funding operations' }, { status: 500 });
  }
}

export async function POST(request) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || !UUID.test(String(body.institution_id || ''))) return NextResponse.json({ success: false, error: 'Select an institution' }, { status: 400 });
  if (!TYPES.has(body.operation_type)) return NextResponse.json({ success: false, error: 'Select a valid funding category' }, { status: 400 });
  if (!AMOUNT.test(String(body.amount)) || Number(body.amount) <= 0) return NextResponse.json({ success: false, error: 'Amount must be positive with up to two decimal places' }, { status: 400 });
  const category = safeText(body.category, 80);
  const purpose = safeText(body.purpose, 2000);
  const accountingTreatment = safeText(body.accounting_treatment, 1000);
  const idempotencyKey = safeText(request.headers.get('Idempotency-Key'), 128);
  if (!category || !purpose || !accountingTreatment) return NextResponse.json({ success: false, error: 'Category, purpose, and accounting treatment are required' }, { status: 400 });
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return NextResponse.json({ success: false, error: 'A valid Idempotency-Key header is required' }, { status: 400 });
  const currency = String(body.currency || 'UGX').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ success: false, error: 'Currency must be an ISO three-letter code' }, { status: 400 });
  let institutionAccountId = null;
  if (body.operation_type === 'institution_deposit') {
    if (!UUID.test(String(body.institution_account_id || ''))) return NextResponse.json({ success: false, error: 'Choose the institution-owned destination account' }, { status: 400 });
    institutionAccountId = body.institution_account_id;
  }
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    institution_id: body.institution_id, operation_type: body.operation_type, category,
    amount: String(body.amount), currency, purpose, accountingTreatment,
    supportingDocumentUrl: safeText(body.supporting_document_url, 2000), institutionAccountId,
  })).digest('hex');
  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const institution = await client.query('SELECT id, name FROM public.organizations WHERE id = $1 FOR SHARE', [body.institution_id]);
    if (!institution.rows[0]) { await client.query('ROLLBACK'); return NextResponse.json({ success: false, error: 'Institution not found' }, { status: 404 }); }
    if (institutionAccountId) {
      const account = await client.query('SELECT id, currency, status, is_active FROM public.accounts WHERE id = $1 AND organization_id = $2', [institutionAccountId, body.institution_id]);
      if (!account.rows[0] || account.rows[0].status !== 'active' || account.rows[0].is_active !== true || account.rows[0].currency !== currency) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Destination must be an active institution account in the selected currency' }, { status: 400 });
      }
    }
    const inserted = await client.query(
      `INSERT INTO public.platform_operations
         (organization_id, idempotency_key, request_fingerprint, operation_type, category, amount, currency, purpose,
          accounting_treatment, supporting_document_url, institution_account_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [body.institution_id, idempotencyKey, requestFingerprint, body.operation_type, category, String(body.amount), currency,
        purpose, accountingTreatment, safeText(body.supporting_document_url, 2000), institutionAccountId, auth.user.id]
    );
    await client.query(
      `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, 'platform_operation_submitted', 'platform_operation', $2, $3::jsonb, $4)`,
      [auth.user.id, inserted.rows[0].id, JSON.stringify({ institution_id: body.institution_id, operation_type: body.operation_type, amount: String(body.amount), currency, purpose }), request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null]
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, data: { ...inserted.rows[0], institution_name: institution.rows[0].name }, message: 'Submitted for approval by a second platform administrator.' }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505' && error.constraint === 'platform_operations_idempotency_key_key') {
      const existing = await queryPlatform('SELECT * FROM public.platform_operations WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== requestFingerprint) return NextResponse.json({ success: false, error: 'Idempotency-Key was already used for a different operation' }, { status: 409 });
        return NextResponse.json({ success: true, duplicate: true, data: existing.rows[0] });
      }
    }
    console.error('[Platform funding] Submit failed:', error);
    return NextResponse.json({ success: false, error: 'Could not submit platform operation' }, { status: 500 });
  } finally { client.release(); }
}
