'use client';

import { useEffect, useMemo, useState } from 'react';
import { calculateTransactionFees } from '@/lib/payments/transaction-fees.js';

const money = value => `UGX ${Number(value || 0).toLocaleString('en-UG')}`;
const localDateTime = () => {
  const date = new Date(Date.now() + 60000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};

export default function PlatformFeesPage() {
  const [data, setData] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [scope, setScope] = useState('platform');
  const [organizationId, setOrganizationId] = useState('');
  const [component, setComponent] = useState('marzpay');
  const [transactionType, setTransactionType] = useState('deposit');
  const [rate, setRate] = useState('0');
  const [enabled, setEnabled] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(localDateTime);
  const [reason, setReason] = useState('');
  const [principal, setPrincipal] = useState('10000');
  const [previewRate, setPreviewRate] = useState('0');

  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/platform/fees', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Fee schedules could not be loaded');
      setData(result.data || []); setOrganizations(result.organizations || []); setError('');
    } catch (err) { setError(err.message || 'Fee schedules could not be loaded'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const preview = useMemo(() => {
    const amount = Number(principal);
    const percentage = Number(previewRate);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
    return calculateTransactionFees({
      direction: transactionType,
      principalMinor: amount,
      fees: {
        xhenvolt: component === 'xhenvolt' ? { basisPoints: Math.round(percentage * 100), enabled } : { basisPoints: 0 },
        marzpay: component === 'marzpay' ? { basisPoints: Math.round(percentage * 100), enabled } : { basisPoints: 0 },
      },
    });
  }, [principal, previewRate, transactionType, component, enabled]);

  async function submit(event) {
    event.preventDefault(); setSaving(true); setError(''); setSuccess('');
    try {
      const response = await fetch('/api/platform/fees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, organizationId, component: scope === 'organization' ? 'xhenvolt' : component,
          transactionType, basisPoints: Math.round(Number(rate) * 100), enabled,
          effectiveFrom: new Date(effectiveFrom).toISOString(), reason }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Fee configuration could not be saved');
      setSuccess(`Version ${result.data.version} saved and scheduled for ${new Date(result.data.effective_from).toLocaleString()}.`);
      setReason(''); await load();
    } catch (err) { setError(err.message || 'Fee configuration could not be saved'); }
    finally { setSaving(false); }
  }

  const records = data.filter(row => row.component === (scope === 'organization' ? 'xhenvolt' : component) && row.transaction_type === transactionType &&
    (scope === 'platform' ? row.scope === 'platform' : row.scope === 'organization' && row.organization_id === organizationId));

  return <div className="mx-auto max-w-6xl space-y-6">
    <header><div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Xhenvolt · Pricing</div><h1 className="mt-1 text-2xl font-bold">Transaction fee management</h1><p className="mt-1 max-w-3xl text-sm text-slate-400">Set effective-dated platform and MarzPay rates. Organizations see one combined provider charge; internal fee allocation remains in platform records.</p></header>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    {success && <p role="status" className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{success}</p>}
    <p className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200">Fee versions and audit history are managed here. Live MarzPay amount calculation and fee allocation are still pending the approved settlement-accounting integration.</p>
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold">Create a fee version</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-slate-300">Configuration scope<select value={scope} onChange={event => { setScope(event.target.value); if (event.target.value === 'organization') setComponent('xhenvolt'); }} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"><option value="platform">Platform default</option><option value="organization">Organization override</option></select></label>
          {scope === 'organization' && <label className="text-sm text-slate-300">Organization<select required value={organizationId} onChange={event => setOrganizationId(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Select organization</option>{organizations.map(org => <option value={org.id} key={org.id}>{org.name}</option>)}</select></label>}
          <label className="text-sm text-slate-300">Fee component<select value={component} disabled={scope === 'organization'} onChange={event => setComponent(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"><option value="marzpay">MarzPay gateway</option><option value="xhenvolt">Xhenvolt platform</option></select></label>
          <label className="text-sm text-slate-300">Transaction type<select value={transactionType} onChange={event => setTransactionType(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"><option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option></select></label>
          <label className="text-sm text-slate-300">Percentage<input required type="number" min="0" max="100" step="0.01" value={rate} onChange={event => { setRate(event.target.value); setPreviewRate(event.target.value); }} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" /></label>
          <label className="text-sm text-slate-300">Effective from<input required type="datetime-local" value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" /></label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enable this fee component</label>
        <label className="block text-sm text-slate-300">Reason for change<textarea required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={2} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" /></label>
        <button disabled={saving || (scope === 'organization' && !organizationId)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50">{saving ? 'Saving…' : 'Save effective-dated version'}</button>
      </form>
      <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold">Preview effect</h2><p className="text-xs text-slate-400">Preview applies the same integer rounding as the shared fee calculation service.</p>
        <label className="block text-sm text-slate-300">Principal (UGX)<input type="number" min="1" step="1" value={principal} onChange={event => setPrincipal(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" /></label>
        <label className="block text-sm text-slate-300">Proposed {scope === 'organization' ? 'Xhenvolt' : component} rate (%)<input type="number" min="0" max="100" step="0.01" value={previewRate} onChange={event => setPreviewRate(event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2" /></label>
        {preview && <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950 p-3 text-sm"><div className="flex justify-between"><span>Principal</span><span>{money(preview.principalMinor)}</span></div><div className="flex justify-between"><span>Combined provider charges</span><span>{money(preview.providerChargesMinor)}</span></div><div className="flex justify-between font-semibold"><span>{transactionType === 'deposit' ? 'Total to pay' : 'Total account debit'}</span><span>{money(transactionType === 'deposit' ? preview.totalCustomerChargeMinor : preview.totalAccountDebitMinor)}</span></div><div className="text-xs text-slate-500">Member receives {money(preview.memberAmountPaidMinor ?? preview.memberAmountCreditedMinor)} · wallet {transactionType === 'deposit' ? 'credit' : 'deduction'} {money(preview.expectedWalletCreditMinor ?? preview.expectedWalletDeductionMinor)}</div></div>}
      </div>
    </section>
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Version history</h2><p className="mt-1 text-xs text-slate-500">{scope === 'organization' ? 'Organization-specific Xhenvolt overrides' : `${component} ${transactionType} schedules`}</p></div><button onClick={load} className="rounded border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">Refresh</button></div>
      {loading ? <p className="mt-4 text-sm text-slate-400">Loading schedules…</p> : records.length === 0 ? <p className="mt-4 text-sm text-slate-400">No versions configured yet.</p> : <div className="mt-4 divide-y divide-slate-800">{records.map(row => <div key={row.id} className="grid gap-2 py-3 text-sm sm:grid-cols-[1fr_auto]"><div><div className="font-medium">{row.scope === 'organization' ? row.organization_name : 'Platform default'} · version {row.version}</div><div className="text-xs text-slate-400">{row.enabled ? `${(row.basis_points / 100).toFixed(2)}%` : 'Disabled'} · from {new Date(row.effective_from).toLocaleString()}{row.effective_to ? ` · until ${new Date(row.effective_to).toLocaleString()}` : ''}</div><div className="mt-1 text-xs text-slate-500">{row.change_reason}</div></div><span className="h-fit rounded border border-slate-700 px-2 py-1 text-xs text-slate-400">{row.transaction_type}</span></div>)}</div>}
    </section>
  </div>;
}
