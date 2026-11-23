import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import QRCode from 'qrcode';
import { createReceiptVerificationUrl } from '@/lib/receipts/receipt-stamp.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function formatAmount(amount, currency = 'UGX') {
  return `${currency} ${Number(amount || 0).toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderReceipt({ receiptNumber, organization, event, lines, creator, createdAt, reference, metadata = {}, reason, depositorName, receiverName, principalMinor, transactionChargesMinor, installments = [], qrDataUrl }) {
  const type = String(event || 'financial transaction').replace(/_/g, ' ');
  const date = createdAt
    ? new Date(createdAt).toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kampala' })
    : '—';
  const chargeMinor = Number(transactionChargesMinor);
  const hasConsolidatedCharges = Number.isSafeInteger(chargeMinor) && chargeMinor > 0;
  const rows = lines.map((line) => `<tr>
    <td>${escapeHtml(line.description || type)}</td>
    <td>${escapeHtml(line.account_name || line.member_account || 'Account')}</td>
    <td>${escapeHtml(line.entry_type || line.direction || '—')}</td>
    <td class="amount">${escapeHtml(formatAmount(line.amount, line.currency))}</td>
  </tr>`).join('');
  const isDoubleEntry = lines.some((line) => ['DEBIT', 'CREDIT'].includes(line.entry_type));
  const isTransferLedger = type.includes('transfer');
  const totalLines = isDoubleEntry
    ? lines.filter((line) => line.entry_type === 'DEBIT')
    : isTransferLedger ? lines.filter((line) => line.entry_type === 'OUT') : lines;
  const total = totalLines.reduce((sum, line) => sum + Math.abs(Number(line.amount || 0)), 0);
  const totalCurrency = totalLines[0]?.currency || lines[0]?.currency || 'UGX';
  const receiptRows = hasConsolidatedCharges
    ? `<tr><td>${type.toLowerCase().includes('withdrawal') ? 'Amount withdrawn' : 'Amount credited'}</td><td>Member account</td><td>—</td><td class="amount">${escapeHtml(formatAmount(
      Number.isSafeInteger(Number(principalMinor))
        ? Number(principalMinor)
        : Number.isSafeInteger(Number(metadata.principal_minor)) ? Number(metadata.principal_minor)
        : type.toLowerCase().includes('withdrawal') ? Math.max(0, total - chargeMinor) : total,
      totalCurrency))}</td></tr>
       <tr><td>Transaction charges</td><td>Combined charges</td><td>—</td><td class="amount">${escapeHtml(formatAmount(chargeMinor, totalCurrency))}</td></tr>`
    : rows;
  const details = metadata.payment_method || '';
  const reasonRow = (reason || metadata.reason) ? `<div><span>Reason</span>${escapeHtml(reason || metadata.reason)}</div>` : '';
  const payer = depositorName || metadata.depositor_name || metadata.paid_by;
  const recipient = receiverName || metadata.receiver_name || metadata.withdrawn_to;
  const payerRow = payer ? `<div><span>Depositor</span>${escapeHtml(payer)}</div>` : '';
  const recipientRow = recipient ? `<div><span>Receiver</span>${escapeHtml(recipient)}</div>` : '';
  const chargeRow = '';
  const totalLabel = type.toLowerCase().includes('withdrawal') ? 'Amount withdrawn' : isTransferLedger ? 'Outgoing total' : 'Total';
  const totalBlock = hasConsolidatedCharges && type.toLowerCase().includes('withdrawal')
    ? ''
    : `<div class="total"><span>${escapeHtml(totalLabel)}</span><span>${escapeHtml(formatAmount(total, totalCurrency))}</span></div>`;
  const classificationRow = metadata.classification ? `<div><span>Classification</span>${escapeHtml(metadata.classification)}</div>` : '';
  const installmentRows = installments.map((item) => `<tr><td>Installment ${escapeHtml(item.installment_number)}</td><td>${escapeHtml(item.status)}</td><td class="amount">${escapeHtml(formatAmount(item.paid_amount))}</td></tr>`).join('');
  const phone = organization.contact_phones || '';
  const email = organization.contact_email || '';
  const address = organization.address || '';
  const website = organization.website || '';
  const logoUrl = String(organization.logo_url || '');
  const isUploadedImage = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(logoUrl);
  let isRemoteImage = false;
  try {
    isRemoteImage = ['http:', 'https:'].includes(new URL(logoUrl).protocol);
  } catch { /* no organization logo set */ }
  const logo = isUploadedImage || isRemoteImage
    ? `<img class="org-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(organization.organization_name || 'Organization')} logo">`
    : '';
  const qrSeal = qrDataUrl
    ? `<div class="qr-seal"><img src="${escapeHtml(qrDataUrl)}" alt="Receipt authenticity QR code"><div><strong>Digital authenticity seal</strong><br>Scan to verify this receipt with Xhaira.</div></div>`
    : `<div class="qr-seal unavailable">Digital verification seal unavailable. Contact the organization to verify this receipt.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Receipt ${escapeHtml(receiptNumber)}</title><style>
  *{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;max-width:780px;margin:32px auto;padding:24px;background:#fff}
  header{border-bottom:2px solid #172033;padding-bottom:18px;margin-bottom:24px;display:flex;justify-content:space-between;gap:20px}
  h1{font-size:24px;margin:0 0 7px}.org-logo{display:block;max-width:180px;max-height:64px;object-fit:contain;margin:0 0 12px}.muted{color:#64748b;font-size:13px;line-height:1.6}.receipt{text-align:right}.receipt strong{font-size:22px;display:block;color:#047857}
  .summary{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin:24px 0}.summary div{font-size:14px}.summary span{display:block;color:#64748b;font-size:11px;text-transform:uppercase;margin-bottom:3px}
  table{width:100%;border-collapse:collapse;margin:22px 0}th{text-align:left;background:#f1f5f9;font-size:11px;text-transform:uppercase;color:#475569}th,td{padding:11px 9px;border-bottom:1px solid #e2e8f0;font-size:13px}.amount{text-align:right;white-space:nowrap}
  .total{margin-left:auto;width:280px;display:flex;justify-content:space-between;padding:14px 0;border-top:2px solid #172033;font-weight:bold;font-size:17px}
  footer{margin-top:38px;padding-top:16px;border-top:1px solid #cbd5e1;text-align:center;color:#64748b;font-size:12px}.qr-seal{display:flex;align-items:center;justify-content:center;gap:12px;margin:18px auto 8px;color:#334155;text-align:left}.qr-seal img{width:112px;height:112px;image-rendering:pixelated}.qr-seal strong{color:#047857}.qr-seal.unavailable{font-size:11px;color:#a16207}.actions{position:fixed;top:16px;right:16px}
  button{background:#047857;color:#fff;border:0;padding:10px 16px;border-radius:7px;font-weight:bold;cursor:pointer}@media print{body{margin:0 auto;padding:10px}.actions{display:none}}
  @media(max-width:600px){body{margin:8px;padding:14px}header{display:block}.receipt{text-align:left;margin-top:16px}.summary{grid-template-columns:1fr}}
  </style></head><body><div class="actions"><button onclick="window.print()">Print / Save PDF</button></div>
  <header><div>${logo}<h1>${escapeHtml(organization.organization_name || 'Organization')}</h1>
  ${address ? `<div class="muted">${escapeHtml(address)}</div>` : ''}${phone ? `<div class="muted">${escapeHtml(phone)}</div>` : ''}
  ${email ? `<div class="muted">${escapeHtml(email)}</div>` : ''}${website ? `<div class="muted">${escapeHtml(website)}</div>` : ''}
  </div><div class="receipt"><strong>RECEIPT</strong><span>${escapeHtml(receiptNumber)}</span></div></header>
  <section class="summary"><div><span>Transaction</span>${escapeHtml(type)}</div><div><span>Date and time</span>${escapeHtml(date)}</div>
  <div><span>Recorded by</span>${escapeHtml(creator || 'System')}</div><div><span>Reference</span>${escapeHtml(reference || '—')}</div>
  ${details ? `<div><span>Payment channel</span>${escapeHtml(details)}</div>` : ''}${reasonRow}${payerRow}${recipientRow}${chargeRow}${classificationRow}</section>
  <table><thead><tr><th>Description</th><th>Account / Member</th><th>Entry</th><th class="amount">Amount</th></tr></thead>
  <tbody>${receiptRows || '<tr><td colspan="4">No ledger lines found</td></tr>'}</tbody></table>
  ${installmentRows ? `<h2>Loan installment status</h2><table><thead><tr><th>Installment</th><th>Status after this payment</th><th class="amount">Cumulative paid</th></tr></thead><tbody>${installmentRows}</tbody></table>` : ''}
  ${totalBlock}
  <footer>${qrSeal}<div>System generated receipt. Keep this receipt for your records.</div>${escapeHtml(receiptNumber)}</footer></body></html>`;
}

export async function GET(request, { params }) {
  try {
    const permission = await requirePermission(request, 'finance.view');
    if (permission instanceof NextResponse) return permission;
    const { auth } = permission;
    const { receiptNumber } = await params;
    const normalizedReceipt = decodeURIComponent(receiptNumber).trim().toUpperCase();
    if (!/^RCP-[A-F0-9]{32}$/.test(normalizedReceipt)) {
      return NextResponse.json({ success: false, error: 'Invalid receipt number' }, { status: 400 });
    }
    const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL || process.env.API_URL;
    const origin = configuredOrigin ? new URL(configuredOrigin).origin : new URL(request.url).origin;
    let qrDataUrl = null;
    try {
      const verificationUrl = createReceiptVerificationUrl(normalizedReceipt, origin);
      qrDataUrl = await QRCode.toDataURL(verificationUrl, {
        errorCorrectionLevel: 'M', margin: 1, width: 224,
        color: { dark: '#102a43', light: '#ffffff' },
      });
    } catch (error) {
      console.error('[Receipt] QR seal could not be generated:', error.message);
    }

    const html = await runWithOrganizationContext(auth.organizationId, async () => {
      const transactionResult = await query(
        `SELECT t.id, COALESCE(t.receipt_number, 'RCP-' || UPPER(REPLACE(t.id::TEXT, '-', ''))) AS receipt_number,
                t.transaction_type, t.description, t.reference, t.metadata, t.reason, t.depositor_name, t.receiver_name,
                t.principal_minor, t.transaction_charges_minor, t.created_at, u.name AS creator_name,
                o.name AS organization_name, cb.contact_phones, cb.contact_email, cb.website, cb.address, cb.logo_url
           FROM public.transactions t
           LEFT JOIN public.users u ON u.id = t.created_by AND u.organization_id = t.organization_id
           JOIN public.organizations o ON o.id = t.organization_id
           LEFT JOIN public.company_branding cb ON cb.organization_id = o.id AND cb.is_active = true
          WHERE t.organization_id = $1
            AND COALESCE(t.receipt_number, 'RCP-' || UPPER(REPLACE(t.id::TEXT, '-', ''))) = $2`,
        [auth.organizationId, normalizedReceipt]
      );

      if (transactionResult.rows[0]) {
        const transaction = transactionResult.rows[0];
        const entryResult = await query(
          `SELECT le.entry_type, le.amount, le.currency, le.description,
                  a.name AS account_name, ma.account_number AS member_account, m.full_name AS member_name
             FROM public.ledger_entries le
             LEFT JOIN public.accounts a ON a.id = le.account_id AND a.organization_id = le.organization_id
             LEFT JOIN public.member_accounts ma ON ma.id = le.member_account_id AND ma.organization_id = le.organization_id
             LEFT JOIN public.members m ON m.id = ma.member_id AND m.organization_id = ma.organization_id
            WHERE le.organization_id = $1 AND le.transaction_id = $2
            ORDER BY le.created_at, le.id`, [auth.organizationId, transaction.id]
        );
        let lines = entryResult.rows.map((line) => ({ ...line, account_name: line.member_name || line.account_name || line.member_account }));
        if (lines.length === 0 && transaction.metadata?.transaction_scope === 'organization') {
          const organizationLedger = await query(
            `SELECT l.amount, l.currency, l.description, a.name AS account_name,
                    CASE WHEN l.amount < 0 THEN 'DEBIT' ELSE 'CREDIT' END AS entry_type
               FROM public.ledger l
               JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
              WHERE l.organization_id = $1 AND l.source_id = $2
              ORDER BY l.created_at, l.id`, [auth.organizationId, transaction.id]
          );
          lines = organizationLedger.rows;
        }
        const installmentResult = transaction.transaction_type === 'loan_repayment'
          ? await query(
            `SELECT installment_number, paid_amount, total_amount, status
               FROM public.loan_schedules
              WHERE organization_id = $1 AND transaction_id = $2
              ORDER BY installment_number`, [auth.organizationId, transaction.id]
          )
          : { rows: [] };
        return renderReceipt({ receiptNumber: transaction.receipt_number, organization: transaction,
          event: transaction.transaction_type, lines, creator: transaction.creator_name,
          createdAt: transaction.created_at, reference: transaction.reference,
          metadata: transaction.metadata || {}, reason: transaction.reason,
          depositorName: transaction.depositor_name, receiverName: transaction.receiver_name,
          principalMinor: transaction.principal_minor,
          transactionChargesMinor: transaction.transaction_charges_minor,
          qrDataUrl,
          installments: installmentResult.rows });
      }

      const ledgerResult = await query(
        `SELECT l.id, COALESCE(l.receipt_number, 'RCP-' || UPPER(REPLACE(COALESCE(l.source_id, l.id)::TEXT, '-', ''))) AS receipt_number,
                l.source_type, l.description, l.amount, l.currency, l.created_at, l.source_id,
                a.name AS account_name, u.name AS creator_name,
                o.name AS organization_name, cb.contact_phones, cb.contact_email, cb.website, cb.address, cb.logo_url
           FROM public.ledger l
           JOIN public.accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
           LEFT JOIN public.users u ON u.id = l.created_by AND u.organization_id = l.organization_id
           JOIN public.organizations o ON o.id = l.organization_id
           LEFT JOIN public.company_branding cb ON cb.organization_id = o.id AND cb.is_active = true
          WHERE l.organization_id = $1
            AND COALESCE(l.receipt_number, 'RCP-' || UPPER(REPLACE(COALESCE(l.source_id, l.id)::TEXT, '-', ''))) = $2
          ORDER BY l.created_at, l.id`, [auth.organizationId, normalizedReceipt]
      );
      if (!ledgerResult.rows.length) return null;
      const first = ledgerResult.rows[0];
      return renderReceipt({ receiptNumber: first.receipt_number, organization: first,
        event: first.source_type, lines: ledgerResult.rows.map((line) => ({ ...line, entry_type: Number(line.amount) < 0 ? 'OUT' : 'IN' })),
        creator: first.creator_name, createdAt: first.created_at, reference: first.source_id, qrDataUrl });
    });

    if (!html) return NextResponse.json({ success: false, error: 'Receipt not found' }, { status: 404 });
    const shouldDownload = new URL(request.url).searchParams.get('download') === '1';
    return new NextResponse(html, { headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `${shouldDownload ? 'attachment' : 'inline'}; filename="${normalizedReceipt}.html"`,
      'Cache-Control': 'private, no-store',
    } });
  } catch (error) {
    console.error('[Receipt] GET error:', error.message);
    return NextResponse.json({ success: false, error: 'Failed to load receipt' }, { status: error.status || 500 });
  }
}
