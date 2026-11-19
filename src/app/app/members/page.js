'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Users, Search, UserCheck, UserX, Phone, Mail, CreditCard, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency as fmtCurrency } from '@/lib/format-currency';
import Link from 'next/link';
import MemberRegistrationForm from '@/components/members/MemberRegistrationForm';
import { useMembersData } from './members-data-context';

const STATUS_STYLES = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  exited: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  blocked: 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export default function MembersPage() {
  const { rememberMembers } = useMembersData();
  const [members, setMembers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeView, setActiveView] = useState('members');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const membersRequestId = useRef(0);

  const fetchMembers = async () => {
    const requestId = ++membersRequestId.current;
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      params.set('kind', 'individual');
      params.set('limit', '100');
      params.set('page', '1');
      const firstResponse = await fetchWithAuth(`/api/members?${params}`, { cache: 'no-store' });
      const firstPage = await firstResponse.json();
      if (!firstResponse._ok || !firstPage.success) {
        throw new Error(firstPage.error || 'Could not load members. Please try again.');
      }

      const totalPages = Math.max(1, Number(firstPage.pagination?.totalPages) || 1);
      const remainingPages = [];
      for (let firstPageNumber = 2; firstPageNumber <= totalPages; firstPageNumber += 5) {
        const pageNumbers = Array.from(
          { length: Math.min(5, totalPages - firstPageNumber + 1) },
          (_, index) => firstPageNumber + index
        );
        const pages = await Promise.all(pageNumbers.map(async (pageNumber) => {
          const pageParams = new URLSearchParams(params);
          pageParams.set('page', String(pageNumber));
          const response = await fetchWithAuth(`/api/members?${pageParams}`, { cache: 'no-store' });
          const page = await response.json();
          if (!response._ok || !page.success) {
            throw new Error(page.error || `Could not load members page ${pageNumber}.`);
          }
          return page.data || [];
        }));
        remainingPages.push(...pages);
        if (requestId !== membersRequestId.current) return;
      }

      if (requestId !== membersRequestId.current) return;
      const loadedMembers = [...(firstPage.data || []), ...remainingPages.flat()];
      setMembers(loadedMembers);
      rememberMembers(loadedMembers);
    } catch (err) {
      if (requestId !== membersRequestId.current) return;
      console.error('Failed to fetch members:', err);
      setLoadError(err.message || 'Could not load members. Please check your connection and try again.');
    } finally {
      if (requestId === membersRequestId.current) setLoading(false);
    }
  };

  const fetchGroups = async () => {
    const requestId = ++membersRequestId.current;
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetchWithAuth('/api/groups', { cache: 'no-store' });
      const result = await response.json();
      if (!response._ok || !result.success) {
        throw new Error(result.error || 'Could not load groups. Please try again.');
      }
      if (requestId !== membersRequestId.current) return;
      setGroups(result.data || []);
    } catch (err) {
      if (requestId !== membersRequestId.current) return;
      console.error('Failed to fetch groups:', err);
      setLoadError(err.message || 'Could not load groups. Please check your connection and try again.');
    } finally {
      if (requestId === membersRequestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (activeView === 'members') fetchMembers();
    else fetchGroups();
    return () => { membersRequestId.current += 1; };
  }, [activeView, search, statusFilter]);

  const activeCount = members.filter(m => m.status === 'active').length;
  const totalBalance = members.reduce((sum, m) => sum + parseFloat(m.total_balance || 0), 0);
  const visibleGroups = groups.filter((group) => !search ||
    group.full_name?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-500" />
            {activeView === 'members' ? 'SACCO Members' : 'SACCO Groups'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage cooperative members and groups separately</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition">
          <Plus className="w-4 h-4" /> {showForm ? 'Cancel' : activeView === 'members' ? 'New Member' : 'New Group'}
        </button>
      </div>

      <div className="flex gap-2 border-b border-border" role="tablist" aria-label="Membership type">
        {[
          { id: 'members', label: 'Members' },
          { id: 'groups', label: 'Groups' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeView === tab.id}
            onClick={() => { setActiveView(tab.id); setShowForm(false); }}
            className={`border-b-2 px-4 py-2 text-sm font-medium ${
              activeView === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">{activeView === 'members' ? 'Total Members' : 'Total Groups'}</div>
          <div className="text-2xl font-bold mt-1">{activeView === 'members' ? members.length : visibleGroups.length}</div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">{activeView === 'members' ? 'Active Members' : 'Group Members'}</div>
          <div className="text-2xl font-bold mt-1 text-emerald-600">
            {activeView === 'members' ? activeCount : visibleGroups.reduce((sum, group) => sum + Number(group.member_count || 0), 0)}
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="text-xs font-medium text-muted-foreground uppercase">{activeView === 'members' ? 'Total Balances' : 'View group details'}</div>
          <div className="text-2xl font-bold mt-1 text-blue-600">{activeView === 'members' ? fmtCurrency(totalBalance) : 'Open a group'}</div>
        </div>
      </div>

      {/* Registration Form */}
      {showForm && (
        <MemberRegistrationForm
          memberKind={activeView === 'groups' ? 'group' : 'individual'}
          onDone={() => {
            setShowForm(false);
            if (activeView === 'members') fetchMembers();
            else fetchGroups();
          }}
        />
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={activeView === 'members' ? 'Search members by name, email, phone, or membership number...' : 'Search groups by name...'}
            className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        {activeView === 'members' && <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring [&>option]:bg-background">
          <option value="">All Statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="suspended">Suspended</option>
          <option value="exited">Exited</option>
        </select>}
      </div>

      {/* Members Table */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading {activeView}...</div>
      ) : loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <p>{loadError}</p>
          <button onClick={activeView === 'members' ? fetchMembers : fetchGroups} className="mt-3 text-sm underline">Retry</button>
        </div>
      ) : activeView === 'groups' ? visibleGroups.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-muted-foreground">No groups found</p>
          <p className="text-xs text-muted-foreground mt-1">Register your first group to get started</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Group</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Members</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map((group) => (
                  <tr key={group.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition">
                    <td className="px-4 py-3 font-medium text-foreground">{group.full_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{group.member_count || 0}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/app/groups/${group.id}`} className="text-sm font-medium text-blue-600 hover:underline">
                        Open group
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
