'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';

const empty = { name: '', email: '', password: '', confirm_password: '', bootstrap_secret: '' };

export default function PlatformLoginPage() {
  const router = useRouter();
  const [state, setState] = useState({ loading: true, setup: false, available: false, authenticated: false });
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/platform/auth', { cache: 'no-store' }).then(r => r.json()).then(result => {
      setState({ loading: false, setup: !!result.setup_required, available: !!result.setup_available, authenticated: !!result.authenticated });
      if (result.authenticated) router.replace('/platform/dashboard');
    }).catch(() => setState({ loading: false, setup: false, available: false, authenticated: false }));
  }, [router]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/platform/auth', {
        method: state.setup ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(form),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Sign in failed');
      router.replace('/platform/dashboard');
    } catch (err) { setError(err.message || 'Platform sign in failed'); }
    finally { setBusy(false); }
  }

  const input = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30';
  if (state.loading) return <div className="flex min-h-screen items-center justify-center bg-slate-950"><Loader2 className="h-7 w-7 animate-spin text-indigo-400" /></div>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-7 shadow-2xl">
        <div className="text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-indigo-400" />
          <div className="mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Xhenvolt</div>
          <h1 className="mt-1 text-xl font-bold">Platform Control Panel</h1>
          <p className="mt-2 text-sm text-slate-400">Separate administrator sign in. Institution accounts cannot sign in here.</p>
        </div>
        {state.setup ? <>
          <label className="block space-y-1 text-xs text-slate-300">First administrator name<input required minLength={2} maxLength={160} className={input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label className="block space-y-1 text-xs text-slate-300">Administrator email<input required type="email" maxLength={254} autoComplete="username" className={input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label className="block space-y-1 text-xs text-slate-300">Password (12 characters minimum)<input required type="password" minLength={12} maxLength={200} autoComplete="new-password" className={input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
          <label className="block space-y-1 text-xs text-slate-300">Confirm password<input required type="password" minLength={12} maxLength={200} autoComplete="new-password" className={input} value={form.confirm_password} onChange={e => setForm({ ...form, confirm_password: e.target.value })} /></label>
          <label className="block space-y-1 text-xs text-slate-300">Deployment bootstrap secret<input required type="password" autoComplete="off" className={input} value={form.bootstrap_secret} onChange={e => setForm({ ...form, bootstrap_secret: e.target.value })} /></label>
          {!state.available && <p className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-200">Initial setup is disabled until <code>XHAIRA_PLATFORM_BOOTSTRAP_SECRET</code> is configured on the server.</p>}
        </> : <>
          <label className="block space-y-1 text-xs text-slate-300">Email<input required type="email" autoComplete="username" className={input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label className="block space-y-1 text-xs text-slate-300">Password<input required type="password" autoComplete="current-password" className={input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
        </>}
        {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-200">{error}</p>}
        <button disabled={busy || (state.setup && !state.available)} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}{state.setup ? 'Create first platform administrator' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
