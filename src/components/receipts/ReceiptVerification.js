'use client';

import { useEffect, useState } from 'react';

function money(amount, currency = 'UGX') {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${Number(amount).toLocaleString('en-UG')} ${currency}`;
  }
}

export default function ReceiptVerification({ receiptNumber, stamp }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const query = new URLSearchParams({ number: receiptNumber, stamp });
    fetch(`/api/receipts/verify?${query}`, { cache: 'no-store' })
      .then(response => response.json())
      .then(data => setResult(data))
      .catch(() => setResult({ valid: false, error: 'Verification service is temporarily unavailable' }))
      .finally(() => setLoading(false));
  }, [receiptNumber, stamp]);

  const valid = result?.valid === true;
  return <main className="mx-auto flex min-h-screen max-w-2xl items-center justify-center p-5">
    <section className="w-full rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-9">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Xhaira receipt verification</div>
      <h1 className="mt-2 text-2xl font-bold">{loading ? 'Checking digital seal…' : valid ? 'Authentic receipt' : 'Receipt not verified'}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{loading ? 'Checking the issuer’s transaction record.' : valid ? 'This receipt number and its signed digital seal match an issued Xhaira record.' : result?.error || 'The digital seal is invalid or the receipt record could not be found.'}</p>
      {!loading && valid && <dl className="mt-6 grid grid-cols-1 gap-4 rounded-xl bg-muted/50 p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-muted-foreground">Receipt</dt><dd className="mt-1 font-semibold">{result.receiptNumber}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Issued by</dt><dd className="mt-1 font-semibold">{result.organization}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Transaction</dt><dd className="mt-1 font-semibold capitalize">{String(result.transactionType || '').replaceAll('_', ' ')}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Date</dt><dd className="mt-1 font-semibold">{result.issuedAt ? new Date(result.issuedAt).toLocaleString('en-UG', { timeZone: 'Africa/Kampala' }) : '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Amount</dt><dd className="mt-1 font-semibold">{money(result.amount, result.currency)}</dd></div>
        {Number(result.charges) > 0 && <div><dt className="text-xs text-muted-foreground">Transaction charges</dt><dd className="mt-1 font-semibold">{money(result.charges, result.currency)}</dd></div>}
      </dl>}
      <p className="mt-6 text-xs text-muted-foreground">This check confirms the receipt matches a record held by Xhaira. It does not confirm that a payment has since been refunded or reversed.</p>
    </section>
  </main>;
}
