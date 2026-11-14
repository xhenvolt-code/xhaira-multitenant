'use client';

import { useCallback, useEffect, useState } from 'react';
import { Users, Plus, UserPlus, X, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import MemberRegistrationForm from '@/components/members/MemberRegistrationForm';
import { useToast } from '@/components/ui/Toast';
import Link from 'next/link';

export default function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [policy, setPolicy] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeGroup, setActiveGroup] = useState(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [selectedMember, setSelectedMember] = useState('');
  const toast = useToast();

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetchWithAuth('/api/groups');
      const result = await response.json();
      if (result.success) {
        setGroups(result.data || []);
        setPolicy(result.policy || {});
      } else {
        setGroups([]);
        setLoadError(result.error || 'Could not load groups. Please try again.');
      }
    } catch (error) {
      setGroups([]);
      setLoadError(error.message || 'Could not load groups. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);
  useEffect(() => {
    const refresh = () => loadGroups();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [loadGroups]);
  const disabled = policy['groups.requirement'] === 'disabled';

  const refreshGroupMembers = async (group) => {
    try {
      const membersResponse = await fetchWithAuth(`/api/groups/${group.id}/members`);
      const memberResult = await membersResponse.json();
      if (memberResult.success) setGroupMembers(memberResult.data || []);
    } catch { toast.error('Could not load group members'); }
  };

  const manageGroup = async (group) => {
    if (activeGroup?.id === group.id) { setActiveGroup(null); return; }
    setActiveGroup(group);
    try {
      const [membersResponse, candidatesResponse] = await Promise.all([
        fetchWithAuth(`/api/groups/${group.id}/members`), fetchWithAuth('/api/members?limit=100'),
      ]);
      const [memberResult, candidatesResult] = await Promise.all([membersResponse.json(), candidatesResponse.json()]);
      if (memberResult.success) setGroupMembers(memberResult.data || []);
      if (candidatesResult.success) setCandidates((candidatesResult.data || []).filter((member) => member.member_kind !== 'group'));
    } catch { toast.error('Could not load group members'); }
  };

  const addMember = async () => {
    if (!selectedMember || !activeGroup) return;
    try {
      const response = await fetchWithAuth(`/api/groups/${activeGroup.id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: selectedMember }),
      });
      const result = await response.json();
      if (!result.success) return toast.error(result.error || 'Could not add member');
      setSelectedMember('');
      await refreshGroupMembers(activeGroup);
      loadGroups();
    } catch { toast.error('Could not add member'); }
  };

  const removeMember = async (memberId) => {
    try {
      const response = await fetchWithAuth(`/api/groups/${activeGroup.id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: memberId }),
      });
      const result = await response.json();
      if (!result.success) return toast.error(result.error || 'Could not remove member');
      await refreshGroupMembers(activeGroup);
      loadGroups();
    } catch { toast.error('Could not remove member'); }
  };

  return <div className="p-6 max-w-6xl mx-auto space-y-6">
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="w-6 h-6 text-blue-500" /> Groups</h1>
        <p className="text-sm text-muted-foreground mt-1">Groups follow your organization’s membership policy.</p>
      </div>
      <div className="flex items-center gap-2">
        {!disabled && <button onClick={() => setShowForm((value) => !value)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm">
          <Plus className="w-4 h-4" /> {showForm ? 'Cancel' : 'New Group'}
        </button>}
        <button onClick={loadGroups} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50" aria-label="Refresh groups">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
    </header>
    {showForm && <MemberRegistrationForm memberKind="group" onDone={() => { setShowForm(false); loadGroups(); }} />}
    {loading ? <p className="text-muted-foreground">Loading groups…</p> : loadError ?
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-8 text-center text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
        <p>{loadError}</p><button onClick={loadGroups} className="mt-3 text-sm underline">Retry</button>
      </div> : groups.length === 0 ?
      <div className="rounded-xl border border-border bg-card p-10 text-center text-muted-foreground">No groups have been registered.</div> :
      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {groups.map((group) => <div key={group.id} className="p-4">
          <div className="flex items-center justify-between">
            <div className="font-medium">{group.full_name}</div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{group.member_count || 0} members</span>
              <Link href={`/app/groups/${group.id}`} className="text-sm text-blue-600 hover:underline">Open group</Link>
              {!disabled && ['sub_organization', 'both'].includes(policy['groups.nature']) && <button onClick={() => manageGroup(group)} className="text-sm text-blue-600 hover:underline">{activeGroup?.id === group.id ? 'Close' : 'Manage members'}</button>}
            </div>
          </div>
          {activeGroup?.id === group.id && <div className="mt-4 border-t border-border pt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <select value={selectedMember} onChange={(event) => setSelectedMember(event.target.value)} className="px-3 py-2 border border-border rounded-lg bg-background text-sm">
                <option value="">Select an individual member</option>
                {candidates.filter((candidate) => !groupMembers.some((item) => item.id === candidate.id)).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.full_name}</option>)}
              </select>
              <button onClick={addMember} disabled={!selectedMember} className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"><UserPlus className="w-4 h-4" /> Add</button>
            </div>
            {groupMembers.map((member) => <div key={member.id} className="flex items-center justify-between text-sm">
              <span>{member.full_name} <span className="text-xs text-muted-foreground">{member.membership_number}</span></span>
              <button onClick={() => removeMember(member.id)} title="Remove from group" className="p-1 text-red-600"><X className="w-4 h-4" /></button>
            </div>)}
          </div>}
        </div>)}
      </div>}
  </div>;
}
