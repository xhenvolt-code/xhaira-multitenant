'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const fresh = () => ({ institution_id: '', operation_type: 'operational_expense', category: 'technical_support', amount: '', currency: 'UGX', purpose: '', accounting_treatment: '', institution_account_id: '', supporting_document_url: '' });
const roles = [
  ['institution_deposit', 'Deposit into institution account'],
  ['operational_expense', 'Xhenvolt operational expense'],
  ['operational_advance', 'Operational advance'],
  ['reimbursement', 'Institution reimbursement'],
  ['platform_revenue', 'Xhenvolt service revenue'],
  ['other', 'Other platform operation'],
];
const money = (value, currency = 'UGX') => new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));

export default function PlatformFundingPage() {
  const [institutions, setInstitutions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(fresh);
  const [decision, setDecision] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const key = useRef(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [orgResponse, opsResponse] = await Promise.all([fetch('/api/platform/institutions?limit=100', { cache: 'no-store' }), fetch('/api/platform/funding', { cache: 'no-store' })]);
      const [orgJson, opsJson] = await Promise.all([orgResponse.json(), opsResponse.json()]);
      if (!orgResponse.ok || !orgJson.success) throw new Error(orgJson.error || 'Could not load institutions');
      if (!opsResponse.ok || !opsJson.success) throw new Error(opsJson.error || 'Could not load operations');
      setInstitutions(orgJson.data || []); setRows(opsJson.data || []); setError('');
    } catch (err) { setError(err.message || 'Funding data unavailable'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    setAccounts([]);
    if (!form.institution_id) return;
    fetch(`/api/platform/institutions/${form.institution_id}`, { cache: 'no-store' }).then(r => r.json()).then(result => {
      if (!cancelled && result.success) setAccounts(result.data?.accounts || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [form.institution_id]);

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const payload = { ...form, amount: String(form.amount).trim() };
    const fingerprint = JSON.stringify(payload);
    if (!key.current || key.current.fingerprint !== fingerprint) key.current = { fingerprint, value: crypto.randomUUID() };
    try {
      const response = await fetch('/api/platform/funding', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key.current.value }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not submit operation');
      key.current = null; setForm(fresh()); setMessage('Operation submitted for independent approval.'); await loadAll();
    } catch (err) { setError(err.message || 'Could not submit operation'); }
    finally { setBusy(false); }
  }

  async function decide(row, outcome) {
    const reason = decision[row.id]?.reason?.trim();
    if (!reason) return setError('Add an approval or rejection reason first.');
    if (!window.confirm(`${outcome === 'approve' ? 'Approve' : 'Reject'} this ${row.operation_type.replaceAll('_', ' ')} request?`)) return;
    setError(''); setMessage('');
    try {
      const response = await fetch(`/api/platform/funding/${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: outcome, reason }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not record decision');
      setMessage(`Operation ${result.status}.`); await loadAll();
    } catch (err) { setError(err.message || 'Could not record decision'); }
  }

  const input = 'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100';
  return <div className="mx-auto max-w-7xl space-y-5">
    <header><h1 className="text-2xl font-bold">Platform funding &amp; settlements</h1><p className="mt-1 text-sm text-slate-400">Track Xhenvolt operational support separately from institution books. Institution deposits require an institution owned account and create a ledger entry after approval.</p></header>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}{message && <p role="status" className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{message}</p>}
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-xs text-slate-400">Institution *<select required className={input} value={form.institution_id} onChange={e => setForm(v => ({ ...v, institution_id: e.target.value, institution_account_id: '' }))}><option value="">Select institution</option>{institutions.map(org => <option key={org.id} value={org.id}>{org.name} · {org.status}</option>)}</select></label>
      <label className="text-xs text-slate-400">Operation type *<select className={input} value={form.operation_type} onChange={e => setForm(v => ({ ...v, operation_type: e.target.value, institution_account_id: '' }))}>{roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-xs text-slate-400">Category *<input required maxLength={80} className={input} value={form.category} onChange={e => setForm(v => ({ ...v, category: e.target.value }))} placeholder="SMS, field_visit, support" /></label>
      <label className="text-xs text-slate-400">Amount *<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" className={input} value={form.amount} onChange={e => setForm(v => ({ ...v, amount: e.target.value }))} /></label>
      <label className="text-xs text-slate-400">Currency *<select className={input} value={form.currency} onChange={e => setForm(v => ({ ...v, currency: e.target.value }))}>{['UGX','USD','KES','TZS','RWF','EUR','GBP'].map(c => <option key={c}>{c}</option>)}</select></label>
      {form.operation_type === 'institution_deposit' && <label className="text-xs text-slate-400">Institution account *<select required className={input} value={form.institution_account_id} onChange={e => setForm(v => ({ ...v, institution_account_id: e.target.value }))}><option value="">Select destination account</option>{accounts.filter(a => a.currency === form.currency).map(a => <option key={a.account_id} value={a.account_id}>{a.name} · {a.type} · {money(a.balance, a.currency)}</option>)}</select></label>}
      <label className="text-xs text-slate-400 sm:col-span-2">Purpose / reason *<textarea required maxLength={2000} rows={2} className={input} value={form.purpose} onChange={e => setForm(v => ({ ...v, purpose: e.target.value }))} /></label>
      <label className="text-xs text-slate-400 sm:col-span-1">Accounting treatment *<input required maxLength={1000} className={input} value={form.accounting_treatment} onChange={e => setForm(v => ({ ...v, accounting_treatment: e.target.value }))} placeholder="e.g. platform-paid SMS service; institution restricted grant" /></label>
      <label className="text-xs text-slate-400 lg:col-span-2">Supporting document link (optional)<input type="url" maxLength={2000} className={input} value={form.supporting_document_url} onChange={e => setForm(v => ({ ...v, supporting_document_url: e.target.value }))} placeholder="https://…" /></label>
      {form.operation_type === 'institution_deposit' && <p className="rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-xs text-amber-200 sm:col-span-2 lg:col-span-3">The current Xhaira cashbook stores an accounting treatment label but has no full income/liability/equity chart of accounts. This records the cash movement, not a balanced classified journal.</p>}
      {form.operation_type !== 'institution_deposit' && <p className="rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs text-slate-400 sm:col-span-2 lg:col-span-3">Submitting records a platform operation for independent review. Approval records the settlement classification; it does not send money to a payment provider.</p>}
      <button disabled={busy} className="w-fit rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Submitting…' : 'Submit for approval'}</button>
    </form>
    <section className="space-y-3"><div><h2 className="text-lg font-semibold">Operation register &amp; approvals</h2><p className="mt-1 text-xs text-slate-500">The submitting administrator cannot approve their own request.</p></div>{loading ? <p className="p-8 text-center text-sm text-slate-400">Loading operations…</p> : rows.length === 0 ? <p className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-500">No platform operations recorded.</p> : <div className="space-y-3">{rows.map(row => <article key={row.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-semibold">{row.institution_name} · {row.category.replaceAll('_', ' ')}</div><div className="mt-1 text-xs text-slate-500">{row.operation_type.replaceAll('_', ' ')} · Requested by {row.requested_by_name} · {new Date(row.created_at).toLocaleString()}</div><div className="mt-2 text-sm">{row.purpose}</div><div className="mt-1 text-xs text-slate-400">Treatment: {row.accounting_treatment}{row.institution_account_name ? ` · Account: ${row.institution_account_name}` : ''}</div><div className="mt-2 text-lg font-bold">{money(row.amount, row.currency)}</div>{row.decision_reason && <div className="mt-2 text-xs text-slate-400">Decision: {row.decision_reason} · {row.approved_by_name || 'Administrator'}</div>}</div><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${row.status === 'approved' ? 'bg-emerald-500/15 text-emerald-300' : row.status === 'pending' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700 text-slate-300'}`}>{row.status}</span></div>{row.status === 'pending' && <div className="mt-4 flex flex-col gap-2 sm:flex-row"><input value={decision[row.id]?.reason || ''} onChange={e => setDecision(v => ({ ...v, [row.id]: { reason: e.target.value } }))} placeholder="Approval or rejection reason" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs" /><button onClick={() => decide(row, 'approve')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold hover:bg-emerald-600">Approve</button><button onClick={() => decide(row, 'reject')} className="rounded-lg border border-rose-800 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-950/50">Reject</button></div>}</article>)}</div>}</section>
  </div>;
}
