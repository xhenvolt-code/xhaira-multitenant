'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ArrowLeft, Users, Mail, Phone, CreditCard, Plus, Edit2, Save, X, IdCard, MapPin,
  Calendar, ArrowDownRight, ArrowUpRight, History, Briefcase, Heart, UserCheck,
  ClipboardList, AlertCircle, Clock,
} from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useMembersData } from '../members-data-context';
import { useToast } from '@/components/ui/Toast';
import { useApiRefresh } from '@/lib/use-api-refresh';
import TransactionModeDialog from '@/components/transactions/TransactionModeDialog';
import Link from 'next/link';

const STATUS_STYLES = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  blocked: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  exited: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  frozen: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  closed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  dormant: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

const TABS = ['Profile', 'Accounts', 'Documents', 'Audit Trail'];

const AUDIT_ACTION_STYLES = {
  created: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  updated: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  status_changed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  deleted: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  account_opened: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  account_closed: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  login: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  document_uploaded: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

function fmtCurrency(amount, currency = 'UGX') {
  return `${currency} ${Math.round(parseFloat(amount || 0)).toLocaleString()}`;
}

const EMPTY_EDIT = {
  first_name: '', last_name: '', other_name: '',
  email: '', phone: '', national_id: '', id_type: 'national_id',
  gender: '', date_of_birth: '', address: '',
  occupation: '', employer: '', monthly_income: '',
  emergency_contact_name: '', emergency_contact_phone: '',
  next_of_kin_name: '', next_of_kin_phone: '', next_of_kin_relationship: '',
  notes: '',
};

export default function MemberDetailPage() {
  const { id } = useParams();
  const { getMember, rememberMember } = useMembersData();
  const toast = useToast();
  const [member, setMember] = useState(() => getMember(id));
  const [memberFields, setMemberFields] = useState([]);
  const [memberDocuments, setMemberDocuments] = useState([]);
  const [documentConfigs, setDocumentConfigs] = useState([]);
  const [documentKey, setDocumentKey] = useState('');
  const [documentFile, setDocumentFile] = useState(null);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState('');
  const [loading, setLoading] = useState(() => !getMember(id));
  const [memberLoadError, setMemberLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('Profile');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ account_type_id: '', currency: 'UGX' });
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [accountTypes, setAccountTypes] = useState([]);
  const [accountTypesError, setAccountTypesError] = useState('');
  // Transaction state
  const [txModal, setTxModal] = useState(null);
  const [txModeModal, setTxModeModal] = useState(null);
  const [txAmount, setTxAmount] = useState('');
  const [txDescription, setTxDescription] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [ledger, setLedger] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  // Audit trail
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const dataRequestId = useRef(0);
  const accountsRequestId = useRef(0);
  const accountsMemberId = useRef(id);

  const fetchAccounts = async (memberId = id) => {
    const requestId = ++accountsRequestId.current;
    if (accountsMemberId.current !== memberId) {
      accountsMemberId.current = memberId;
      setAccounts([]);
    }
    setAccountsLoading(true);
    setAccountsError('');
    try {
      const response = await fetchWithAuth(`/api/members/${memberId}/accounts`, { cache: 'no-store' });
      const result = await response.json();
      if (requestId !== accountsRequestId.current) return;
      if (!response._ok || !result.success) {
        setAccountsError(result.error || 'Could not load member accounts. Please try again.');
        return;
      }
      setAccounts(result.data || []);
    } catch (error) {
      if (requestId === accountsRequestId.current) {
        setAccountsError(error.message || 'Could not load member accounts. Please try again.');
      }
    } finally {
      if (requestId === accountsRequestId.current) setAccountsLoading(false);
    }
  };

  const applyAccountBalance = (memberAccountId, balance) => {
    if (balance === null || balance === undefined || !Number.isFinite(Number(balance))) {
      void fetchAccounts();
      return;
    }
    setAccounts(current => current.map(account => (account.member_account_id || account.id) === memberAccountId
      ? { ...account, balance: Number(balance), transaction_count: Number(account.transaction_count || 0) + 1 }
      : account));
  };

  const fetchData = async ({ refreshMember = false } = {}) => {
    const requestId = ++dataRequestId.current;
    const cachedMember = refreshMember ? null : getMember(id);
    if (cachedMember) {
      setMember(cachedMember);
      setLoading(false);
      setMemberLoadError('');
    } else {
      setLoading(true);
    }
    void fetchAccounts(id);
    setMemberLoadError('');
    setAccountTypes([]);
    setAccountTypesError('');
    setNewAccount((current) => ({ ...current, account_type_id: '' }));
    try {
      const [memberRes, typesRes, fieldsRes, docsRes, docConfigsRes] = await Promise.all([
        cachedMember ? Promise.resolve(null) : fetchWithAuth(`/api/members/${id}`, { cache: 'no-store' }),
        fetchWithAuth('/api/account-types', { cache: 'no-store' }),
        fetchWithAuth('/api/member-field-configs', { cache: 'no-store' }),
        fetchWithAuth(`/api/member-documents?member_id=${id}`, { cache: 'no-store' }),
        fetchWithAuth('/api/member-document-configs', { cache: 'no-store' }),
      ]);
      if (requestId !== dataRequestId.current) return;
      const memberJson = cachedMember
        ? { success: true, data: cachedMember }
        : await memberRes.json();
      const typesJson = await typesRes.json();
      const fieldsJson = await fieldsRes.json();
      if (fieldsJson.success) setMemberFields(fieldsJson.data || []);
      const docsJson = await docsRes.json();
      const docConfigsJson = await docConfigsRes.json();
      if (!memberJson.success) {
        setMemberLoadError(memberRes?._status === 404
          ? 'Member not found or you do not have access to it.'
          : memberJson.error || 'Could not load this member. Please try again.');
        if (!cachedMember) setMember(null);
        return;
      }
      if (docsJson.success) setMemberDocuments(docsJson.data || []);
      if (docConfigsJson.success) {
        const enabled = (docConfigsJson.data || []).filter((item) => item.is_enabled);
        setDocumentConfigs(enabled);
        setDocumentKey((current) => current || enabled[0]?.document_key || '');
      }
      if (memberJson.success) {
        const m = memberJson.data;
        rememberMember(m);
        setMember(m);
        setEditForm({
          first_name: m.first_name || '',
          last_name: m.last_name || '',
          other_name: m.other_name || '',
          email: m.email || '',
          phone: m.phone || '',
          national_id: m.national_id || '',
          id_type: m.id_type || 'national_id',
          gender: m.gender || '',
          date_of_birth: m.date_of_birth?.split('T')[0] || '',
          address: m.address || '',
          occupation: m.occupation || '',
          employer: m.employer || '',
          monthly_income: m.monthly_income || '',
          emergency_contact_name: m.emergency_contact_name || '',
          emergency_contact_phone: m.emergency_contact_phone || '',
          next_of_kin_name: m.next_of_kin_name || '',
          next_of_kin_phone: m.next_of_kin_phone || '',
          next_of_kin_relationship: m.next_of_kin_relationship || '',
          notes: m.notes || '',
          custom_fields: Object.fromEntries((fieldsJson.data || [])
            .filter((field) => field.is_active && !['first_name','last_name','other_name','gender','date_of_birth','national_id','id_type','email','phone','address','occupation','employer','monthly_income','emergency_contact_name','emergency_contact_phone','next_of_kin_name','next_of_kin_phone','next_of_kin_relationship','notes','photo_url','id_photo_url'].includes(field.field_name))
            .filter((field) => Object.hasOwn(m.custom_fields || {}, field.field_name))
            .map((field) => [field.field_name, m.custom_fields[field.field_name]])),
        });
      }
      if (typesJson.success) {
        setAccountTypes(typesJson.data || []);
        setAccountTypesError('');
        const firstType = (typesJson.data || [])[0];
        if (firstType) setNewAccount(a => ({ ...a, account_type_id: firstType.id }));
      } else {
        setAccountTypes([]);
        setAccountTypesError(typesJson.error || 'Could not load account types.');
        setNewAccount((current) => ({ ...current, account_type_id: '' }));
      }
    } catch (err) {
      if (requestId !== dataRequestId.current) return;
      console.error(err);
      setMemberLoadError(err.message || 'Could not load this member. Please try again.');
    } finally {
      if (requestId === dataRequestId.current) setLoading(false);
    }
  };

  const fetchAuditLog = async () => {
    setAuditLoading(true);
    try {
      const res = await fetchWithAuth(`/api/members/${id}/audit`);
      const json = await res.json();
      if (json.success) setAuditLog(json.data || []);
    } catch {
      setAuditLog([]);
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    return () => {
      dataRequestId.current += 1;
      accountsRequestId.current += 1;
    };
  }, [id]);
  useEffect(() => {
    if (activeTab === 'Audit Trail') fetchAuditLog();
  }, [activeTab]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetchWithAuth(`/api/members/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      const json = await res.json();
      if (json.success) {
        toast.success('Member updated');
        setEditing(false);
        rememberMember(json.data);
        setMember((current) => ({ ...current, ...json.data }));
      } else {
        toast.error(json.error || 'Update failed');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(false);
    }
  };

  const uploadMemberDocument = async (event) => {
    event.preventDefault();
    if (!documentFile || !documentKey) return toast.error('Choose a document type and file');
    setUploadingDocument(true);
    try {
      const data = new FormData();
      data.set('member_id', id);
      data.set('document_key', documentKey);
      data.set('file', documentFile);
      const response = await fetchWithAuth('/api/member-documents', { method: 'POST', body: data });
      const result = await response.json();
      if (!result.success) return toast.error(result.error || 'Upload failed');
      toast.success('Private document uploaded');
      setDocumentFile(null);
      fetchData({ refreshMember: true });
    } catch { toast.error('Upload failed'); }
    finally { setUploadingDocument(false); }
  };

  const handleStatusChange = async (newStatus) => {
    try {
      const res = await fetchWithAuth(`/api/members/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json();
      if (json.success) {
        toast.success(`Member ${newStatus}`);
        rememberMember(json.data);
        setMember((current) => ({ ...current, ...json.data }));
      } else {
        toast.error(json.error || 'Failed to update status');
      }
    } catch {
      toast.error('Network error');
    }
  };

  const handleCreateAccount = async (e) => {
    e.preventDefault();
    setCreatingAccount(true);
    try {
      const res = await fetchWithAuth(`/api/members/${id}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAccount),
      });
      const json = await res.json();
      if (json.success) {
        toast.success('Account opened');
        setShowNewAccount(false);
        setNewAccount({ account_type_id: accountTypes[0]?.id || '', currency: 'UGX' });
        fetchAccounts();
      } else {
        toast.error(json.error || 'Failed to open account');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setCreatingAccount(false);
    }
  };

  const handleTransaction = async (e) => {
    e.preventDefault();
    if (!txAmount || parseFloat(txAmount) <= 0 || !txModal) return;
    setTxLoading(true);
    try {
      const res = await fetchWithAuth('/api/savings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: txModal.action,
          member_account_id: txModal.accountId,
          amount: parseFloat(txAmount),
          description: txDescription || `${txModal.action === 'deposit' ? 'Deposit' : 'Withdrawal'} — ${txModal.accountNumber}`,
          payment_method: txModal.paymentMethod || 'cash',
        }),
      });
      const json = await res.json();
      if (json.success) {
        if (json.transaction?.id || json.data?.transaction?.id) {
          const transaction = json.transaction || json.data.transaction;
          setReceiptNumber(transaction.receipt_number || `RCP-${String(transaction.id).replace(/-/g, '').toUpperCase()}`);
        }
        toast.success(`${txModal.action === 'deposit' ? 'Deposit' : 'Withdrawal'} successful`);
        setTxModal(null);
        setTxAmount('');
        setTxDescription('');
        applyAccountBalance(txModal.accountId, json.balance);
        if (selectedAccount === txModal.accountId) fetchLedger(txModal.accountId);
      } else {
        toast.error(json.error || 'Transaction failed');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setTxLoading(false);
    }
  };

  const fetchLedger = async (accountId) => {
    setSelectedAccount(prev => prev === accountId ? null : accountId);
    if (selectedAccount === accountId) return;
    try {
      const res = await fetchWithAuth(`/api/members/${id}/accounts/${accountId}/ledger?limit=20`);
      const json = await res.json();
      if (json.success) setLedger(json.data || []);
    } catch {
      setLedger([]);
    }
  };

  useApiRefresh(() => {
    void fetchData({ refreshMember: true });
    if (activeTab === 'Audit Trail') void fetchAuditLog();
  });

  if (loading) return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  if (!member) return <div className="p-6 text-center text-muted-foreground">
    <p>{memberLoadError || 'Member not found or you do not have access to it.'}</p>
    {memberLoadError && <button type="button" onClick={fetchData} className="mt-3 text-blue-600 underline">Try again</button>}
  </div>;

  const totalBalance = accounts.reduce((s, a) => s + parseFloat(a.balance || 0), 0);
  const inputClass = 'w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';

  const displayName = member.first_name
    ? [member.first_name, member.other_name, member.last_name].filter(Boolean).join(' ')
    : member.full_name;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Back link */}
      <Link href="/app/members" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Back to Members
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <Users className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{displayName}</h1>
            <p className="text-sm text-muted-foreground font-mono">{member.membership_number}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_STYLES[member.status] || ''}`}>
            {member.status}
          </span>
          {activeTab === 'Profile' && !editing && (
            <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted transition">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </button>
          )}
        </div>
      </div>

      {receiptNumber && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span>Transaction recorded. Receipt {receiptNumber}</span>
          <Link href={`/api/receipts/${encodeURIComponent(receiptNumber)}`} target="_blank" rel="noreferrer" className="font-semibold underline">Print receipt</Link>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground mb-1">Accounts</div>
          <div className="text-xl font-bold">{accounts.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground mb-1">Total Balance</div>
          <div className="text-xl font-bold text-blue-600">{fmtCurrency(totalBalance)}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs text-muted-foreground mb-1">Joined</div>
          <div className="text-xl font-bold">
            {(member.joined_date || member.joined_at)
              ? new Date(member.joined_date || member.joined_at).toLocaleDateString()
              : '—'}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-0">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
              {tab === 'Accounts' && accounts.length > 0 && (
                <span className="ml-1.5 text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">{accounts.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* === PROFILE TAB === */}
      {activeTab === 'Profile' && (
        <div className="space-y-4">
          {member.profile_incomplete && <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            This profile needs an update. Missing: {[...(member.missing_required_fields || []), ...(member.missing_required_documents || [])].join(', ')}
          </div>}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-muted-foreground" /> Personal Information
              </h3>
              {editing && (
                <div className="flex gap-2">
                  <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted">
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                  <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                    <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              )}
            </div>

            {editing ? (
              <div className="space-y-5">
                {/* Personal */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Personal Details</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className={labelClass}>First Name</label>
                      <input value={editForm.first_name} onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))} className={inputClass} placeholder="First name" />
                    </div>
                    <div>
                      <label className={labelClass}>Other Name</label>
                      <input value={editForm.other_name} onChange={e => setEditForm(f => ({ ...f, other_name: e.target.value }))} className={inputClass} placeholder="Middle name" />
                    </div>
                    <div>
                      <label className={labelClass}>Last Name</label>
                      <input value={editForm.last_name} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} className={inputClass} placeholder="Last name" />
                    </div>
                    <div>
                      <label className={labelClass}>Gender</label>
                      <select value={editForm.gender} onChange={e => setEditForm(f => ({ ...f, gender: e.target.value }))} className={inputClass}>
                        <option value="">—</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Date of Birth</label>
                      <input type="date" value={editForm.date_of_birth} onChange={e => setEditForm(f => ({ ...f, date_of_birth: e.target.value }))} className={inputClass} />
                    </div>
                  </div>
                </div>
                {/* Identification */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Identification</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>ID Type</label>
                      <select value={editForm.id_type} onChange={e => setEditForm(f => ({ ...f, id_type: e.target.value }))} className={inputClass}>
                        <option value="national_id">National ID</option>
                        <option value="passport">Passport</option>
                        <option value="voter_id">Voter ID</option>
                        <option value="driving_licence">Driving Licence</option>
                        <option value="military_id">Military ID</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>ID Number</label>
                      <input value={editForm.national_id} onChange={e => setEditForm(f => ({ ...f, national_id: e.target.value }))} className={inputClass} />
                    </div>
                  </div>
                </div>
                {/* Contact */}
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Contact</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>Phone</label>
                      <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} className={inputClass} />
                    </div>
                    <div>
                      <label className={labelClass}>Email</label>
                      <input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} className={inputClass} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className={labelClass}>Address</label>
                      <input value={editForm.address} onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))} className={inputClass} />
                    </div>
                  </div>
                </div>
                {memberFields.filter((field) => field.is_active && !['first_name','last_name','other_name','gender','date_of_birth','national_id','id_type','email','phone','address','occupation','employer','monthly_income','emergency_contact_name','emergency_contact_phone','next_of_kin_name','next_of_kin_phone','next_of_kin_relationship','notes','photo_url','id_photo_url'].includes(field.field_name)).map((field) => (
                  <div key={field.field_name}>
                    <label className={labelClass}>{field.label}{field.is_required ? ' *' : ''}</label>
                    <input type={field.field_type === 'email' ? 'email' : field.field_type === 'date' ? 'date' : field.field_type === 'number' ? 'number' : 'text'}
                      value={editForm.custom_fields?.[field.field_name] || ''}
                      onChange={(event) => setEditForm((previous) => ({ ...previous,
                        custom_fields: { ...(previous.custom_fields || {}), [field.field_name]: event.target.value },
                      }))}
                      className={inputClass} />
                  </div>
                ))}
                {/* Advanced toggle */}
                <div>
                  <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-xs font-medium text-blue-600 hover:underline flex items-center gap-1">
                    {showAdvanced ? '▾ Hide advanced fields' : '▸ Show employment, next of kin & notes'}
                  </button>
                  {showAdvanced && (
                    <div className="mt-4 space-y-5">
                      {/* Employment */}
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Employment</p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div>
                            <label className={labelClass}>Occupation</label>
                            <input value={editForm.occupation} onChange={e => setEditForm(f => ({ ...f, occupation: e.target.value }))} className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>Employer</label>
                            <input value={editForm.employer} onChange={e => setEditForm(f => ({ ...f, employer: e.target.value }))} className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>Monthly Income</label>
                            <input type="number" value={editForm.monthly_income} onChange={e => setEditForm(f => ({ ...f, monthly_income: e.target.value }))} className={inputClass} placeholder="0" />
                          </div>
                        </div>
                      </div>
                      {/* Emergency Contact */}
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Emergency Contact</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className={labelClass}>Name</label>
                            <input value={editForm.emergency_contact_name} onChange={e => setEditForm(f => ({ ...f, emergency_contact_name: e.target.value }))} className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>Phone</label>
                            <input value={editForm.emergency_contact_phone} onChange={e => setEditForm(f => ({ ...f, emergency_contact_phone: e.target.value }))} className={inputClass} />
                          </div>
                        </div>
                      </div>
                      {/* Next of Kin */}
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Next of Kin</p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div>
                            <label className={labelClass}>Name</label>
                            <input value={editForm.next_of_kin_name} onChange={e => setEditForm(f => ({ ...f, next_of_kin_name: e.target.value }))} className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>Phone</label>
                            <input value={editForm.next_of_kin_phone} onChange={e => setEditForm(f => ({ ...f, next_of_kin_phone: e.target.value }))} className={inputClass} />
                          </div>
                          <div>
                            <label className={labelClass}>Relationship</label>
                            <input value={editForm.next_of_kin_relationship} onChange={e => setEditForm(f => ({ ...f, next_of_kin_relationship: e.target.value }))} className={inputClass} placeholder="e.g. Spouse" />
                          </div>
                        </div>
                      </div>
                      {/* Notes */}
                      <div>
                        <label className={labelClass}>Notes</label>
                        <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} rows={3} className={inputClass + ' resize-none'} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Personal info view */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                  {member.email && <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-muted-foreground shrink-0" />{member.email}</div>}
                  {member.phone && <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-muted-foreground shrink-0" />{member.phone}</div>}
                  {member.national_id && (
                    <div className="flex items-center gap-2">
                      <IdCard className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="capitalize">{(member.id_type || 'national_id').replace('_', ' ')}</span>: {member.national_id}
                    </div>
                  )}
                  {member.gender && (
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                      Gender: <span className="capitalize">{member.gender}</span>
                    </div>
                  )}
                  {member.date_of_birth && (
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
                      DOB: {new Date(member.date_of_birth).toLocaleDateString()}
                    </div>
                  )}
                  {member.address && (
                    <div className="flex items-center gap-2 md:col-span-2">
                      <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />{member.address}
                    </div>
                  )}
                </div>
                {/* Employment */}
                {(member.occupation || member.employer || member.monthly_income) && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Employment</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                      {member.occupation && <div className="flex items-center gap-2"><Briefcase className="w-4 h-4 text-muted-foreground shrink-0" />{member.occupation}</div>}
                      {member.employer && <div className="flex items-center gap-2"><Briefcase className="w-4 h-4 text-muted-foreground shrink-0" />{member.employer}</div>}
                      {member.monthly_income && <div className="flex items-center gap-2"><span className="text-muted-foreground text-xs">Income:</span> {fmtCurrency(member.monthly_income)}/mo</div>}
                    </div>
                  </div>
                )}
                {/* Next of Kin */}
                {(member.next_of_kin_name || member.emergency_contact_name) && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Emergency & Next of Kin</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
                      {member.emergency_contact_name && (
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                          {member.emergency_contact_name}
                          {member.emergency_contact_phone && <span className="text-muted-foreground">· {member.emergency_contact_phone}</span>}
                        </div>
                      )}
                      {member.next_of_kin_name && (
                        <div className="flex items-center gap-2">
                          <Heart className="w-4 h-4 text-muted-foreground shrink-0" />
                          {member.next_of_kin_name}
                          {member.next_of_kin_relationship && <span className="text-muted-foreground capitalize">· {member.next_of_kin_relationship}</span>}
                          {member.next_of_kin_phone && <span className="text-muted-foreground">· {member.next_of_kin_phone}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {/* Notes */}
                {member.notes && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                    <p className="text-sm text-foreground/80 whitespace-pre-wrap">{member.notes}</p>
                  </div>
                )}
              </div>
            )}

            {/* Status actions */}
            {!editing && member.status !== 'exited' && (
              <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
                {member.status !== 'active' && (
                  <button onClick={() => handleStatusChange('active')} className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400">
                    Activate
                  </button>
                )}
                {member.status !== 'suspended' && (
                  <button onClick={() => handleStatusChange('suspended')} className="text-xs px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400">
                    Suspend
                  </button>
                )}
                {member.status !== 'blocked' && (
                  <button onClick={() => handleStatusChange('blocked')} className="text-xs px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
                    Block
                  </button>
                )}
                {member.status !== 'inactive' && (
                  <button onClick={() => handleStatusChange('inactive')} className="text-xs px-3 py-1.5 bg-gray-50 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-400">
                    Deactivate
                  </button>
                )}
                <button onClick={() => handleStatusChange('exited')} className="text-xs px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
                  Exit Member
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* === ACCOUNTS TAB === */}
      {activeTab === 'Accounts' && (
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-foreground">Member Accounts ({accounts.length})</h3>
            <button onClick={() => setShowNewAccount(!showNewAccount)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition">
              <Plus className="w-3.5 h-3.5" /> {showNewAccount ? 'Cancel' : 'Open Account'}
            </button>
          </div>

          {showNewAccount && (
            accountTypes.length === 0 ? <p role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {accountTypesError || 'No account types are configured yet. Create an account type before opening an account.'}
            </p> :
            <form onSubmit={handleCreateAccount} className="flex items-end gap-3 mb-4 p-3 bg-muted/30 rounded-lg border border-border">
              <div className="flex-1">
                <label className={labelClass}>Account Type</label>
                <select value={newAccount.account_type_id} onChange={e => setNewAccount(a => ({ ...a, account_type_id: e.target.value }))} className={inputClass}>
                  {accountTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({t.code})</option>
                  ))}
                </select>
              </div>
              <div className="w-28">
                <label className={labelClass}>Currency</label>
                <select value={newAccount.currency} onChange={e => setNewAccount(a => ({ ...a, currency: e.target.value }))} className={inputClass}>
                  <option value="UGX">UGX</option>
                  <option value="USD">USD</option>
                  <option value="KES">KES</option>
                </select>
              </div>
              <button type="submit" disabled={creatingAccount || !newAccount.account_type_id}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap">
                {creatingAccount ? 'Opening...' : 'Open'}
              </button>
            </form>
          )}

          {accountsLoading && accounts.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">Loading accounts...</p>
          ) : accountsError && accounts.length === 0 ? (
            <div role="alert" className="text-sm text-red-600">
              <p>{accountsError}</p>
              <button type="button" onClick={() => fetchAccounts()} className="mt-2 underline">Retry loading accounts</button>
            </div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts yet. Open an account to start transacting.</p>
          ) : (
            <div className="space-y-2">
              {accountsError && <p role="alert" className="text-sm text-amber-700">{accountsError}</p>}
              {accountsLoading && <p role="status" className="text-sm text-muted-foreground">Refreshing accounts...</p>}
              {accounts.map(a => {
                const accId = a.member_account_id || a.id;
                return (
                  <div key={accId} className="border border-border rounded-lg hover:bg-muted/20 transition">
                    <div className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-3">
                        <CreditCard className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div>
                          <div className="text-sm font-medium">{a.account_type_name || a.account_type?.replace('_', ' ')} Account</div>
                          <div className="text-xs text-muted-foreground font-mono">{a.account_number}</div>
                          {a.maturity_date && (
                            <div className="text-xs text-amber-600 mt-0.5">Matures: {new Date(a.maturity_date).toLocaleDateString()}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[a.status] || ''}`}>
                          {a.status}
                        </span>
                        <div className="text-right">
                          <div className="text-sm font-bold">{fmtCurrency(a.balance, a.currency)}</div>
                          <div className="text-xs text-muted-foreground">{a.transaction_count || 0} txns</div>
                        </div>
                        {a.status === 'active' && (
                          <div className="flex gap-1">
                            <button onClick={() => setTxModeModal({ action: 'deposit', accountId: accId, account: a })}
                              className="p-1.5 rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400" title="Deposit">
                              <ArrowDownRight className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setTxModeModal({ action: 'withdraw', accountId: accId, account: a })}
                              className="p-1.5 rounded-md bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400" title="Withdraw">
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => fetchLedger(accId)}
                              className="p-1.5 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400" title="View Ledger">
                              <History className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {selectedAccount === accId && (
                      <div className="border-t border-border px-3 py-2 bg-muted/10">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-muted-foreground">Transaction History</span>
                          <button onClick={() => setSelectedAccount(null)} className="text-xs text-muted-foreground hover:text-foreground">&times; Close</button>
                        </div>
                        {ledger.length === 0 ? (
                          <p className="text-xs text-muted-foreground py-2">No transactions yet</p>
                        ) : (
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {ledger.map(le => (
                              <div key={le.id} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                                <div className="flex items-center gap-2">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${le.entry_type === 'CREDIT' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                  <span className="text-muted-foreground">{le.tx_description || le.description}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className={le.entry_type === 'CREDIT' ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>
                                    {le.entry_type === 'CREDIT' ? '+' : '-'}{fmtCurrency(le.amount, a.currency)}
                                  </span>
                                  <span className="text-muted-foreground/60">{new Date(le.created_at).toLocaleDateString()}</span>
                                  <Link href={`/api/receipts/${encodeURIComponent(le.receipt_number || `RCP-${String(le.transaction_id).replace(/-/g, '').toUpperCase()}`)}`} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 hover:underline dark:text-emerald-400">Receipt</Link>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* === AUDIT TRAIL TAB === */}
      {activeTab === 'Documents' && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-5">
          <h3 className="font-semibold">Private member documents</h3>
          {documentConfigs.length > 0 && <form onSubmit={uploadMemberDocument} className="flex flex-wrap items-end gap-3 border-b border-border pb-5">
            <label className="text-xs text-muted-foreground">Document type
              <select value={documentKey} onChange={(event) => setDocumentKey(event.target.value)} className="block mt-1 px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm">
                {documentConfigs.map((config) => <option key={config.document_key} value={config.document_key}>{config.label}{config.is_required ? ' *' : ''}</option>)}
              </select>
            </label>
            <input type="file" accept={documentConfigs.find((item) => item.document_key === documentKey)?.accepted_mime_types.join(',')}
              onChange={(event) => setDocumentFile(event.target.files?.[0] || null)} className="text-sm" />
            <button disabled={uploadingDocument || !documentFile} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
              {uploadingDocument ? 'Uploading…' : 'Upload privately'}
            </button>
          </form>}
          {memberDocuments.length === 0 ? <p className="text-sm text-muted-foreground">No documents have been uploaded.</p> :
            <div className="divide-y divide-border">
              {memberDocuments.map((document) => <div key={document.id} className="flex items-center justify-between gap-4 py-3">
                <div><p className="text-sm font-medium">{documentConfigs.find((item) => item.document_key === document.document_key)?.label || document.document_key}</p>
                  <p className="text-xs text-muted-foreground">{document.original_filename} · {Math.ceil(Number(document.file_size) / 1024)} KB</p></div>
                <a href={document.download_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">Download</a>
              </div>)}
            </div>}
          <p className="text-xs text-muted-foreground">Download links expire after five minutes. Access and link issuance are recorded in the audit log.</p>
        </div>
      )}

      {/* === AUDIT TRAIL TAB === */}
      {activeTab === 'Audit Trail' && (
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground flex items-center gap-2 mb-4">
            <ClipboardList className="w-4 h-4 text-muted-foreground" /> Audit Trail
          </h3>
          {auditLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : auditLog.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audit records found.</p>
          ) : (
            <div className="relative">
              <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />
              <div className="space-y-4">
                {auditLog.map((entry, i) => (
                  <div key={entry.id || i} className="flex gap-4 pl-8 relative">
                    <div className="absolute left-1.5 top-1.5 w-3 h-3 rounded-full bg-card border-2 border-blue-500" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${AUDIT_ACTION_STYLES[entry.action] || 'bg-gray-100 text-gray-600'}`}>
                            {entry.action?.replace('_', ' ')}
                          </span>
                          <span className="text-sm font-medium text-foreground">
                            {entry.performed_by_name || entry.performed_by_email || 'System'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap shrink-0">
                          <Clock className="w-3 h-3" />
                          {new Date(entry.created_at).toLocaleString()}
                        </div>
                      </div>
                      {entry.notes && <p className="text-xs text-muted-foreground mt-1">{entry.notes}</p>}
                      {entry.new_values && Object.keys(entry.new_values).length > 0 && (
                        <div className="mt-2 text-xs bg-muted/50 rounded-lg p-2 space-y-0.5 max-h-24 overflow-y-auto">
                          {Object.entries(entry.new_values).map(([k, v]) => (
                            <div key={k} className="flex gap-2">
                              <span className="text-muted-foreground capitalize min-w-[100px]">{k.replace(/_/g, ' ')}:</span>
                              <span className="text-foreground font-mono break-all">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Deposit/Withdraw Modal */}
      {txModeModal && (
        <TransactionModeDialog
          action={txModeModal.action}
          account={{ memberAccountId: txModeModal.accountId, label: `${member?.full_name || 'Member'} · ${txModeModal.account.account_number || ''}`, balance: txModeModal.account.balance }}
          onClose={() => setTxModeModal(null)}
          onManual={(paymentMethod) => { setTxModeModal(null); setTxModal({ action: txModeModal.action, accountId: txModeModal.accountId, accountNumber: txModeModal.account.account_number, paymentMethod }); }}
          onSuccess={(data) => { toast.success(`${txModeModal.action === 'deposit' ? 'Deposit' : 'Withdrawal'} confirmed by MarzPay`); applyAccountBalance(txModeModal.accountId, data?.balance); setTxModeModal(null); fetchLedger(txModeModal.accountId); }}
        />
      )}
      {txModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form onSubmit={handleTransaction} className="bg-card border border-border rounded-xl p-6 w-full max-w-sm space-y-4 shadow-xl">
            <h3 className="text-lg font-semibold text-foreground capitalize">
              {txModal.action === 'deposit' ? '💰 Deposit' : '💸 Withdraw'}
            </h3>
            <p className="text-xs text-muted-foreground">Account: {txModal.accountNumber}</p>
            <div>
              <label className={labelClass}>Amount (UGX)</label>
              <input type="number" min="1" step="1" value={txAmount} onChange={e => setTxAmount(e.target.value)}
                required placeholder="100000" className={inputClass} autoFocus />
            </div>
            <div>
              <label className={labelClass}>Description (optional)</label>
              <input value={txDescription} onChange={e => setTxDescription(e.target.value)}
                placeholder={txModal.action === 'deposit' ? 'Member deposit' : 'Member withdrawal'} className={inputClass} />
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => { setTxModal(null); setTxAmount(''); setTxDescription(''); }}
                className="flex-1 px-4 py-2 border border-border rounded-lg text-sm hover:bg-muted">Cancel</button>
              <button type="submit" disabled={txLoading}
                className={`flex-1 px-4 py-2 rounded-lg text-sm text-white font-medium disabled:opacity-50 ${txModal.action === 'deposit' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
                {txLoading ? 'Processing...' : txModal.action === 'deposit' ? 'Deposit' : 'Withdraw'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
