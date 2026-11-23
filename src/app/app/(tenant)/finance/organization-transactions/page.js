'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency } from '@/lib/format-currency';
import { usePermissions } from '@/components/providers/PermissionProvider';
import Link from 'next/link';

const today = () => new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
const blankForm = () => ({ action: 'deposit', account_id: '', amount: '', paid_by: '', withdrawn_to: '', phone: '', reason: '', classification: '', payment_method: 'cash', external_reference: '', transaction_date: today(), notes: '' });

export default function OrganizationTransactionsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('finance.manage');
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(blankForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filterType, setFilterType] = useState('');
  const [paymentIntent, setPaymentIntent] = useState(null);
  const requestKey = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountResponse, transactionResponse] = await Promise.all([
        fetchWithAuth('/api/accounts'),
        fetchWithAuth(`/api/finance/organization-transactions${filterType ? `?type=${filterType}` : ''}`),
      ]);
      const [accountJson, transactionJson] = await Promise.all([accountResponse.json(), transactionResponse.json()]);
      if (!accountResponse.ok || !accountJson.success) throw new Error(accountJson.error || 'Unable to load organization accounts');
      if (!transactionResponse.ok || !transactionJson.success) throw new Error(transactionJson.error || 'Unable to load transactions');
      setAccounts((accountJson.data || []).filter(account => account.is_active && account.status === 'active'));
      setRows(transactionJson.data || []);
      const pendingIntents = transactionJson.mobile_money_pending || [];
      setPaymentIntent(current => {
        const matching = pendingIntents.find(intent => intent.id === current?.id);
        if (matching) return matching;
        if (current && !['settled', 'failed', 'expired'].includes(current.status)) return current;
        return pendingIntents[0] || null;
      });
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to load organization transactions');
    } finally {
      setLoading(false);
    }
  }, [filterType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!paymentIntent?.id || ['settled', 'failed', 'expired'].includes(paymentIntent.status)) return undefined;
    let active = true;
    const check = async () => {
      try {
        const response = await fetchWithAuth(`/api/finance/organization-transactions/${paymentIntent.id}`);
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Could not check MarzPay status');
        if (!active) return;
        setPaymentIntent(result.data);
        if (result.data.status === 'settled') await load();
      } catch (err) {
        if (active) setError(err.message || 'Could not check MarzPay status');
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [paymentIntent?.id, paymentIntent?.status, load]);

  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    const payload = { ...form, amount: String(form.amount).trim() };
    const fingerprint = JSON.stringify(payload);
    if (!requestKey.current || requestKey.current.fingerprint !== fingerprint) {
      requestKey.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      const response = await fetchWithAuth('/api/finance/organization-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey.current.key },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to record transaction');
      requestKey.current = null;
      if (result.mobile_money) {
        setPaymentIntent(result.data);
        setNotice(result.duplicate
          ? 'This MarzPay request already exists; its confirmation status is shown below.'
          : 'MarzPay request sent. The organization ledger updates only after provider confirmation.');
      } else {
        setNotice(result.duplicate ? 'This transaction was already recorded.' : `${form.action === 'deposit' ? 'Deposit' : 'Withdrawal'} recorded.`);
      }
      setForm(blankForm());
      await load();
    } catch (err) {
      setError(err.message || 'Unable to record transaction');
    } finally {
      setSaving(false);
    }
  }

  const byLabel = form.action === 'deposit' ? 'Paid by (optional)' : 'Recipient / withdrawn to (optional)';
  const byKey = form.action === 'deposit' ? 'paid_by' : 'withdrawn_to';

  async function checkPaymentStatus() {
    if (!paymentIntent?.id) return;
    try {
      const response = await fetchWithAuth(`/api/finance/organization-transactions/${paymentIntent.id}`);
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not check MarzPay status');
      setPaymentIntent(result.data);
      if (result.data.status === 'settled') await load();
    } catch (err) {
      setError(err.message || 'Could not check MarzPay status');
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Organization deposits &amp; withdrawals</h1>
        <p className="mt-1 text-sm text-muted-foreground">Record money received or paid directly by the institution from its own account.</p>
      </header>

      {canManage && <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Transaction type">
          {['deposit', 'withdrawal'].map(action => (
            <button key={action} type="button" onClick={() => { update('action', action); update('paid_by', ''); update('withdrawn_to', ''); }}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${form.action === action ? 'bg-blue-600 text-white' : 'border border-border text-foreground hover:bg-muted'}`}>
              {action === 'deposit' ? <ArrowDownToLine className="h-4 w-4" /> : <ArrowUpFromLine className="h-4 w-4" />}
              {action === 'deposit' ? 'Deposit' : 'Withdrawal'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm text-muted-foreground">Organization account *
            <select required value={form.account_id} onChange={e => update('account_id', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground">
              <option value="">Select account</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {formatCurrency(account.balance, account.currency)}</option>)}
            </select>
          </label>
          <label className="text-sm text-muted-foreground">Amount *
            <input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={form.amount} onChange={e => update('amount', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder="0.00" />
          </label>
          <label className="text-sm text-muted-foreground">{byLabel}
            <input maxLength={255} value={form[byKey]} onChange={e => update(byKey, e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder={form.action === 'deposit' ? 'Person or organization paying' : 'Person or organization receiving'} />
          </label>
          <label className="text-sm text-muted-foreground">Reason *
            <input required maxLength={1000} value={form.reason} onChange={e => update('reason', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder="Why was this money received or paid?" />
          </label>
          <label className="text-sm text-muted-foreground">Classification (optional)
            <input maxLength={100} value={form.classification} onChange={e => update('classification', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder="Grant, donation, loan, transfer…" />
          </label>
          <label className="text-sm text-muted-foreground">Payment method
            <select value={form.payment_method} onChange={e => update('payment_method', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground">
              <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="mobile_money">MarzPay mobile money</option><option value="cheque">Cheque</option><option value="other">Other</option>
            </select>
          </label>
          {form.payment_method === 'mobile_money' && <label className="text-sm text-muted-foreground">Mobile-money phone number *
            <input required inputMode="tel" autoComplete="tel" value={form.phone} onChange={e => update('phone', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder="07xx xxx xxx" />
          </label>}
          <label className="text-sm text-muted-foreground">Transaction date *
            <input required type="date" value={form.transaction_date} onChange={e => update('transaction_date', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="text-sm text-muted-foreground">External reference (optional)
            <input maxLength={255} value={form.external_reference} onChange={e => update('external_reference', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" placeholder="Bank, cheque, or provider reference" />
          </label>
          <label className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">Notes (optional)
            <textarea maxLength={2000} rows={2} value={form.notes} onChange={e => update('notes', e.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
          </label>
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p>}
        <button disabled={saving || accounts.length === 0} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? 'Saving…' : `Record ${form.action}`}
        </button>
        {accounts.length === 0 && <p className="text-sm text-muted-foreground">Create or activate an organization account before recording transactions.</p>}
      </form>}

      {paymentIntent && <section className="rounded-xl border border-border bg-card p-4" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">MarzPay {paymentIntent.direction === 'collection' ? 'deposit' : 'withdrawal'}</h2>
            <p className="mt-1 text-sm text-muted-foreground">UGX {formatCurrency(paymentIntent.amount_minor || 0, 'UGX')} · {paymentIntent.status || 'processing'}{paymentIntent.provider_status ? ` · Provider: ${paymentIntent.provider_status}` : ''}</p>
            {paymentIntent.failure_reason && <p className="mt-1 text-sm text-amber-700">{paymentIntent.failure_reason}</p>}
            {paymentIntent.reconciliation_error && <p className="mt-1 text-sm text-amber-700">{paymentIntent.reconciliation_error}</p>}
            {paymentIntent.status !== 'settled' && <p className="mt-1 text-xs text-muted-foreground">The organization transaction is posted only after MarzPay confirms it.</p>}
          </div>
          <button type="button" onClick={checkPaymentStatus} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted">Check status</button>
        </div>
      </section>}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div><h2 className="font-semibold text-foreground">Organization account activity</h2><p className="text-xs text-muted-foreground">Recorded by is the authenticated staff member who submitted the transaction.</p></div>
          <div className="flex items-center gap-2">
            <select aria-label="Filter transaction type" value={filterType} onChange={e => setFilterType(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
              <option value="">All transactions</option><option value="deposit">Deposits</option><option value="withdrawal">Withdrawals</option>
            </select>
            <button onClick={load} className="rounded-lg border border-border p-2 text-foreground hover:bg-muted" aria-label="Refresh transactions"><RefreshCw className="h-4 w-4" /></button>
          </div>
        </div>
        {loading ? <div className="p-10 text-center text-sm text-muted-foreground">Loading transactions…</div> : rows.length === 0 ? <div className="p-10 text-center text-sm text-muted-foreground">No organization deposits or withdrawals yet.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Type / reason</th><th className="px-4 py-3">Paid by / recipient</th><th className="px-4 py-3">Account</th><th className="px-4 py-3">Recorded by</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Receipt</th></tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map(row => <tr key={row.id} className="align-top">
                  <td className="px-4 py-3 text-muted-foreground">{row.entry_date || row.metadata?.transaction_date}</td>
                  <td className="px-4 py-3"><span className={`mr-2 rounded-full px-2 py-0.5 text-xs capitalize ${row.transaction_type === 'deposit' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>{row.transaction_type}</span><span className="block pt-1 text-foreground">{row.metadata?.reason || row.description}</span>{row.metadata?.classification && <span className="block pt-1 text-xs text-muted-foreground">{row.metadata.classification}</span>}</td>
                  <td className="px-4 py-3 text-foreground">{row.metadata?.paid_by || row.metadata?.withdrawn_to || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.account_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.recorded_by || row.recorded_by_email || '—'}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${row.transaction_type === 'deposit' ? 'text-emerald-600' : 'text-rose-600'}`}>{formatCurrency(row.amount, row.currency)}</td>
                  <td className="px-4 py-3"><Link href={`/api/receipts/${encodeURIComponent(row.receipt_number || `RCP-${String(row.id).replace(/-/g, '').toUpperCase()}`)}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">View / print</Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
