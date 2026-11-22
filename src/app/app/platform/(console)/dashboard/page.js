'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowDownRight, ArrowUpRight, Building2, RefreshCw, Users, Wallet } from 'lucide-react';

const money = (n, currency = 'UGX') => new Intl.NumberFormat('en-UG', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n || 0));
function Metric({ title, value, icon: Icon, detail }) {
  return <article className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="flex items-center justify-between text-xs text-slate-400"><span>{title}</span><Icon className="h-4 w-4 text-indigo-300" /></div><div className="mt-2 text-2xl font-bold tabular-nums text-slate-100">{value}</div>{detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}</article>;
}

export default function PlatformDashboardPage() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/platform/dashboard', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Dashboard unavailable');
      setMetrics(result.metrics); setError('');
    } catch (err) { setError(err.message || 'Dashboard unavailable'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  const institutions = metrics?.institutions || {};
  return <div className="mx-auto max-w-7xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Xhenvolt · Xhaira</div><h1 className="mt-1 text-2xl font-bold">Platform overview</h1><p className="mt-1 text-sm text-slate-400">Cross institution operations, financial activity, and platform support.</p></div><button onClick={load} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button></header>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title="Registered institutions" value={institutions.total ?? '—'} detail={`${institutions.new_30d ?? 0} added in the last 30 days`} icon={Building2} />
      <Metric title="Active institutions" value={institutions.active ?? '—'} detail={`${institutions.suspended ?? 0} suspended`} icon={Activity} />
      <Metric title="Members" value={metrics?.members?.toLocaleString() ?? '—'} detail={`${metrics?.accounts?.toLocaleString() ?? '—'} total accounts`} icon={Users} />
      <Metric title="Outstanding loans" value={money(metrics?.loans?.outstanding_amount)} detail={`${metrics?.loans?.outstanding_count ?? 0} active or approved`} icon={Wallet} />
    </section>
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><h2 className="font-semibold">Transaction activity by currency</h2><p className="mt-1 text-xs text-slate-500">Volume counts money movement. It is not institutional income.</p>{(metrics?.transactions || []).length ? <div className="mt-4 space-y-3">{metrics.transactions.map(row => <div key={row.currency} className="rounded-lg border border-slate-800 p-3"><div className="flex justify-between text-sm"><span className="font-semibold">{row.currency}</span><span className="text-slate-400">{Number(row.deposit_count || 0) + Number(row.withdrawal_count || 0)} deposit and withdrawal entries</span></div><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><div className="flex items-center gap-1 text-xs text-emerald-300"><ArrowDownRight className="h-3.5 w-3.5" /> Deposits</div><div className="mt-1 font-semibold">{money(row.deposits, row.currency)}</div></div><div><div className="flex items-center gap-1 text-xs text-rose-300"><ArrowUpRight className="h-3.5 w-3.5" /> Withdrawals</div><div className="mt-1 font-semibold">{money(row.withdrawals, row.currency)}</div></div><div><div className="text-xs text-slate-500">Combined ledger volume</div><div className="mt-1">{money(row.transaction_volume, row.currency)}</div></div><div><div className="text-xs text-slate-500">Net cash movement</div><div className="mt-1">{money(row.net_movement, row.currency)}</div></div></div></div>)}</div> : <p className="mt-5 text-sm text-slate-500">No ledger activity recorded.</p>}</div>
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4"><h2 className="font-semibold">Platform revenue &amp; support</h2><p className="mt-1 text-xs text-slate-500">Only recorded transaction charges and approved platform operations appear here.</p><div className="mt-4 space-y-3">{(metrics?.revenue?.fees_by_currency || []).map(row => <div key={`fees-${row.currency}`} className="flex items-center justify-between rounded-lg border border-slate-800 p-3"><span className="text-sm text-slate-300">Xhenvolt transaction charges · {row.currency}</span><span className="font-semibold">{money(row.transaction_fees, row.currency)}</span></div>)}{(metrics?.revenue?.operations_by_currency || []).map(row => <div key={`ops-${row.currency}`} className="rounded-lg border border-slate-800 p-3"><div className="mb-2 text-sm font-semibold">Approved platform operations · {row.currency}</div><div className="grid grid-cols-1 gap-1 text-sm text-slate-300 sm:grid-cols-3"><span>Service revenue {money(row.other_revenue, row.currency)}</span><span>Support spend {money(row.operational_spend, row.currency)}</span><span>Net advances {money(row.outstanding_advances, row.currency)}</span></div></div>)}{!(metrics?.revenue?.operations_by_currency || []).length && <p className="text-sm text-slate-500">No platform operations have been approved.</p>}</div></div>
    </section>
    <section className="grid grid-cols-1 gap-3 md:grid-cols-3"><Link href="/app/platform/institutions" className="rounded-xl border border-slate-800 bg-slate-900 p-4 hover:border-indigo-700"><div className="font-semibold">Institution directory</div><p className="mt-1 text-xs text-slate-500">Search, inspect, suspend, and reactivate institutions.</p></Link><Link href="/app/platform/transactions" className="rounded-xl border border-slate-800 bg-slate-900 p-4 hover:border-indigo-700"><div className="font-semibold">Transaction monitoring</div><p className="mt-1 text-xs text-slate-500">Filter financial activity by institution, date, account, and status.</p></Link><Link href="/app/platform/funding" className="rounded-xl border border-slate-800 bg-slate-900 p-4 hover:border-indigo-700"><div className="font-semibold">Funding &amp; settlements</div><p className="mt-1 text-xs text-slate-500">Submit institution funding and operational support for independent review.</p></Link></section>
  </div>;
}
