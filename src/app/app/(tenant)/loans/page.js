'use client';

import { useEffect, useState } from 'react';
import { Banknote, Plus, Search, Clock, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';
import {
  EXTERNAL_GUARANTOR_FIELDS,
  EXTERNAL_GUARANTOR_FIELD_MAX_LENGTH,
} from '@/lib/loan-guarantor-rules.js';

const STATUS_STYLES = {
  PENDING: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  APPROVED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  DISBURSED: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  REJECTED: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  ACTIVE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  COMPLETED: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  DEFAULTED: 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  WRITTEN_OFF: 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-500',
};

const STATUS_ICONS = {
  PENDING: Clock, APPROVED: CheckCircle2, DISBURSED: Banknote, REJECTED: XCircle,
  ACTIVE: Banknote, COMPLETED: CheckCircle2, DEFAULTED: AlertTriangle,
};

function fmtCurrency(amount, currency = 'UGX') {
  return `${currency} ${Math.round(parseFloat(amount || 0)).toLocaleString()}`;
}

export default function LoansPage() {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberSuggestions, setMemberSuggestions] = useState([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchError, setMemberSearchError] = useState('');
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [products, setProducts] = useState([]);
  const [memberAccounts, setMemberAccounts] = useState([]);
  const [memberAccountsLoading, setMemberAccountsLoading] = useState(false);
  const [memberAccountsError, setMemberAccountsError] = useState('');
  const [guarantorSearch, setGuarantorSearch] = useState('');
  const [guarantorCandidates, setGuarantorCandidates] = useState([]);
  const [guarantorSearchLoading, setGuarantorSearchLoading] = useState(false);
  const [guarantorSearchError, setGuarantorSearchError] = useState('');
  const [requiredGuarantors, setRequiredGuarantors] = useState(0);
  const [guarantorRequirements, setGuarantorRequirements] = useState({
    member_count: 0,
    external_count: 0,
    external_required_fields: [],
  });
  const [selectedGuarantors, setSelectedGuarantors] = useState([]);
  const [selectedExternalGuarantors, setSelectedExternalGuarantors] = useState([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const [form, setForm] = useState({
    member_id: '', product_id: '', member_account_id: '', principal: '',
  });

  const fetchLoans = async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetchWithAuth(`/api/loans?${params}`);
      const json = await res.json();
      if (json.success) setLoans(json.data || []);
    } catch (err) {
      console.error('Failed to fetch loans:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLoans(); }, [statusFilter]);

  // Load loan products when the application form opens.
  useEffect(() => {
    if (!showForm) return;
    fetchWithAuth('/api/sacco-products?type=LOAN&active=true')
      .then(result => {
        if (!result.success) throw new Error(result.error || 'Could not load loan products.');
        setProducts(result.data || []);
      })
      .catch(error => toast.error(error.message || 'Could not load loan products.'));
  }, [showForm]);

  // Search members on demand instead of loading a capped list of every member.
  useEffect(() => {
    const search = memberSearch.trim();
    if (!showForm || search.length < 2 || form.member_id) {
      setMemberSuggestions([]);
      setMemberSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setMemberSearchLoading(true);
      setMemberSearchError('');
      try {
        const result = await fetchWithAuth(
          `/api/members/search?search=${encodeURIComponent(search)}`,
          { signal: controller.signal }
        );
        if (!result.success) throw new Error(result.error || 'Could not search members.');
        setMemberSuggestions(result.data || []);
        setActiveSuggestion(-1);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setMemberSuggestions([]);
          setMemberSearchError(error.message || 'Could not search members.');
        }
      } finally {
        if (!controller.signal.aborted) setMemberSearchLoading(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [showForm, memberSearch, form.member_id]);

  // Load active disbursement accounts for the selected member.
  useEffect(() => {
    if (!form.member_id) {
      setMemberAccounts([]);
      setMemberAccountsLoading(false);
      setMemberAccountsError('');
      return;
    }

    const controller = new AbortController();
    const loadAccounts = async () => {
      setMemberAccounts([]);
      setMemberAccountsLoading(true);
      setMemberAccountsError('');
      try {
        const result = await fetchWithAuth(
          `/api/members/${form.member_id}/accounts?active_only=true`,
          { signal: controller.signal }
        );
        if (!result.success) throw new Error(result.error || 'Could not load member accounts.');
        setMemberAccounts(result.data || []);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setMemberAccountsError(error.message || 'Could not load member accounts.');
        }
      } finally {
        if (!controller.signal.aborted) setMemberAccountsLoading(false);
      }
    };
    loadAccounts();
    return () => controller.abort();
  }, [form.member_id]);

  useEffect(() => {
    if (!form.member_id) {
      setGuarantorCandidates([]);
      setGuarantorSearchLoading(false);
      setGuarantorSearchError('');
      setRequiredGuarantors(0);
      setGuarantorRequirements({ member_count: 0, external_count: 0, external_required_fields: [] });
      setSelectedExternalGuarantors([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setGuarantorSearchLoading(guarantorSearch.trim().length >= 2);
      setGuarantorSearchError('');
      try {
        const params = new URLSearchParams({ member_id: form.member_id });
        if (guarantorSearch.trim()) params.set('search', guarantorSearch.trim());
        const result = await fetchWithAuth(`/api/loans/guarantor-candidates?${params}`, {
          signal: controller.signal,
        });
        if (!result.success) throw new Error(result.error || 'Could not search group members.');
        const requirements = result.requirements || {
          member_count: result.requiredCount || 0,
          external_count: 0,
          external_required_fields: [],
        };
        setRequiredGuarantors(requirements.member_count || 0);
        setGuarantorRequirements(requirements);
        setSelectedExternalGuarantors(current => current.length === requirements.external_count
          ? current
          : Array.from({ length: requirements.external_count }, (_, index) => current[index] || {}));
        const selectedIds = new Set(selectedGuarantors.map(item => item.id));
        setGuarantorCandidates((result.data || []).filter(member => !selectedIds.has(member.id)));
      } catch (error) {
        if (error.name !== 'AbortError') {
          setGuarantorCandidates([]);
          setGuarantorSearchError(error.message || 'Could not search group members.');
        }
      } finally {
        if (!controller.signal.aborted) setGuarantorSearchLoading(false);
      }
    }, guarantorSearch.trim() ? 250 : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [form.member_id, guarantorSearch, selectedGuarantors]);

  const selectMember = (member) => {
    setForm(current => ({ ...current, member_id: member.id, member_account_id: '' }));
    setMemberSearch(`${member.full_name} (${member.membership_number || 'No member number'})`);
    setMemberSuggestions([]);
    setMemberSearchError('');
    setActiveSuggestion(-1);
    setGuarantorSearch('');
    setSelectedGuarantors([]);
    setGuarantorCandidates([]);
    setRequiredGuarantors(0);
    setGuarantorRequirements({ member_count: 0, external_count: 0, external_required_fields: [] });
    setSelectedExternalGuarantors([]);
    setGuarantorSearchError('');
  };

  const addGuarantor = (member) => {
    const splitAmount = Number(form.principal) > 0
      ? (Number(form.principal) / Math.max(requiredGuarantors, 1)).toFixed(2)
      : '';
    setSelectedGuarantors(current => [...current, {
      id: member.id,
      full_name: member.full_name,
      membership_number: member.membership_number,
      guaranteed_amount: splitAmount,
      customAmount: false,
    }]);
    setGuarantorCandidates(current => current.filter(candidate => candidate.id !== member.id));
  };

  const removeGuarantor = (memberId) => {
    setSelectedGuarantors(current => current.filter(member => member.id !== memberId));
  };

  const handleMemberSearchKeyDown = (event) => {
    if (event.key === 'ArrowDown' && memberSuggestions.length) {
      event.preventDefault();
      setActiveSuggestion(index => Math.min(index + 1, memberSuggestions.length - 1));
    } else if (event.key === 'ArrowUp' && memberSuggestions.length) {
      event.preventDefault();
      setActiveSuggestion(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && activeSuggestion >= 0 && memberSuggestions[activeSuggestion]) {
      event.preventDefault();
      selectMember(memberSuggestions[activeSuggestion]);
    } else if (event.key === 'Escape') {
      setMemberSuggestions([]);
      setActiveSuggestion(-1);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.member_id) {
      toast.error('Choose a member from the search suggestions.');
      return;
    }
    if (!form.principal) return;
    if (selectedGuarantors.length < requiredGuarantors) {
      toast.error(`Select at least ${requiredGuarantors} group member${requiredGuarantors === 1 ? '' : 's'} as guarantor${requiredGuarantors === 1 ? '' : 's'}.`);
      return;
    }
    if (selectedExternalGuarantors.length < guarantorRequirements.external_count) {
      toast.error(`Enter details for at least ${guarantorRequirements.external_count} outside guarantor${guarantorRequirements.external_count === 1 ? '' : 's'}.`);
      return;
    }
    if (selectedGuarantors.some(guarantor => !Number.isFinite(Number(guarantor.guaranteed_amount)) || Number(guarantor.guaranteed_amount) <= 0)) {
      toast.error('Enter a positive guaranteed amount for each guarantor.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetchWithAuth('/api/loans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          guarantors: selectedGuarantors.map(guarantor => ({
            guarantor_member_id: guarantor.id,
            guaranteed_amount: Number(guarantor.guaranteed_amount),
          })),
          external_guarantors: selectedExternalGuarantors.map(guarantor => ({
            ...guarantor,
            guaranteed_amount: Number(guarantor.guaranteed_amount),
          })),
        }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success('Loan application submitted');
        setShowForm(false);
        setForm({ member_id: '', product_id: '', member_account_id: '', principal: '' });
        setMemberSearch('');
        setGuarantorSearch('');
        setSelectedGuarantors([]);
        setSelectedExternalGuarantors([]);
        setRequiredGuarantors(0);
        setGuarantorRequirements({ member_count: 0, external_count: 0, external_required_fields: [] });
        fetchLoans();
      } else {
        toast.error(json.error || 'Failed to create loan');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async (loanId, action) => {
    try {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
      if (action === 'reject') opts.body = JSON.stringify({ reason: 'Rejected by admin' });
      const res = await fetchWithAuth(`/api/loans/${loanId}/${action}`, opts);
      const json = await res.json();
      if (json.success) {
        toast.success(`Loan ${action}d successfully`);
        fetchLoans();
      } else {
        toast.error(json.error || `Failed to ${action} loan`);
      }
    } catch {
      toast.error('Network error');
    }
  };

  const inputClass = 'w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring';

  const pendingCount = loans.filter(l => l.status === 'PENDING').length;
  const activeCount = loans.filter(l => l.status === 'ACTIVE').length;
  const totalDisbursed = loans.filter(l => ['ACTIVE', 'COMPLETED'].includes(l.status)).reduce((s, l) => s + parseFloat(l.principal || 0), 0);
  const totalRepaid = loans.reduce((s, l) => s + parseFloat(l.total_paid || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Banknote className="w-6 h-6 text-blue-500" /> Loan Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage loan applications, approvals, disbursements, and repayments</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
          <Plus className="w-4 h-4" /> {showForm ? 'Cancel' : 'New Loan'}
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Pending Approval</div>
          <div className="text-2xl font-bold mt-1 text-amber-600">{pendingCount}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Active Loans</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600">{activeCount}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Total Disbursed</div>
          <div className="text-2xl font-bold mt-1">{fmtCurrency(totalDisbursed)}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Total Repaid</div>
          <div className="text-2xl font-bold mt-1 text-blue-600">{fmtCurrency(totalRepaid)}</div>
        </div>
      </div>

      {/* Application Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">New Loan Application</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="loan-member-search" className="block text-xs font-medium text-muted-foreground mb-1">Member *</label>
              <div className="relative">
                <input
                  id="loan-member-search"
                  type="search"
                  autoComplete="off"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={memberSuggestions.length > 0}
                  aria-controls="loan-member-suggestions"
                  aria-activedescendant={activeSuggestion >= 0 ? `loan-member-option-${memberSuggestions[activeSuggestion]?.id}` : undefined}
                  value={memberSearch}
                  onChange={event => {
                    const value = event.target.value;
                    setMemberSearch(value);
                    setMemberSearchLoading(value.trim().length >= 2);
                    setMemberSearchError('');
                    setMemberSuggestions([]);
                    setForm(current => ({ ...current, member_id: '', member_account_id: '' }));
                    setMemberAccounts([]);
                    setMemberAccountsError('');
                    setGuarantorSearch('');
                    setGuarantorCandidates([]);
                    setSelectedGuarantors([]);
                    setRequiredGuarantors(0);
                    setGuarantorRequirements({ member_count: 0, external_count: 0, external_required_fields: [] });
                    setSelectedExternalGuarantors([]);
                  }}
                  onKeyDown={handleMemberSearchKeyDown}
                  placeholder="Type a member name or number..."
                  required
                  className={inputClass}
                />
                {memberSuggestions.length > 0 && (
                  <ul id="loan-member-suggestions" role="listbox" className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
                    {memberSuggestions.map((member, index) => (
                      <li key={member.id} id={`loan-member-option-${member.id}`} role="option" aria-selected={index === activeSuggestion}>
                        <button
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => selectMember(member)}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-muted ${index === activeSuggestion ? 'bg-muted' : ''}`}
                        >
                          <span className="block font-medium text-foreground">{member.full_name}</span>
                          <span className="block text-xs text-muted-foreground">{member.membership_number}{member.phone ? ` · ${member.phone}` : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {memberSearchLoading && <p className="mt-1 text-xs text-muted-foreground">Searching members…</p>}
              {memberSearchError && <p role="alert" className="mt-1 text-xs text-red-600">{memberSearchError}</p>}
              {!memberSearchLoading && !memberSearchError && memberSearch.trim().length >= 2 && !form.member_id && memberSuggestions.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">No active members found.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Loan Product</label>
              <select value={form.product_id} onChange={e => setForm(f => ({ ...f, product_id: e.target.value }))} className={inputClass}>
                <option value="">Organization default loan terms</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.interest_rate}% p.a. / {p.duration} {String(p.duration_unit || 'MONTHS').toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Disbursement Account</label>
              <select value={form.member_account_id} onChange={e => setForm(f => ({ ...f, member_account_id: e.target.value }))} disabled={!form.member_id || memberAccountsLoading || memberAccounts.length === 0} className={inputClass}>
                <option value="">Select account...</option>
                {memberAccounts.map(a => (
                  <option key={a.member_account_id || a.id} value={a.member_account_id || a.id}>
                    {a.account_type_name || a.account_type} — {a.account_number} ({fmtCurrency(a.balance, a.currency)})
                  </option>
                ))}
              </select>
              {memberAccountsLoading && <p className="mt-1 text-xs text-muted-foreground">Loading active member accounts…</p>}
              {memberAccountsError && <p role="alert" className="mt-1 text-xs text-red-600">{memberAccountsError}</p>}
              {!memberAccountsLoading && !memberAccountsError && !form.member_id && (
                <p className="mt-1 text-xs text-muted-foreground">Select a member to load their active accounts.</p>
              )}
              {!memberAccountsLoading && !memberAccountsError && form.member_id && memberAccounts.length === 0 && (
                <p className="mt-1 text-xs text-amber-700">No active accounts found. The account is optional for application but needed to disburse the loan.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Principal Amount (UGX) *</label>
              <input type="number" min="1" step="1" value={form.principal} onChange={e => {
                const principal = e.target.value;
                setForm(f => ({ ...f, principal }));
                const defaultAmount = Number(principal) > 0
                  ? (Number(principal) / Math.max(requiredGuarantors, 1)).toFixed(2)
                  : '';
                setSelectedGuarantors(current => current.map(guarantor =>
                  guarantor.customAmount ? guarantor : { ...guarantor, guaranteed_amount: defaultAmount }
                ));
              }}
                required placeholder="1000000" className={inputClass} />
            </div>
          </div>
          <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby="loan-guarantors-heading">
            <div>
              <h3 id="loan-guarantors-heading" className="text-sm font-semibold">Member guarantors</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {requiredGuarantors > 0
                  ? `Select at least ${requiredGuarantors} active individual member${requiredGuarantors === 1 ? '' : 's'} as guarantor${requiredGuarantors === 1 ? '' : 's'}.`
                  : 'Member guarantors are optional under the current policy.'}
                {requiredGuarantors > 0 && ` ${selectedGuarantors.length} of ${requiredGuarantors} required selected.`}
                {guarantorRequirements.member_scope === 'SAME_GROUP' && ' They must belong to the applicant’s group.'}
              </p>
            </div>
            {!form.member_id ? (
              <p className="text-sm text-muted-foreground">Select the loan applicant first to find their group members.</p>
            ) : <>
              <label htmlFor="loan-guarantor-search" className="sr-only">Search eligible members to add as guarantors</label>
              <input
                id="loan-guarantor-search"
                type="search"
                autoComplete="off"
                value={guarantorSearch}
                onChange={event => {
                  setGuarantorSearch(event.target.value);
                  setGuarantorSearchLoading(event.target.value.trim().length >= 2);
                  setGuarantorSearchError('');
                  setGuarantorCandidates([]);
                }}
                placeholder={guarantorRequirements.member_scope === 'SAME_GROUP'
                  ? 'Search applicant’s group by name or member number...'
                  : 'Search organization members by name or member number...'}
                className={inputClass}
              />
              {guarantorSearchLoading && <p className="text-xs text-muted-foreground">Searching group members…</p>}
              {guarantorSearchError && <p role="alert" className="text-xs text-red-600">{guarantorSearchError}</p>}
              {guarantorCandidates.length > 0 && (
                <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded border border-border">
                  {guarantorCandidates.map(member => (
                    <li key={member.id}>
                      <button type="button" onClick={() => addGuarantor(member)} className="w-full px-3 py-2 text-left text-sm hover:bg-muted">
                        <span className="block font-medium">{member.full_name}</span>
                        <span className="text-xs text-muted-foreground">{member.membership_number}{member.phone ? ` · ${member.phone}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!guarantorSearchLoading && !guarantorSearchError && guarantorSearch.trim().length >= 2 && guarantorCandidates.length === 0 && (
                <p className="text-xs text-muted-foreground">No matching active eligible members found.</p>
              )}
              {selectedGuarantors.length > 0 && (
                <ul className="space-y-2">
                  {selectedGuarantors.map(member => (
                    <li key={member.id} className="grid grid-cols-1 items-end gap-2 rounded border border-border p-3 sm:grid-cols-[1fr_12rem_auto]">
                      <div>
                        <p className="text-sm font-medium">{member.full_name}</p>
                        <p className="text-xs text-muted-foreground">{member.membership_number}</p>
                      </div>
                      <label className="text-xs text-muted-foreground">
                        Guaranteed amount (UGX)
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          value={member.guaranteed_amount}
                          onChange={event => setSelectedGuarantors(current => current.map(item =>
                            item.id === member.id ? { ...item, guaranteed_amount: event.target.value, customAmount: true } : item
                          ))}
                          className={`${inputClass} mt-1`}
                        />
                      </label>
                      <button type="button" onClick={() => removeGuarantor(member.id)} className="rounded border border-border px-3 py-2 text-sm hover:bg-muted">
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>}
          </section>
          {form.member_id && guarantorRequirements.external_count > 0 && (
            <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby="loan-external-guarantors-heading">
              <div>
                <h3 id="loan-external-guarantors-heading" className="text-sm font-semibold">Outside guarantors</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter at least {guarantorRequirements.external_count} outside guarantor
                  {guarantorRequirements.external_count === 1 ? '' : 's'}.
                  Required details are configured in the organization&apos;s loan rules.
                </p>
              </div>
              {selectedExternalGuarantors.map((guarantor, index) => (
                <fieldset key={index} className="space-y-3 rounded border border-border p-3">
                  <legend className="px-1 text-sm font-medium">Outside guarantor {index + 1}</legend>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {Object.entries(EXTERNAL_GUARANTOR_FIELDS).map(([field, label]) => {
                      const required = guarantorRequirements.external_required_fields.includes(field);
                      return (
                        <label key={field} className="text-xs text-muted-foreground">
                          {label}{required ? ' *' : ''}
                          <input
                            type={field === 'phone' ? 'tel' : 'text'}
                            required={required}
                            maxLength={EXTERNAL_GUARANTOR_FIELD_MAX_LENGTH[field]}
                            value={guarantor[field] || ''}
                            onChange={event => setSelectedExternalGuarantors(current => current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, [field]: event.target.value } : item
                            ))}
                            className={`${inputClass} mt-1`}
                          />
                        </label>
                      );
                    })}
                    <label className="text-xs text-muted-foreground">
                      Guaranteed amount (UGX) *
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={guarantor.guaranteed_amount || ''}
                        onChange={event => setSelectedExternalGuarantors(current => current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, guaranteed_amount: event.target.value } : item
                        ))}
                        className={`${inputClass} mt-1`}
                      />
                    </label>
                  </div>
                </fieldset>
              ))}
            </section>
          )}
          <button type="submit" disabled={saving}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition">
            {saving ? 'Submitting...' : 'Submit Application'}
          </button>
        </form>
      )}

      {/* Status Filter */}
      <div className="flex gap-2">
        {['', 'PENDING', 'APPROVED', 'DISBURSED', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'REJECTED'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition ${statusFilter === s ? 'bg-blue-600 text-white border-blue-600' : 'border-border hover:bg-muted'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>

      {/* Loans Table */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading loans...</div>
      ) : loans.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Banknote className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-muted-foreground">No loans found</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Member</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Product</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Principal</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Total Payable</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Paid</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loans.map(l => {
                  const Icon = STATUS_ICONS[l.status] || Clock;
                  const progress = parseFloat(l.total_payable) > 0 ? (parseFloat(l.total_paid) / parseFloat(l.total_payable)) * 100 : 0;
                  return (
                    <tr key={l.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition">
                      <td className="px-4 py-3">
                        <Link href={`/app/members/${l.member_id}`} className="font-medium text-foreground hover:text-blue-600">{l.member_name}</Link>
                        <div className="text-xs text-muted-foreground">{l.membership_number}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {l.product_name || 'Default'}<br />
                        {l.interest_rate}% p.a. / {l.duration} {String(l.duration_unit || 'MONTHS').toLowerCase()}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{fmtCurrency(l.principal)}</td>
                      <td className="px-4 py-3 text-right">{fmtCurrency(l.total_payable)}</td>
                      <td className="px-4 py-3 text-right">
                        <div>{fmtCurrency(l.total_paid)}</div>
                        {l.status === 'ACTIVE' && (
                          <div className="w-16 h-1 bg-gray-200 rounded-full mt-1 ml-auto">
                            <div className="h-1 bg-emerald-500 rounded-full" style={{ width: `${Math.min(progress, 100)}%` }} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[l.status] || ''}`}>
                          <Icon className="w-3 h-3" /> {l.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Link href={`/app/loans/${l.id}`} className="text-xs px-2 py-1 border border-border rounded hover:bg-muted">View</Link>
                          {l.status === 'PENDING' && (
                            <>
                              <button onClick={() => handleAction(l.id, 'approve')} className="text-xs px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800">Approve</button>
                              <button onClick={() => handleAction(l.id, 'reject')} className="text-xs px-2 py-1 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800">Reject</button>
                            </>
                          )}
                          {l.status === 'APPROVED' && (
                            <button onClick={() => handleAction(l.id, 'disburse')} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800">Disburse</button>
                          )}
                          {l.status === 'DISBURSED' && (
                            <button onClick={() => handleAction(l.id, 'disburse')} className="text-xs px-2 py-1 bg-purple-50 text-purple-700 border border-purple-200 rounded hover:bg-purple-100 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800">Continue Disburse</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
