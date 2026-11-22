'use client';

import { useEffect, useState } from 'react';
import { CreditCard, Search, Filter, DollarSign, CheckCircle, Clock, Plus, Smartphone } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency } from '@/lib/format-currency';
import Link from 'next/link';
import NewPaymentModal from '@/components/modals/NewPaymentModal';

const PAY_STATUS = { pending: 'bg-yellow-100 text-yellow-700', completed: 'bg-emerald-100 text-emerald-700', failed: 'bg-red-100 text-red-700', refunded: 'bg-muted text-foreground' };

function formatProviderAmount(amount, currency) {
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null;
  return code
    ? formatCurrency(amount, code)
    : `${Number(amount).toLocaleString()} ${currency || 'currency unavailable'}`;
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNewPayment, setShowNewPayment] = useState(false);
  const [collectionMeta, setCollectionMeta] = useState({ configured: false, enabled: false, settlementAccount: null });
  const [collectionIntents, setCollectionIntents] = useState([]);
  const [collectionChecks, setCollectionChecks] = useState({});
  const [collectionCheckErrors, setCollectionCheckErrors] = useState({});
  const [members, setMembers] = useState([]);
  const [memberAccounts, setMemberAccounts] = useState([]);
  const [collectionForm, setCollectionForm] = useState({ memberId: '', memberAccountId: '', phone: '', depositorName: '', reason: '', amountUgx: '' });
  const [collectionIntent, setCollectionIntent] = useState(null);
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [collectionRechecking, setCollectionRechecking] = useState(false);
  const [collectionError, setCollectionError] = useState('');

  useEffect(() => { fetchPayments(); }, [statusFilter]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchWithAuth('/api/payment-collections'),
      fetchWithAuth('/api/members?status=active&limit=100'),
    ]).then(([collection, memberList]) => {
      if (!active) return;
      setCollectionMeta({
        configured: collection.configured === true,
        enabled: collection.enabled === true,
        settlementAccount: collection.settlementAccount || null,
      });
      setCollectionIntents(collection.data || []);
      setMembers(memberList.success ? memberList.data || [] : []);
    }).catch(() => {
      if (active) setCollectionError('Unable to load payment options.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!collectionIntent || ['settled', 'failed', 'expired', 'review'].includes(collectionIntent.status)) return;
    let active = true;
    const timer = setInterval(async () => {
      const current = await fetchWithAuth(`/api/payment-collections/${collectionIntent.id}`);
      if (active && current.success) setCollectionIntent(current.data);
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [collectionIntent]);

  const onMemberChange = async (memberId) => {
    setCollectionForm(form => ({ ...form, memberId, memberAccountId: '' }));
    setMemberAccounts([]);
    if (!memberId) return;
    const result = await fetchWithAuth(`/api/members/${memberId}/accounts`);
    if (result.success) setMemberAccounts((result.data || []).filter(account => account.status === 'active' && account.currency === 'UGX'));
  };

  const startCollection = async (event) => {
    event.preventDefault();
    setCollectionBusy(true);
    setCollectionError('');
    try {
      const idempotencyKey = crypto.randomUUID();
      const result = await fetchWithAuth('/api/payment-collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          amountUgx: Number(collectionForm.amountUgx),
          phone: collectionForm.phone,
          memberAccountId: collectionForm.memberAccountId,
          depositorName: collectionForm.depositorName,
          receiverName: members.find(member => member.id === collectionForm.memberId)?.full_name || '',
          reason: collectionForm.reason,
        }),
      });
      if (!result.success) {
        setCollectionError(result.error || 'Could not start mobile-money collection.');
        return;
      }
      setCollectionIntent({
        id: result.id,
        status: result.status,
        provider_status: result.provider_status,
        amount_minor: result.amountUgx,
        provider_amount_minor: result.provider_amount_minor,
        provider_fee_minor: result.provider_fee_minor,
        ledger_amount_minor: result.ledger_amount_minor,
        provider_currency: result.provider_currency,
        failure_reason: result.failure_reason,
      });
      setCollectionIntents(current => [
        { id: result.id, status: result.status, provider_status: result.provider_status, amount_minor: result.amountUgx, created_at: new Date().toISOString() },
        ...current.filter(intent => intent.id !== result.id),
      ]);
    } catch (error) {
      setCollectionError(error.message || 'Could not start mobile-money collection.');
    } finally {
      setCollectionBusy(false);
    }
  };

  const recheckCollection = async () => {
    if (!collectionIntent?.id) return;
    setCollectionRechecking(true);
    try {
      const result = await fetchWithAuth(`/api/payment-collections/${collectionIntent.id}`);
      if (!result.success) throw new Error(result.error || 'Could not recheck payment status.');
      setCollectionIntent(result.data);
      setCollectionIntents(current => current.map(intent => intent.id === result.data.id ? result.data : intent));
    } catch (error) {
      setCollectionError(error.message || 'Could not recheck payment status.');
    } finally {
      setCollectionRechecking(false);
    }
  };

  const recheckCollectionIntent = async (intentId) => {
    setCollectionChecks(current => ({ ...current, [intentId]: true }));
    setCollectionCheckErrors(current => ({ ...current, [intentId]: '' }));
    try {
      const result = await fetchWithAuth(`/api/payment-collections/${intentId}`);
      if (!result.success) throw new Error(result.error || 'Could not recheck payment status.');
      setCollectionIntents(current => current.map(intent => intent.id === intentId ? result.data : intent));
      if (result.reconciliationError) {
        setCollectionCheckErrors(current => ({ ...current, [intentId]: result.reconciliationError }));
      }
    } catch (error) {
      setCollectionCheckErrors(current => ({ ...current, [intentId]: error.message || 'Could not recheck payment status.' }));
    } finally {
      setCollectionChecks(current => ({ ...current, [intentId]: false }));
    }
  };

  const fetchPayments = async () => {
    try {
      let url = '/api/payments';
      if (statusFilter) url += `?status=${statusFilter}`;
      const res = await fetchWithAuth(url);
      const json = await res.json();
      if (json.success) setPayments(json.data);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const totalCompleted = payments.filter(p => p.status === 'completed').reduce((s, p) => s + parseFloat(p.amount || 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payments</h1>
          <p className="text-sm text-muted-foreground mt-1">{payments.length} payments &middot; UGX {Math.round(totalCompleted).toLocaleString()} completed</p>
        </div>
        <button onClick={() => setShowNewPayment(true)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
          <Plus className="w-4 h-4" /> Record Payment
        </button>
      </div>

      <NewPaymentModal isOpen={showNewPayment} onClose={() => setShowNewPayment(false)} onCreated={() => { setLoading(true); fetchPayments(); }} />

      <section className="space-y-4 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 h-5 w-5 text-emerald-700" />
          <div>
            <h2 className="font-semibold text-foreground">Mobile money collection</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {collectionMeta.enabled ? 'MarzPay collections are ready.' : 'MarzPay is not configured.'}
            </p>
          </div>
        </div>

        {!collectionMeta.enabled && (
          <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            No payment request can be sent until the server explicitly enables MarzPay collections.
          </p>
        )}
        {collectionMeta.enabled && !collectionMeta.settlementAccount && (
          <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Configure an active UGX mobile-money MarzPay settlement account in Settings → SACCO policies before starting collections.
          </p>
        )}

        {collectionError && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{collectionError}</p>}

        <form onSubmit={startCollection} className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="text-sm text-muted-foreground">
            Member
            <select required value={collectionForm.memberId} onChange={event => onMemberChange(event.target.value)} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground">
              <option value="">Select member</option>
              {members.map(member => <option key={member.id} value={member.id}>{member.full_name} ({member.membership_number})</option>)}
            </select>
          </label>
          <label className="text-sm text-muted-foreground">
            Member account
            <select required value={collectionForm.memberAccountId} onChange={event => setCollectionForm(form => ({ ...form, memberAccountId: event.target.value }))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground">
              <option value="">Select active account</option>
              {memberAccounts.map(account => <option key={account.id} value={account.id}>{account.account_number} · {account.account_type}</option>)}
            </select>
          </label>
          <div className="text-sm text-muted-foreground">
            Settlement account
            <p className="mt-1 rounded border border-border bg-background px-3 py-2 text-foreground">
              {collectionMeta.settlementAccount?.name || 'Not configured in organization settings'}
            </p>
          </div>
          <label className="text-sm text-muted-foreground">
            Payer phone
            <input required inputMode="tel" autoComplete="tel" value={collectionForm.phone} onChange={event => setCollectionForm(form => ({ ...form, phone: event.target.value }))} placeholder="07xx xxx xxx" className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="text-sm text-muted-foreground">
            Deposited by (optional)
            <input maxLength={255} value={collectionForm.depositorName} onChange={event => setCollectionForm(form => ({ ...form, depositorName: event.target.value }))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="text-sm text-muted-foreground">
            Deposit reason
            <input required maxLength={1000} value={collectionForm.reason} onChange={event => setCollectionForm(form => ({ ...form, reason: event.target.value }))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="text-sm text-muted-foreground">
            Amount (UGX)
            <input required type="number" min="1" step="1" value={collectionForm.amountUgx} onChange={event => setCollectionForm(form => ({ ...form, amountUgx: event.target.value }))} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <div className="flex items-end">
            <button type="submit" disabled={!collectionMeta.enabled || !collectionMeta.settlementAccount || collectionBusy || members.length === 0} className="flex w-full items-center justify-center gap-2 rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">
              <Smartphone className="h-4 w-4" /> {collectionBusy ? 'Starting…' : 'Request payment'}
            </button>
          </div>
        </form>

        {collectionIntent && (
          <div role="status" className="rounded border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Provider: {collectionIntent.provider_status || 'pending'} · Ledger: {collectionIntent.status === 'settled' ? 'posted' : 'not posted'}</p>
            <p className="mt-1 text-muted-foreground">Requested: {formatCurrency(collectionIntent.amount_minor ?? collectionIntent.amountUgx ?? 0, 'UGX')}</p>
            <p className="text-muted-foreground">Provider confirmed: {collectionIntent.provider_amount_minor == null
              ? 'Not available'
              : formatProviderAmount(collectionIntent.provider_amount_minor, collectionIntent.provider_currency)}</p>
            <p className="text-muted-foreground">Provider fee (paid by payer): {collectionIntent.provider_fee_minor == null
              ? 'Not confirmed'
              : formatCurrency(collectionIntent.provider_fee_minor, 'UGX')}</p>
            <p className="text-muted-foreground">Credited to member ledger: {collectionIntent.ledger_amount_minor == null
              ? 'Not posted'
              : formatCurrency(collectionIntent.ledger_amount_minor, 'UGX')}</p>
            {collectionIntent.provider_amount_minor != null && Number(collectionIntent.provider_amount_minor) !== Number(collectionIntent.amount_minor) && (
              <p className="mt-1 text-amber-800">
                Provider-reported difference from requested: {formatCurrency(Math.abs(Number(collectionIntent.amount_minor) - Number(collectionIntent.provider_amount_minor)), 'UGX')}.
                {Number(collectionIntent.provider_amount_minor) < Number(collectionIntent.amount_minor)
                  ? ' Less was confirmed; only the confirmed amount is credited.'
                  : collectionIntent.status === 'settled'
                    ? ' This matches the configured provider fee; the net requested amount was credited.'
                    : ' This exceeds the configured fee; it was held for review.'}
              </p>
            )}
            {collectionIntent.failure_reason && <p className="mt-1 text-amber-800">{collectionIntent.failure_reason}</p>}
            {collectionIntent.status === 'review' && <button type="button" onClick={recheckCollection} disabled={collectionRechecking} className="mt-2 rounded border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">{collectionRechecking ? 'Checking MarzPay…' : 'Recheck payment and ledger'}</button>}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-foreground">Recent MarzPay collections</h2>
          <p className="mt-1 text-xs text-muted-foreground">Provider completion and ledger posting are separate. Recheck open or review items before retrying.</p>
        </div>
        {collectionIntents.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No mobile-money collections found.</p>
        ) : (
          <div className="divide-y divide-border">
            {collectionIntents.map(intent => (
              <div key={intent.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-foreground">{formatCurrency(intent.amount_minor, 'UGX')} · {intent.status}</p>
                    <p className="text-xs text-muted-foreground">
                      Provider: {intent.provider_status || 'unknown'} · Ledger: {intent.status === 'settled' ? 'posted' : 'not posted'}
                      {intent.phone_masked ? ` · ${intent.phone_masked}` : ''}
                    </p>
                    {intent.depositor_name && <p className="text-xs text-muted-foreground">Deposited by: {intent.depositor_name}</p>}
                  </div>
                  {['created', 'processing', 'review'].includes(intent.status) && (
                    <button
                      type="button"
                      onClick={() => recheckCollectionIntent(intent.id)}
                      disabled={collectionChecks[intent.id]}
                      className="rounded border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {collectionChecks[intent.id] ? 'Checking…' : 'Recheck MarzPay'}
                    </button>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  Requested: {formatCurrency(intent.amount_minor, 'UGX')} · Provider confirmed: {intent.provider_amount_minor == null
                    ? 'not available'
                    : formatProviderAmount(intent.provider_amount_minor, intent.provider_currency)} · Ledger posted: {intent.ledger_amount_minor == null
                    ? 'no'
                    : formatCurrency(intent.ledger_amount_minor, 'UGX')}
                </div>
                {Number(intent.provider_fee_minor || 0) > 0 && (
                  <p className="text-xs text-muted-foreground">Provider fee paid by payer: {formatCurrency(intent.provider_fee_minor, 'UGX')}</p>
                )}
                {intent.provider_status && ['completed', 'successful', 'success'].includes(String(intent.provider_status).toLowerCase()) && intent.status !== 'settled' && (
                  <p className="text-xs font-medium text-amber-800">MarzPay reports completion, but no ledger posting is recorded. Reconcile this intent before starting another payment.</p>
                )}
                {intent.failure_reason && <p className="text-xs text-amber-800">{intent.failure_reason}</p>}
                {collectionCheckErrors[intent.id] && <p role="alert" className="text-xs text-red-700">{collectionCheckErrors[intent.id]}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex gap-2 flex-wrap">
        <button onClick={() => { setStatusFilter(''); setLoading(true); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${!statusFilter ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>All</button>
        {['pending', 'completed', 'failed', 'refunded'].map(s => (
          <button key={s} onClick={() => { setStatusFilter(s); setLoading(true); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${statusFilter === s ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>{s}</button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
      ) : payments.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">No payments found</div>
      ) : (
        <div className="bg-card rounded-xl border divide-y">
          {payments.map(p => (
            <div key={p.id} className="flex items-center justify-between p-4 hover:bg-muted transition">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${p.status === 'completed' ? 'bg-emerald-50' : 'bg-muted'}`}>
                  <CreditCard className={`w-5 h-5 ${p.status === 'completed' ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{p.currency || 'UGX'} {Math.round(parseFloat(p.amount || 0)).toLocaleString()}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PAY_STATUS[p.status]}`}>{p.status}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    {p.deal_title && <Link href={`/app/deals/${p.deal_id}`} className="hover:text-blue-600">{p.deal_title}</Link>}
                    {p.client_name && <span>{p.client_name}</span>}
                    <span>{p.method?.replace(/_/g, ' ')}</span>
                    {p.reference && <span>Ref: {p.reference}</span>}
                  </div>
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {p.account_name && <div className="text-muted-foreground">{p.account_name}</div>}
                <div>{new Date(p.created_at).toLocaleDateString()}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
