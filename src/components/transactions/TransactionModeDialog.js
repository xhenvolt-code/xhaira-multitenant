'use client';

import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Smartphone, Wallet, AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency } from '@/lib/format-currency';

const FINAL_STATES = new Set(['settled', 'failed', 'expired', 'review']);

export default function TransactionModeDialog({ action, account, onClose, onManual, onSuccess }) {
  const [step, setStep] = useState('choose');
  const [settings, setSettings] = useState({ configured: false, collectionsEnabled: false, disbursementsEnabled: false, accounts: [] });
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [settlementAccountId, setSettlementAccountId] = useState('');
  const [intent, setIntent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isDeposit = action === 'deposit';
  const automaticEnabled = isDeposit ? settings.collectionsEnabled : settings.disbursementsEnabled;

  useEffect(() => {
    let active = true;
    fetchWithAuth('/api/mobile-money/transactions')
      .then(result => { if (active && result.success) setSettings(result); })
      .catch(() => { if (active) setError('Could not load mobile-money options.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!intent || FINAL_STATES.has(intent.status)) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await fetchWithAuth(`/api/mobile-money/transactions/${intent.id}`);
        if (active && result.success) {
          setIntent({ ...result.data, reconciliationError: result.reconciliationError });
          if (result.data.status === 'settled') onSuccess?.(result.data);
        }
      } catch { /* provider reconciliation continues on the next poll */ }
    };
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [intent, onSuccess]);

  const startAutomatic = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await fetchWithAuth('/api/mobile-money/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          action,
          amountUgx: Number(amount),
          phone,
          settlementAccountId,
          memberAccountId: account.memberAccountId,
        }),
      });
      if (!result.success) throw new Error(result.error || 'Could not start the mobile-money transaction.');
      setIntent({ id: result.id, status: result.status, provider_status: result.provider_status, failure_reason: result.failure_reason, amount_minor: result.amountUgx });
      setStep('status');
      if (result.status === 'settled') onSuccess?.(result);
    } catch (err) {
      setError(err.message || 'Could not start the mobile-money transaction.');
    } finally {
      setBusy(false);
    }
  };

  const inputClass = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6 shadow-2xl">
        {step === 'choose' && <>
          <div className="flex items-center gap-2">
            {isDeposit ? <ArrowDownLeft className="h-5 w-5 text-emerald-600" /> : <ArrowUpRight className="h-5 w-5 text-rose-600" />}
            <h2 className="text-lg font-semibold">{isDeposit ? 'Deposit' : 'Withdraw'} · choose a method</h2>
          </div>
          <p className="text-sm text-muted-foreground">{account.label}{account.balance != null ? ` · Balance: ${formatCurrency(account.balance, 'UGX')}` : ''}</p>
          <button type="button" onClick={() => onManual?.('cash')} className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted">
            <Wallet className="h-5 w-5 text-blue-600" />
            <span><strong className="block text-sm">Cash</strong><span className="text-xs text-muted-foreground">Record cash received or paid.</span></span>
          </button>
          <button type="button" onClick={() => setStep('bank')} className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted">
            <Wallet className="h-5 w-5 text-indigo-600" />
            <span><strong className="block text-sm">Card / Bank</strong><span className="text-xs text-muted-foreground">Record a card or bank payment already processed.</span></span>
          </button>
          <button type="button" onClick={() => { setStep('automatic'); setError(''); }} className="flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-muted">
            <Smartphone className="h-5 w-5 text-emerald-700" />
            <span><strong className="block text-sm">Mobile Money · MarzPay</strong><span className="text-xs text-muted-foreground">Request a payment or send money through MarzPay.</span></span>
          </button>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button type="button" onClick={onClose} className="w-full rounded-lg border border-border py-2 text-sm hover:bg-muted">Cancel</button>
        </>}

        {step === 'bank' && <>
          <h2 className="text-lg font-semibold">Card or bank payment</h2>
          <p className="text-sm text-muted-foreground">Choose the payment record type. This records a payment already processed by your bank or card terminal.</p>
          <button type="button" onClick={() => onManual?.('card')} className="w-full rounded-lg border border-border p-4 text-left text-sm hover:bg-muted">Card</button>
          <button type="button" onClick={() => onManual?.('bank_transfer')} className="w-full rounded-lg border border-border p-4 text-left text-sm hover:bg-muted">Bank transfer</button>
          <button type="button" onClick={() => setStep('choose')} className="w-full rounded-lg border border-border py-2 text-sm hover:bg-muted">Back</button>
        </>}

        {step === 'automatic' && <>
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-emerald-700" />
            <h2 className="text-lg font-semibold">Automatic {isDeposit ? 'deposit' : 'withdrawal'}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{account.label}</p>
          {!settings.configured && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">MarzPay is not configured on this server.</p>}
          {settings.configured && !automaticEnabled && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">MarzPay {isDeposit ? 'collections' : 'disbursements'} are disabled. Ask an administrator to enable this flow.</p>}
          {isDeposit && settings.configured && automaticEnabled && <p className="text-xs text-muted-foreground">The member will receive a mobile-money payment prompt. The savings ledger updates only after MarzPay confirms payment.</p>}
          {!isDeposit && settings.configured && automaticEnabled && <p className="text-xs text-muted-foreground">MarzPay disbursement access must be enabled for your merchant account. The savings ledger updates only after payout confirmation.</p>}
          <form onSubmit={startAutomatic} className="space-y-3">
            <label className="block text-sm">{isDeposit ? 'Payer phone' : 'Recipient phone'}
              <input className={inputClass} required inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07xx xxx xxx" />
            </label>
            <label className="block text-sm">Amount (UGX)
              <input className={inputClass} required type="number" min="1" step="1" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
            </label>
            <label className="block text-sm">Mobile-money account
              <select className={inputClass} required value={settlementAccountId} onChange={e => setSettlementAccountId(e.target.value)}>
                <option value="">Select account…</option>
                {(settings.accounts || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {error && <p role="alert" className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setStep('choose')} className="flex-1 rounded-lg border border-border py-2 text-sm hover:bg-muted">Back</button>
              <button type="submit" disabled={busy || !automaticEnabled || !settings.accounts?.length} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-700 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
                {busy && <RefreshCw className="h-4 w-4 animate-spin" />}{busy ? 'Starting…' : isDeposit ? 'Request payment' : 'Send money'}
              </button>
            </div>
          </form>
          <button type="button" onClick={onClose} className="w-full text-sm text-muted-foreground hover:text-foreground">Cancel</button>
        </>}

        {step === 'status' && <>
          <h2 className="text-lg font-semibold">Mobile-money {isDeposit ? 'deposit' : 'withdrawal'}</h2>
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="font-medium">Status: {intent?.provider_status || intent?.status || 'processing'}</p>
            <p className="mt-1 text-sm text-muted-foreground">{formatCurrency(intent?.amount_minor || amount, 'UGX')} · {account.label}</p>
            {intent?.failure_reason && <p className="mt-2 text-sm text-red-700">{intent.failure_reason}</p>}
            {intent?.provider_message && <p className="mt-2 text-sm text-red-700">{intent.provider_message}</p>}
            {intent?.reconciliationError && <p className="mt-2 text-sm text-amber-800">MarzPay status check: {intent.reconciliationError}</p>}
            {intent?.status === 'processing' && <p className="mt-2 text-xs text-muted-foreground">Waiting for MarzPay confirmation. You can close this window; the transaction remains pending.</p>}
            {intent?.status === 'review' && <p className="mt-2 text-xs text-amber-800">This transaction needs reconciliation before the ledger is updated.</p>}
          </div>
          <button type="button" onClick={onClose} className="w-full rounded-lg border border-border py-2 text-sm hover:bg-muted">Close</button>
        </>}
      </div>
    </div>
  );
}
