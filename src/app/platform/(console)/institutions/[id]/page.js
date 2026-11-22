'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';

const money = (amount, currency = 'UGX') => new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0));
const moneyByCurrency = values => Object.entries(values || {}).map(([currency, amount]) => `${currency} ${Number(amount || 0).toLocaleString()}`).join(' · ') || '—';

export default function InstitutionDetailPage({ params }) {
  const [id, setId] = useState('');
  const [data, setData] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { Promise.resolve(params).then(value => setId(value.id)); }, [params]);
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/platform/institutions/${id}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Institution unavailable');
      setData(result.data); setError('');
    } catch (err) { setError(err.message || 'Institution unavailable'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function changeStatus() {
    if (!data || !reason.trim()) return setError('Enter the reason for the status change.');
    const status = data.status === 'active' ? 'suspended' : 'active';
    if (!window.confirm(`${status === 'suspended' ? 'Suspend' : 'Reactivate'} ${data.name}? ${status === 'suspended' ? 'Active institution sessions will be revoked.' : ''}`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/platform/institutions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, reason }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not update institution');
      setReason(''); setMessage(`Institution ${status === 'suspended' ? 'suspended' : 'reactivated'}.`); await load();
    } catch (err) { setError(err.message || 'Could not update institution'); }
    finally { setBusy(false); }
  }

  if (loading && !data) return <div className="p-8 text-sm text-slate-400">Loading institution…</div>;
  return <div className="mx-auto max-w-6xl space-y-5">
    <Link href="/platform/institutions" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Institution directory</Link>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{message}</p>}
    {data && <>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5"><div><div className="text-xs uppercase tracking-wider text-slate-500">{data.institution_type || 'Institution'} · {data.institution_code}</div><h1 className="mt-1 text-2xl font-bold">{data.name}</h1><p className="mt-1 text-sm text-slate-400">Registered {new Date(data.created_at).toLocaleDateString()} · Last activity {data.last_activity ? new Date(data.last_activity).toLocaleString() : 'none'}</p></div><div className="flex items-center gap-2"><span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase ${data.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{data.status}</span><button onClick={load} aria-label="Refresh institution" className="rounded-lg border border-slate-700 p-2"><RefreshCw className="h-4 w-4" /></button></div></header>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4"><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-500">Members</div><div className="mt-1 text-xl font-bold">{Number(data.member_count).toLocaleString()}</div></div><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-500">Accounts</div><div className="mt-1 text-xl font-bold">{Number(data.account_count).toLocaleString()}</div></div><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-500">Deposit entries</div><div className="mt-1 text-xl font-bold">{Number(data.deposit_count).toLocaleString()}</div><div className="text-xs text-slate-400">{moneyByCurrency(data.deposits_by_currency)}</div></div><div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-500">Withdrawal entries</div><div className="mt-1 text-xl font-bold">{Number(data.withdrawal_count).toLocaleString()}</div><div className="text-xs text-slate-400">{moneyByCurrency(data.withdrawals_by_currency)}</div></div></section>
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4"><h2 className="font-semibold">Institution account balances</h2><p className="mt-1 text-xs text-slate-500">Account balances are listed separately by account and currency. They are not presented as cash or institutional equity.</p><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{(data.accounts || []).map(account => <div key={account.account_id} className="rounded-lg border border-slate-800 p-3"><div className="flex items-start justify-between gap-2"><div className="font-medium">{account.name}</div><span className="text-[10px] uppercase text-slate-500">{account.type}</span></div><div className="mt-2 text-lg font-bold">{money(account.balance, account.currency)}</div><div className="text-xs text-slate-500">{account.transaction_count} ledger entries</div></div>)}</div>{!data.accounts?.length && <p className="mt-3 text-sm text-slate-500">No accounts found.</p>}</section>
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4"><h2 className="font-semibold">Institution status</h2><p className="mt-1 text-xs text-slate-500">Suspension preserves all institution data and revokes active sessions. The institution can be reactivated later.</p><div className="mt-3 flex flex-col gap-3 sm:flex-row"><input maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="Required audit reason" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" /><button disabled={busy || !reason.trim()} onClick={changeStatus} className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40 ${data.status === 'active' ? 'bg-rose-700 text-white hover:bg-rose-600' : 'bg-emerald-700 text-white hover:bg-emerald-600'}`}>{busy ? 'Saving…' : data.status === 'active' ? 'Suspend institution' : 'Reactivate institution'}</button></div></section>
      <Link href={`/platform/transactions?institution_id=${data.id}`} className="inline-flex rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800">View transaction activity</Link>
    </>}
  </div>;
}
