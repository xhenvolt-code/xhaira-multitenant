'use client';

import { useEffect, useState } from 'react';
import { Save, ArrowLeft } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';

const CATEGORY_LABELS = {
  general: 'General',
  members: 'Members',
  accounts: 'Accounts',
  loans: 'Loans',
  transfers: 'Transfers',
  ui: 'Interface',
  notifications: 'Notifications',
};

const CATEGORY_ORDER = ['general', 'members', 'accounts', 'loans', 'transfers', 'ui', 'notifications'];
const MARZPAY_SETTLEMENT_ACCOUNT_KEY = 'payments.marzpay.settlement_account_id';
const POLICY_OPTIONS = {
  'groups.requirement': [['required', 'Members must belong to a group'], ['optional', 'Group membership is optional'], ['disabled', 'Groups are disabled']],
  'groups.nature': [['member_type', 'Groups can borrow and save'], ['sub_organization', 'Groups contain individual members'], ['both', 'Both group models']],
  'groups.cardinality': [['one', 'One group per member'], ['many', 'Multiple groups per member']],
};

function getThresholdAmount(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return parsed.trim() === '' ? '' : Number.isFinite(Number(parsed)) ? Number(parsed) : '';
    }
  }
  if (parsed && typeof parsed === 'object') {
    parsed = parsed.amount;
    if (parsed && typeof parsed === 'object') return '';
  }
  if (parsed === '' || parsed === null || parsed === undefined) return '';
  const amount = Number(parsed);
  return Number.isFinite(amount) ? amount : '';
}

export default function SACCOConfigurationsPage() {
  const toast = useToast();
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState({});
  const [pendingChanges, setPendingChanges] = useState({});
  const [settlementAccounts, setSettlementAccounts] = useState([]);
  const [settlementAccountId, setSettlementAccountId] = useState('');
  const [settlementAccountSaving, setSettlementAccountSaving] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const fetchConfigs = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetchWithAuth('/api/sacco-configurations');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to load configurations.');
      const configurations = json.data || [];
      const settlementConfig = configurations.find(config => config.config_key === MARZPAY_SETTLEMENT_ACCOUNT_KEY);
      setConfigs(configurations);
      setSettlementAccounts(json.settlementAccounts || []);
      setSettlementAccountId(typeof settlementConfig?.config_value === 'string' ? settlementConfig.config_value : '');
      setCanManage(json.canManage === true);
    } catch (error) {
      setConfigs([]);
      setSettlementAccounts([]);
      setLoadError(error.message || 'Failed to load configurations.');
      toast.error(error.message || 'Failed to load configurations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfigs(); }, []);

  const getValue = (config) => {
    const key = config.config_key;
    if (key in pendingChanges) {
      return key === 'transfers.approval_threshold'
        ? getThresholdAmount(pendingChanges[key])
        : pendingChanges[key];
    }
    if (config.config_type === 'boolean') return config.config_value === true || config.config_value === 'true';
    if (key === 'transfers.approval_threshold') return getThresholdAmount(config.config_value);
    return config.config_value ?? '';
  };

  const handleToggle = (config) => {
    if (!config.is_editable) return;
    const current = getValue(config);
    setPendingChanges(prev => ({ ...prev, [config.config_key]: !current }));
  };

  const handleTextChange = (config, value) => {
    if (!config.is_editable) return;
    setPendingChanges(prev => ({ ...prev, [config.config_key]: value }));
  };

  const handleSave = async (config) => {
    const key = config.config_key;
    if (!(key in pendingChanges)) return;
    setSaving(prev => ({ ...prev, [key]: true }));
    try {
      const res = await fetchWithAuth('/api/sacco-configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_key: key, config_value: pendingChanges[key] }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success('Configuration saved');
        setPendingChanges(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        fetchConfigs();
      } else {
        toast.error(json.error || 'Save failed');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(prev => ({ ...prev, [key]: false }));
    }
  };

  const hasPending = Object.keys(pendingChanges).length > 0;

  const handleSaveAll = async () => {
    const keys = Object.keys(pendingChanges);
    if (!keys.length) return;
    for (const key of keys) {
      const config = configs.find(c => c.config_key === key);
      if (config) await handleSave(config);
    }
  };

  const saveSettlementAccount = async () => {
    setSettlementAccountSaving(true);
    try {
      const res = await fetchWithAuth('/api/sacco-configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config_key: MARZPAY_SETTLEMENT_ACCOUNT_KEY,
          config_value: settlementAccountId,
          label: 'MarzPay settlement account',
          description: 'Organization account used for MarzPay collections and disbursements',
          config_type: 'text',
          category: 'accounts',
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not save settlement account.');
      toast.success('Settlement account saved');
      await fetchConfigs();
    } catch (error) {
      toast.error(error.message || 'Could not save settlement account');
    } finally {
      setSettlementAccountSaving(false);
    }
  };

  const grouped = configs.filter(config => config.config_key !== MARZPAY_SETTLEMENT_ACCOUNT_KEY).reduce((acc, c) => {
    const cat = c.category || 'general';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(c);
    return acc;
  }, {});

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {loadError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
        <span>{loadError}</span>
        <button type="button" onClick={fetchConfigs} className="shrink-0 underline">Retry</button>
      </div>}
      <div className="flex items-center gap-3">
        <Link href="/app/settings" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Settings
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">SACCO Configurations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Global system toggles and settings for members, accounts, loans, and transfers.
          </p>
        </div>
        {hasPending && (
          <button onClick={handleSaveAll}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
            <Save className="w-3.5 h-3.5" /> Save All Changes
          </button>
        )}
      </div>

      {hasPending && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-700 dark:text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          {Object.keys(pendingChanges).length} unsaved change{Object.keys(pendingChanges).length !== 1 ? 's' : ''}.
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-foreground">MarzPay settlement account</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the organization’s active UGX mobile-money account once. Mobile-money collections and withdrawals will use it automatically.
            Bank and cash balances should remain separate when they represent different real funds.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <select
            value={settlementAccountId}
            onChange={event => setSettlementAccountId(event.target.value)}
            disabled={!canManage || settlementAccountSaving}
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
          >
            <option value="">Select an active UGX mobile-money account</option>
            {settlementAccountId && !settlementAccounts.some(account => account.id === settlementAccountId) && (
              <option value={settlementAccountId}>Previously selected account is no longer available</option>
            )}
            {settlementAccounts.map(account => (
              <option key={account.id} value={account.id}>{account.name} · {account.type}</option>
            ))}
          </select>
          {canManage && (
            <button
              type="button"
              onClick={saveSettlementAccount}
              disabled={settlementAccountSaving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {settlementAccountSaving ? 'Saving…' : 'Save settlement account'}
            </button>
          )}
        </div>
        {!canManage && <p className="text-xs text-muted-foreground">Only the organization superadmin can change this setting.</p>}
        {!settlementAccounts.length && <p className="text-xs text-amber-700">Create or activate an organization mobile-money account with UGX currency before selecting a settlement account.</p>}
      </section>

      <div className="space-y-6">
        {CATEGORY_ORDER.map(category => {
          const catConfigs = grouped[category];
          if (!catConfigs?.length) return null;
          return (
            <div key={category} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-muted/30 border-b border-border">
                <h3 className="font-semibold text-sm text-foreground">{CATEGORY_LABELS[category] || category}</h3>
              </div>
              <div className="divide-y divide-border">
                {catConfigs.map(config => {
                  const isPending = config.config_key in pendingChanges;
                  const isSaving = saving[config.config_key];
                  const value = getValue(config);
                  return (
                    <div key={config.config_key} className="flex items-start gap-4 px-5 py-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{config.label}</span>
                          {!config.is_editable && (
                            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Read-only</span>
                          )}
                          {isPending && (
                            <span className="text-xs text-amber-600 dark:text-amber-400">● Unsaved</span>
                          )}
                        </div>
                        {config.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">{config.description}</p>
                        )}
                        <p className="text-xs text-muted-foreground/60 font-mono mt-0.5">{config.config_key}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {POLICY_OPTIONS[config.config_key] ? (
                          <select value={value} onChange={(event) => handleTextChange(config, event.target.value)}
                            disabled={!config.is_editable}
                            className="max-w-64 px-2.5 py-1.5 border border-border rounded-lg bg-background text-foreground text-sm">
                            {POLICY_OPTIONS[config.config_key].map(([option, label]) => <option key={option} value={option}>{label}</option>)}
                          </select>
                        ) : config.config_type === 'boolean' ? (
                          <button
                            onClick={() => handleToggle(config)}
                            disabled={!config.is_editable}
                            className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-40 disabled:cursor-not-allowed ${
                              value ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
                            }`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                              value ? 'translate-x-5' : 'translate-x-0'
                            }`} />
                          </button>
                        ) : (
                          <input
                            type={config.config_key === 'transfers.approval_threshold' || config.config_type === 'number' ? 'number' : 'text'}
                            value={value}
                            min={config.config_key === 'transfers.approval_threshold' ? '0' : undefined}
                            step={config.config_key === 'transfers.approval_threshold' ? '1' : undefined}
                            onChange={e => handleTextChange(config, config.config_key === 'transfers.approval_threshold' || config.config_type === 'number'
                              ? (e.target.value === '' ? '' : Number(e.target.value))
                              : e.target.value)}
                            disabled={!config.is_editable}
                            className="w-32 px-2.5 py-1.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                          />
                        )}
                        {isPending && (
                          <button
                            onClick={() => handleSave(config)}
                            disabled={isSaving}
                            className="px-2.5 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                          >
                            {isSaving ? '...' : 'Save'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
