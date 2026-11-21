'use client';

import { useEffect, useState } from 'react';
import { Plus, Wallet, X, Landmark, Pencil, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency } from '@/lib/format-currency';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';

const TYPE_COLORS = { bank: 'bg-blue-100 text-blue-700', savings: 'bg-emerald-100 text-emerald-700', cash: 'bg-yellow-100 text-yellow-700', mobile_money: 'bg-purple-100 text-purple-700', credit_card: 'bg-pink-100 text-pink-700', investment: 'bg-cyan-100 text-cyan-700', internal: 'bg-orange-100 text-orange-700', salary: 'bg-teal-100 text-teal-700', escrow: 'bg-indigo-100 text-indigo-700', system: 'bg-violet-100 text-violet-700', other: 'bg-muted text-foreground' };
const ACCOUNT_TYPES = ['cash','mobile_money','bank','savings','credit_card','investment','internal','salary','escrow','system','other'];

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'cash', currency: 'UGX', initial_balance: '', institution: '', account_number: '', description: '' });
  const [editingAccount, setEditingAccount] = useState(null);
  const [deleteAccount, setDeleteAccount] = useState(null);
  const [deleteRequiresForce, setDeleteRequiresForce] = useState(false);
  const [linkedPaymentIntentCount, setLinkedPaymentIntentCount] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const toast = useToast();

  useEffect(() => { fetchAccounts(); }, []);

  const fetchAccounts = async () => {
    try {
      const res = await fetchWithAuth('/api/accounts');
      const json = await res.json();
      if (json.success) { setAccounts(json.data || []); setLoadError(''); }
      else setLoadError(json.error || 'Failed to load accounts');
    } catch (err) { console.error(err); setLoadError(err.message || 'Failed to load accounts'); } finally { setLoading(false); }
  };

  const submit = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const body = { ...form };
      if (body.initial_balance) body.initial_balance = parseFloat(body.initial_balance);
      else delete body.initial_balance;
      const res = await fetchWithAuth('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to create account');
      toast.success('Account created'); setShowForm(false); setForm({ name: '', type: 'cash', currency: 'UGX', initial_balance: '', institution: '', account_number: '', description: '' }); await fetchAccounts();
    } catch (err) { console.error(err); toast.error(err.message || 'Failed to create account'); } finally { setSaving(false); }
  };

  const startEditing = (account) => {
    setEditingAccount(account);
    setEditForm({
      name: account.name || '',
      type: account.type || 'cash',
      currency: account.currency || 'UGX',
      description: account.description || '',
      institution: account.institution || '',
      account_number: account.account_number || '',
      is_primary_cash_account: account.is_primary_cash_account === true,
    });
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    if (!editingAccount || !editForm) return;
    setEditSaving(true);
    try {
      const res = await fetchWithAuth(`/api/accounts/${editingAccount.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editForm,
          is_primary_cash_account: editForm.type === 'system' && editForm.currency.trim().toUpperCase() === 'UGX'
            ? editForm.is_primary_cash_account
            : false,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to update account');
      toast.success('Account updated');
      setEditingAccount(null);
      setEditForm(null);
      await fetchAccounts();
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to update account');
    } finally {
      setEditSaving(false);
    }
  };

  const confirmDeleteAccount = async (force = false) => {
    if (!deleteAccount || deleting) return;
    setDeleting(true);
    try {
      const res = await fetchWithAuth(`/api/accounts/${deleteAccount.id}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (json.requiresForce) {
        setDeleteRequiresForce(true);
        setLinkedPaymentIntentCount(json.linkedPaymentIntents || 0);
        return;
      }
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to delete account');
      toast.success('Account Deleted');
      setDeleteAccount(null);
      setDeleteRequiresForce(false);
      setLinkedPaymentIntentCount(0);
      await fetchAccounts();
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to Delete account');
    } finally {
      setDeleting(false);
    }
  };
  const totalBalance = accounts.reduce((s, a) => s + parseFloat(a.balance || 0), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">{accounts.length} accounts &middot; {formatCurrency(totalBalance)} total balance</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
          {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />} {showForm ? 'Cancel' : 'New Account'}
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-900 sm:flex-row sm:items-center sm:justify-between dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
        <div className="flex items-start gap-3">
          <Landmark className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">Configure MarzPay settlement</p>
            <p className="mt-1 text-xs text-blue-800 dark:text-blue-200">Create or activate an organization mobile-money account in UGX, then choose it as the settlement account.</p>
          </div>
        </div>
        <Link href="/app/settings/configurations#marzpay-settlement" className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-blue-700">
          Set settlement account
        </Link>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-card rounded-xl border p-5 space-y-4">
          <h2 className="font-semibold">Create Account</h2>
          {accounts.length === 0 && (
            <p className="text-sm text-blue-800 dark:text-blue-200">
              This first account will be created as the organization’s primary UGX system account for member deposits and withdrawals.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" placeholder="e.g. Business Checking" />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground">
                {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Currency</label>
              <input value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Initial Balance</label>
              <input type="number" step="0.01" value={form.initial_balance} onChange={e => setForm(f => ({ ...f, initial_balance: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" placeholder="0.00" />
            </div>
          </div>
          <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{saving ? 'Creating...' : 'Create Account'}</button>
        </form>
      )}

      {editingAccount && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <form
            onSubmit={submitEdit}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-account-title"
            className="w-full max-w-2xl space-y-4 rounded-xl border bg-card p-6 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h2 id="edit-account-title" className="text-lg font-semibold">Edit account</h2>
              <button type="button" onClick={() => { setEditingAccount(null); setEditForm(null); }} className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="Close edit account form">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted-foreground">
                Account name
                <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} required maxLength={255} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
              </label>
              <label className="text-sm text-muted-foreground">
                Type
                <select value={editForm.type} onChange={e => setEditForm(f => ({ ...f, type: e.target.value }))} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground">
                  {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
              <label className="text-sm text-muted-foreground">
                Currency
                <input value={editForm.currency} onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))} maxLength={3} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 uppercase text-foreground" />
              </label>
              <label className="text-sm text-muted-foreground">
                Institution
                <input value={editForm.institution} onChange={e => setEditForm(f => ({ ...f, institution: e.target.value }))} maxLength={255} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
              </label>
              <label className="text-sm text-muted-foreground">
                Account number
                <input value={editForm.account_number} onChange={e => setEditForm(f => ({ ...f, account_number: e.target.value }))} maxLength={255} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
              </label>
              <label className="text-sm text-muted-foreground sm:col-span-2">
                Description
                <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} maxLength={5000} rows={3} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground" />
              </label>
            </div>
            {editingAccount.is_active === true &&
              editingAccount.status === 'active' &&
              editForm.type === 'system' &&
              editForm.currency.trim().toUpperCase() === 'UGX' && (
              <label className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-100">
                <input
                  type="checkbox"
                  checked={editForm.is_primary_cash_account}
                  onChange={e => setEditForm(f => ({ ...f, is_primary_cash_account: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium">Primary account for deposits and withdrawals</span>
                  <span className="mt-1 block text-xs opacity-80">Selecting this account replaces the organization’s current primary account.</span>
                </span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setEditingAccount(null); setEditForm(null); }} className="rounded-lg border px-4 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={editSaving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {editSaving ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
      ) : loadError ? (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">{loadError}</div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">No accounts yet. Create your first account to start tracking finances.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map(a => (
            <article key={a.id} className="bg-card rounded-xl border p-5 hover:border-blue-300 hover:shadow-sm transition">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-muted-foreground" />
                  <span className="font-medium text-foreground">{a.name}</span>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${TYPE_COLORS[a.type] || TYPE_COLORS.other}`}>{a.type}</span>
              </div>
              {a.is_primary_cash_account && (
                <div className="mb-3 inline-flex rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
                  Primary deposits &amp; withdrawals account
                </div>
              )}
              <div className={`text-2xl font-bold ${parseFloat(a.balance) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(a.balance)}</div>
              <div className="text-xs text-muted-foreground mt-1">{a.currency} &middot; {a.transaction_count || 0} transactions</div>
              <div className={`flex items-center justify-between`}>
                <button type="button" onClick={() => startEditing(a)} className="mt-4 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">
                  <Pencil className="h-4 w-4" /> Edit account
                </button>

                <button type="button" onClick={() => { setDeleteAccount(a); setDeleteRequiresForce(false); setLinkedPaymentIntentCount(0); }} className="mt-4 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-red-800 hover:bg-muted">
                  <Trash2 className="h-4 w-4" /> Delete account
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {deleteAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" className="w-full max-w-md rounded-xl bg-card p-6 shadow-xl">
            <h2 id="delete-account-title" className="text-lg font-semibold text-foreground">Delete {deleteAccount.name}?</h2>
            <p className="mt-2 text-sm text-muted-foreground">This permanently deletes the account and its linked ledger transactions.</p>
            {deleteRequiresForce && (
              <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                Force deletion will also permanently delete {linkedPaymentIntentCount} linked MarzPay payment request(s) and clear this account from settlement settings. Pending or under-review requests must be resolved first.
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" disabled={deleting} onClick={() => { setDeleteAccount(null); setDeleteRequiresForce(false); setLinkedPaymentIntentCount(0); }} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">Cancel</button>
              {deleteRequiresForce ? (
                <button type="button" disabled={deleting} onClick={() => confirmDeleteAccount(true)} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50">{deleting ? 'Deleting…' : 'Force delete'}</button>
              ) : (
                <button type="button" disabled={deleting} onClick={() => confirmDeleteAccount()} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete account'}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
