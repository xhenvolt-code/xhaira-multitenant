'use client';

import { useCallback, useEffect, useState } from 'react';

const empty = { name: '', email: '', password: '', role: 'viewer' };

export default function PlatformAdministratorsPage() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/platform/administrators', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Administrator management unavailable');
      setRows(result.data || []); setError('');
    } catch (err) { setError(err.message || 'Administrator management unavailable'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/platform/administrators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not create administrator');
      setForm(empty); setMessage('Platform administrator created. Share the temporary password through a secure channel.'); await load();
    } catch (err) { setError(err.message || 'Could not create administrator'); }
    finally { setBusy(false); }
  }
  async function changeStatus(user, status) {
    if (!window.confirm(`${status === 'active' ? 'Reactivate' : 'Suspend'} access for ${user.email}?`)) return;
    setError(''); setMessage('');
    try {
      const response = await fetch('/api/platform/administrators', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: user.id, status }) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not update administrator');
      setMessage(`Administrator ${status}.`); await load();
    } catch (err) { setError(err.message || 'Could not update administrator'); }
  }
  const input = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100';
  return <div className="mx-auto max-w-6xl space-y-5">
    <header><h1 className="text-2xl font-bold">Platform administrators</h1><p className="mt-1 text-sm text-slate-400">Separate platform identities, roles, and sessions. Institution users cannot be promoted here.</p></header>
    {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}{message && <p role="status" className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{message}</p>}
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 lg:grid-cols-5"><label className="text-xs text-slate-400">Name<input required minLength={2} maxLength={160} className={input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label className="text-xs text-slate-400">Email<input required type="email" className={input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label><label className="text-xs text-slate-400">Initial password<input required type="password" minLength={12} maxLength={200} className={input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label><label className="text-xs text-slate-400">Role<select className={input} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="viewer">Viewer · read only</option><option value="analyst">Analyst · read only</option><option value="super_admin">Super admin · sensitive actions</option></select></label><button disabled={busy} className="self-end rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Creating…' : 'Create administrator'}</button></form>
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900"><div className="divide-y divide-slate-800">{loading ? <div className="p-10 text-center text-sm text-slate-400">Loading administrators…</div> : rows.map(user => <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><div className="font-medium">{user.name}</div><div className="text-xs text-slate-500">{user.email} · {user.role.replaceAll('_', ' ')} · Last login {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'never'}</div></div><div className="flex items-center gap-2"><span className="text-xs capitalize text-slate-400">{user.status}</span><button onClick={() => changeStatus(user, user.status === 'active' ? 'suspended' : 'active')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800">{user.status === 'active' ? 'Suspend' : 'Reactivate'}</button></div></div>)}</div></section>
    <p className="text-xs text-amber-200">Funding submissions and institutional status changes require a platform super admin. Platform funding approvals require a different super admin from the person who submitted them.</p>
  </div>;
}
