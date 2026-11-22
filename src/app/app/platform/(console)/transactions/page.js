'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Filter } from 'lucide-react';

function currency(value, code = 'UGX') { return new Intl.NumberFormat('en-UG', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(Number(value || 0)); }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());

export default function PlatformTransactionsPage() {
  const [institutions, setInstitutions] = useState([]);
  const [data, setData] = useState([]);
  const [summary, setSummary] = useState(null);
  const [period, setPeriod] = useState('monthly');
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [filters, setFilters] = useState({ institution_id: '', account_type: '', transaction_type: '', payment_method: '', status: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { fetch('/api/platform/institutions?limit=100', { cache: 'no-store' }).then(r => r.json()).then(j => { if (j.success) setInstitutions(j.data || []); }).catch(() => {}); }, []);
  async function load() {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ period });
      if (period === 'custom') { params.set('from', from); params.set('to', to); }
      Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
      const response = await fetch(`/api/platform/transactions?${params}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Transaction monitoring unavailable');
      setData(result.data || []); setSummary(result.summary); setError('');
    } catch (err) { setError(err.message || 'Transaction monitoring unavailable'); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  function exportCsv() {
    const headers = ['institution', 'transaction_type', 'payment_method', 'status', 'currency', 'transaction_count', 'transaction_volume', 'net_movement', 'deposit_count', 'deposit_amount', 'withdrawal_count', 'withdrawal_amount'];
    const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [headers.join(','), ...data.map(row => headers.map(key => quote(key === 'institution' ? row.institution_name : row[key])).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `xhaira-platform-transactions-${period}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  const summaryCards = (summary || []).flatMap(row => [
    [`Deposits · ${row.currency}`, row.deposit_count, currency(row.deposit_amount, row.currency)],
    [`Withdrawals · ${row.currency}`, row.withdrawal_count, currency(row.withdrawal_amount, row.currency)],
    [`Volume · ${row.currency}`, 'All ledger entries', currency(row.transaction_volume, row.currency)],
    [`Net movement · ${row.currency}`, 'All ledger entries', currency(row.net_movement, row.currency)],
  ]);
  return <div className="mx-auto max-w-7xl space-y-5">
    <header><h1 className="text-2xl font-bold">Institution transaction monitoring</h1><p className="mt-1 text-sm text-slate-400">Transaction volume is money movement, not institutional income. Amount summaries are separated by currency.</p></header>
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center gap-2"><Filter className="h-4 w-4 text-indigo-300" /><select value={period} onChange={e => setPeriod(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="custom">Custom range</option></select>
        {period === 'custom' && <><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" /><input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" /></>}
        <select value={filters.institution_id} onChange={e => setFilters(v => ({ ...v, institution_id: e.target.value }))} className="max-w-64 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All institutions</option>{institutions.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        <select value={filters.account_type} onChange={e => setFilters(v => ({ ...v, account_type: e.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All account types</option>{['bank','cash','mobile_money','investment','system','other'].map(t => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}</select>
        <select value={filters.transaction_type} onChange={e => setFilters(v => ({ ...v, transaction_type: e.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All transaction types</option>{['deposit','withdrawal','payment','expense','transfer_in','transfer_out','loan_disbursement','loan_repayment','fee','interest','adjustment'].map(t => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}</select>
        <select value={filters.payment_method} onChange={e => setFilters(v => ({ ...v, payment_method: e.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All payment methods</option>{['mobile_money','cash','bank_transfer','card','cheque','other','unknown'].map(t => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}</select>
        <select value={filters.status} onChange={e => setFilters(v => ({ ...v, status: e.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"><option value="">All statuses</option>{['settled','processing','review','failed','completed'].map(t => <option key={t} value={t}>{t}</option>)}</select>
        <button onClick={load} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500">Apply filters</button><button onClick={exportCsv} disabled={!data.length} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-sm disabled:opacity-40"><Download className="h-4 w-4" /> CSV</button>
      </div>
    </section>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    {summaryCards.length > 0 && <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">{summaryCards.map(([title, count, amount]) => <div key={title} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-xs text-slate-500">{title}</div><div className="mt-1 text-sm text-slate-400">{count}</div><div className="mt-1 font-bold">{amount}</div></div>)}</section>}
    <section className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900"><table className="w-full min-w-[1100px] text-left text-xs"><thead className="bg-slate-800/60 text-slate-400"><tr>{['Institution','Type','Method','Status','Currency','Count','Volume','Net movement','Deposits','Withdrawals'].map(label => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-800">{loading ? <tr><td colSpan="10" className="p-10 text-center text-slate-400">Loading transactions…</td></tr> : data.length ? data.map((row, index) => <tr key={`${row.institution_id}-${row.transaction_type}-${row.currency}-${index}`}><td className="px-3 py-3"><Link href={`/app/platform/institutions/${row.institution_id}`} className="font-medium hover:text-indigo-300">{row.institution_name}</Link></td><td className="px-3 py-3 capitalize">{row.transaction_type?.replaceAll('_', ' ')}</td><td className="px-3 py-3 capitalize">{row.payment_method?.replaceAll('_', ' ')}</td><td className="px-3 py-3">{row.status}</td><td className="px-3 py-3">{row.currency}</td><td className="px-3 py-3">{row.transaction_count}</td><td className="px-3 py-3">{currency(row.transaction_volume, row.currency)}</td><td className="px-3 py-3">{currency(row.net_movement, row.currency)}</td><td className="px-3 py-3">{row.deposit_count} · {currency(row.deposit_amount, row.currency)}</td><td className="px-3 py-3">{row.withdrawal_count} · {currency(row.withdrawal_amount, row.currency)}</td></tr>) : <tr><td colSpan="10" className="p-10 text-center text-slate-500">No activity in the selected range.</td></tr>}</tbody></table></section>
  </div>;
}
