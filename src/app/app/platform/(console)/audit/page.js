'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

export default function PlatformAuditPage() {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetch(`/api/platform/audit?page=${page}&limit=${limit}`, { cache: 'no-store' }).then(r => r.json());
      if (!result.success) throw new Error(result.error || 'Audit trail unavailable');
      setRows(result.data || []); setError('');
    } catch (err) { setError(err.message || 'Audit trail unavailable'); }
    finally { setLoading(false); }
  }, [page, limit]);
  useEffect(() => { load(); }, [load]);
  return <div className="mx-auto max-w-7xl space-y-5">
    <header className="flex items-start justify-between gap-3"><div><h1 className="text-2xl font-bold">Platform audit trail</h1><p className="mt-1 text-sm text-slate-400">Append-only record of platform sign-ins, institution controls, and operations approvals.</p></div><button onClick={load} aria-label="Refresh audit trail" className="rounded-lg border border-slate-700 p-2"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></header>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900"><div className="divide-y divide-slate-800">{loading ? <div className="p-10 text-center text-sm text-slate-400">Loading audit events…</div> : rows.length ? rows.map(row => <article key={row.id} className="grid grid-cols-1 gap-2 p-4 md:grid-cols-[180px_190px_1fr]"><div className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString()}</div><div><div className="text-sm font-semibold">{row.action.replaceAll('_', ' ')}</div><div className="text-xs text-slate-500">{row.administrator_name || 'System'} · {row.administrator_email || '—'}</div></div><div className="min-w-0"><div className="text-xs text-slate-400">{row.entity_type}{row.entity_id ? ` · ${row.entity_id}` : ''}{row.ip_address ? ` · ${row.ip_address}` : ''}</div><pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-slate-500">{JSON.stringify(row.details || {}, null, 2)}</pre></div></article>) : <div className="p-10 text-center text-sm text-slate-500">No audit events.</div>}</div><footer className="flex items-center justify-end gap-3 border-t border-slate-800 p-3"><button disabled={page <= 1} onClick={() => setPage(v => v - 1)} className="rounded-lg border border-slate-700 p-2 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button><span className="text-xs text-slate-400">Page {page}</span><button disabled={rows.length < limit} onClick={() => setPage(v => v + 1)} className="rounded-lg border border-slate-700 p-2 disabled:opacity-40" aria-label="Next page"><ChevronRight className="h-4 w-4" /></button></footer></section>
  </div>;
}
