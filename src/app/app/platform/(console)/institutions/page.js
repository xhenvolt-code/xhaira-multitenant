'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

function formatMoneyMap(value = {}) {
  return Object.entries(value || {}).map(([currency, amount]) => new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0))).join(' · ') || '—';
}

export default function PlatformInstitutionsPage() {
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (query.trim()) params.set('q', query.trim());
      if (status) params.set('status', status);
      const response = await fetch(`/api/platform/institutions?${params}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Institution directory unavailable');
      setRows(result.data || []); setPagination(result.pagination); setError('');
    } catch (err) { setError(err.message || 'Institution directory unavailable'); }
    finally { setLoading(false); }
  }, [page, query, status]);
  useEffect(() => { load(); }, [load]);

  return <div className="mx-auto max-w-7xl space-y-5">
    <header><h1 className="text-2xl font-bold">Institution directory</h1><p className="mt-1 text-sm text-slate-400">Institution records and financial activity across Xhaira.</p></header>
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:flex-row">
      <label className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} placeholder="Search institution name or code" className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm" /></label>
      <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select>
      <div className="self-center px-2 text-xs text-slate-400">{pagination.total?.toLocaleString() || 0} institutions</div>
    </section>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      {loading ? <div className="p-10 text-center text-sm text-slate-400">Loading institutions…</div> : rows.length === 0 ? <div className="p-10 text-center text-sm text-slate-400">No institutions found.</div> : <div className="divide-y divide-slate-800">{rows.map(org => <Link key={org.id} href={`/app/platform/institutions/${org.id}`} className="block p-4 hover:bg-slate-800/40"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-semibold">{org.name}</div><div className="mt-1 text-xs text-slate-500">{org.institution_code} · {org.institution_type || 'Institution'} · Registered {new Date(org.created_at).toLocaleDateString()}</div></div><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${org.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{org.status}</span></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 lg:grid-cols-6"><div><div className="text-slate-500">Members</div><div className="mt-1 font-semibold">{Number(org.member_count).toLocaleString()}</div></div><div><div className="text-slate-500">Accounts</div><div className="mt-1 font-semibold">{Number(org.account_count).toLocaleString()}</div></div><div><div className="text-slate-500">Account balances · by currency</div><div className="mt-1 font-semibold">{formatMoneyMap(org.account_balances_by_currency)}</div></div><div><div className="text-slate-500">Deposits</div><div className="mt-1 font-semibold">{formatMoneyMap(org.deposits)}</div></div><div><div className="text-slate-500">Withdrawals</div><div className="mt-1 font-semibold">{formatMoneyMap(org.withdrawals)}</div></div><div><div className="text-slate-500">Last activity</div><div className="mt-1 font-semibold">{org.last_activity ? new Date(org.last_activity).toLocaleString() : 'No activity'}</div></div></div></Link>)}</div>}
      <footer className="flex items-center justify-end gap-3 border-t border-slate-800 p-3"><button disabled={page <= 1} onClick={() => setPage(v => Math.max(1, v - 1))} className="rounded-lg border border-slate-700 p-2 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button><span className="text-xs text-slate-400">Page {page} of {pagination.totalPages || 1}</span><button disabled={page >= (pagination.totalPages || 1)} onClick={() => setPage(v => v + 1)} className="rounded-lg border border-slate-700 p-2 disabled:opacity-40" aria-label="Next page"><ChevronRight className="h-4 w-4" /></button></footer>
    </section>
  </div>;
}
