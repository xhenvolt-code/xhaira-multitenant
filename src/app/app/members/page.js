'use client';

import { useEffect, useState } from 'react';
import { Plus, Users, Search, UserCheck, UserX, Phone, Mail, CreditCard, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency as fmtCurrency } from '@/lib/format-currency';
import Link from 'next/link';
import MemberRegistrationForm from '@/components/members/MemberRegistrationForm';

const STATUS_STYLES = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  exited: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  blocked: 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export default function MembersPage() {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);

  const fetchMembers = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetchWithAuth(`/api/members?${params}`);
      const json = await res.json();
      if (json.success) setMembers(json.data || []);
      else {
        setMembers([]);
        setLoadError(json.error || 'Could not load members. Please try again.');
      }
    } catch (err) {
      console.error('Failed to fetch members:', err);
      setMembers([]);
      setLoadError('Could not load members. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMembers(); }, [search, statusFilter]);

  const activeCount = members.filter(m => m.status === 'active').length;
  const totalBalance = members.reduce((sum, m) => sum + parseFloat(m.total_balance || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-500" /> SACCO Members
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage cooperative membership, accounts, and balances</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
          <Plus className="w-4 h-4" /> {showForm ? 'Cancel' : 'New Member'}
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Total Members</div>
          <div className="text-2xl font-bold mt-1">{members.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Active Members</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600">{activeCount}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">Total Balances</div>
          <div className="text-2xl font-bold mt-1 text-blue-600">{fmtCurrency(totalBalance)}</div>
        </div>
      </div>

      {/* Registration Form */}
      {showForm && (
        <MemberRegistrationForm onDone={() => { setShowForm(false); fetchMembers(); }} />
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, phone, or membership number..."
            className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring [&>option]:bg-background">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
          <option value="exited">Exited</option>
        </select>
      </div>

      {/* Members Table */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading members...</div>
      ) : loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <p>{loadError}</p>
          <button onClick={fetchMembers} className="mt-3 text-sm underline">Retry</button>
        </div>
      ) : members.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-muted-foreground">No members found</p>
          <p className="text-xs text-muted-foreground mt-1">Register your first SACCO member to get started</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Member</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Contact</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Membership #</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Accounts</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Balance</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  <tr key={m.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition">
                    <td className="px-4 py-3">
                      <Link href={`/app/members/${m.id}`} className="font-medium text-foreground hover:text-blue-600 transition">
                        {m.full_name}
                      </Link>
                      {m.profile_incomplete && <div className="text-[11px] text-amber-700 dark:text-amber-400" title={[...(m.missing_required_fields || []), ...(m.missing_required_documents || [])].join(', ')}>
                        Profile needs update
                      </div>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div className="flex flex-col gap-0.5 text-xs">
                        {m.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{m.email}</span>}
                        {m.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{m.phone}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{m.membership_number}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-xs">
                        <CreditCard className="w-3 h-3 text-muted-foreground" /> {m.account_count || 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{fmtCurrency(m.total_balance)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[m.status] || ''}`}>
                        {m.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {m.joined_at ? new Date(m.joined_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
