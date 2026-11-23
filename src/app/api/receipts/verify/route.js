import { NextResponse } from 'next/server';
import { queryPlatform } from '@/lib/db.js';
import { isValidReceiptStamp } from '@/lib/receipts/receipt-stamp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const receiptNumber = String(url.searchParams.get('number') || '').trim().toUpperCase();
  const stamp = url.searchParams.get('stamp') || '';
  if (!/^RCP-[A-F0-9]{32}$/.test(receiptNumber) || !isValidReceiptStamp(receiptNumber, stamp)) {
    return NextResponse.json({ success: true, valid: false }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const transaction = await queryPlatform(
      `SELECT t.receipt_number, t.transaction_type, t.created_at, o.name AS organization_name,
              t.principal_minor, t.transaction_charges_minor,
              COALESCE(t.principal_minor, NULLIF(t.metadata->>'principal_minor', '')::numeric,
                (SELECT MAX(ABS(l.amount))
                   FROM public.ledger l
                  WHERE l.organization_id = t.organization_id AND l.source_id = t.id)) AS amount,
              COALESCE((SELECT l.currency FROM public.ledger l
                         WHERE l.organization_id = t.organization_id AND l.source_id = t.id
                         ORDER BY l.created_at LIMIT 1), 'UGX') AS currency
         FROM public.transactions t
         JOIN public.organizations o ON o.id = t.organization_id
        WHERE t.receipt_number = $1
           OR ('RCP-' || UPPER(REPLACE(t.id::text, '-', ''))) = $1
        LIMIT 1`, [receiptNumber]
    );
    const record = transaction.rows[0];
    if (record) {
      return NextResponse.json({
        success: true, valid: true, receiptNumber,
        organization: record.organization_name,
        transactionType: record.transaction_type,
        issuedAt: record.created_at,
        amount: record.amount,
        charges: record.transaction_charges_minor,
        currency: record.currency,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const ledger = await queryPlatform(
      `SELECT l.receipt_number, l.source_type, l.created_at, l.amount, l.currency,
              o.name AS organization_name
         FROM public.ledger l
         JOIN public.organizations o ON o.id = l.organization_id
        WHERE l.receipt_number = $1
           OR ('RCP-' || UPPER(REPLACE(COALESCE(l.source_id, l.id)::text, '-', ''))) = $1
        ORDER BY l.created_at LIMIT 1`, [receiptNumber]
    );
    const ledgerRecord = ledger.rows[0];
    if (!ledgerRecord) return NextResponse.json({ success: true, valid: false }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({
      success: true, valid: true, receiptNumber,
      organization: ledgerRecord.organization_name,
      transactionType: ledgerRecord.source_type,
      issuedAt: ledgerRecord.created_at,
      amount: Math.abs(Number(ledgerRecord.amount)),
      charges: null,
      currency: ledgerRecord.currency,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Receipt verification] Lookup failed:', error.message);
    return NextResponse.json({ success: false, valid: false, error: 'Verification service is temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
