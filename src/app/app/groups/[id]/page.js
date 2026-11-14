'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CreditCard, Edit2, Plus, Save, Trash2, UserPlus, Users, X } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { formatCurrency } from '@/lib/format-currency';
import { useToast } from '@/components/ui/Toast';

const inputClass = 'rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';

export default function GroupDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const toast = useToast();
  const [group, setGroup] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selectedMember, setSelectedMember] = useState('');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadGroup = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [groupResult, memberResult] = await Promise.all([
        fetchWithAuth(`/api/groups/${id}`),
        fetchWithAuth('/api/members?limit=100'),
      ]);
      if (!groupResult.success) throw new Error(groupResult.error || 'Could not load this group.');
      setGroup(groupResult.data);
      setName(groupResult.data.group_name);
      if (memberResult.success) setCandidates((memberResult.data || []).filter((member) => member.member_kind === 'individual'));
    } catch (error) {
      setLoadError(error.message || 'Could not load this group.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadGroup(); }, [loadGroup]);

  const addMember = async () => {
    if (!selectedMember) return;
    setSaving(true);
    try {
      const result = await fetchWithAuth(`/api/groups/${id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: selectedMember }),
      });
      if (!result.success) throw new Error(result.error || 'Could not add member.');
      setSelectedMember('');
      toast.success('Member added to group');
      await loadGroup();
    } catch (error) { toast.error(error.message || 'Could not add member.'); }
    finally { setSaving(false); }
  };

  const removeMember = async (memberId) => {
    setSaving(true);
    try {
      const result = await fetchWithAuth(`/api/groups/${id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_id: memberId }),
      });
      if (!result.success) throw new Error(result.error || 'Could not remove member.');
      toast.success('Member removed from group');
      await loadGroup();
    } catch (error) { toast.error(error.message || 'Could not remove member.'); }
    finally { setSaving(false); }
  };

  const saveName = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await fetchWithAuth(`/api/groups/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!result.success) throw new Error(result.error || 'Could not update group.');
      toast.success('Group name updated');
      setEditing(false);
      await loadGroup();
    } catch (error) { toast.error(error.message || 'Could not update group.'); }
    finally { setSaving(false); }
  };

  const deleteGroup = async () => {
    if (!window.confirm(`Remove “${group.group_name}”? This is allowed only when the group has no linked members, accounts, or loans.`)) return;
    setSaving(true);
    try {
      const result = await fetchWithAuth(`/api/groups/${id}`, { method: 'DELETE' });
      if (!result.success) throw new Error(result.error || 'Could not remove group.');
      toast.success('Group removed');
      router.push('/app/groups');
    } catch (error) { toast.error(error.message || 'Could not remove group.'); }
    finally { setSaving(false); }
  };

  if (loading && !group) return <div className="p-6 text-muted-foreground">Loading group…</div>;
  if (!group) return <div className="p-6 space-y-3"><p role="alert" className="text-muted-foreground">{loadError || 'Group not found or you do not have access to it.'}</p>{loadError && <button type="button" onClick={loadGroup} className="text-blue-600 underline">Try again</button>}<Link className="block text-blue-600 underline" href="/app/groups">Back to groups</Link></div>;

  const canManageMembers = ['sub_organization', 'both'].includes(group.policy?.['groups.nature']) && group.policy?.['groups.requirement'] !== 'disabled';
  const groupMember = Boolean(group.group_member_id);
  const totalBalance = (group.accounts || []).reduce((total, account) => total + Number(account.balance || 0), 0);
  const availableCandidates = candidates.filter((member) => !group.members.some((linked) => linked.id === member.id));

  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <Link href="/app/groups" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Groups</Link>

    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <Users className="mt-1 h-6 w-6 text-blue-600" />
        <div>
          {editing ? <form onSubmit={saveName} className="flex flex-wrap gap-2">
            <input className={inputClass} value={name} maxLength={255} required onChange={(event) => setName(event.target.value)} aria-label="Group name" />
            <button className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white" disabled={saving}><Save className="h-4 w-4" /> Save</button>
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => { setName(group.group_name); setEditing(false); }}><X className="h-4 w-4" /></button>
          </form> : <h1 className="text-2xl font-bold">{group.group_name}</h1>}
          <p className="mt-1 text-sm text-muted-foreground">{group.member_count} linked members · Created {new Date(group.created_at).toLocaleDateString()}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {!editing && <button onClick={() => setEditing(true)} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Edit2 className="h-4 w-4" /> Rename</button>}
        <button onClick={deleteGroup} disabled={saving} className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" /> Remove group</button>
      </div>
    </header>

    <section className="grid gap-4 sm:grid-cols-3">
      <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs uppercase text-muted-foreground">Linked members</div><div className="mt-1 text-2xl font-semibold">{group.member_count}</div></div>
      <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs uppercase text-muted-foreground">Accounts</div><div className="mt-1 text-2xl font-semibold">{group.accounts.length}</div></div>
      <div className="rounded-xl border border-border bg-card p-4"><div className="text-xs uppercase text-muted-foreground">Total balance</div><div className="mt-1 text-2xl font-semibold">{formatCurrency(totalBalance, 'UGX')}</div></div>
    </section>

    {groupMember ? <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3"><CreditCard className="mt-1 h-5 w-5 text-emerald-700" /><div><h2 className="font-semibold">Group accounts and transactions</h2><p className="mt-1 text-sm text-muted-foreground">View group accounts, balances, ledger entries, and record cash, bank, card, or MarzPay transactions.</p></div></div>
      <Link href={`/app/members/${group.group_member_id}`} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">Open group finance</Link>
    </section> : <section className="rounded-xl border border-border bg-muted/30 p-5"><h2 className="font-semibold">Group finance</h2><p className="mt-1 text-sm text-muted-foreground">This group is configured as a sub-organization. Transactions are recorded on its members’ individual accounts.</p></section>}

    {canManageMembers && <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div><h2 className="font-semibold">Members</h2><p className="text-sm text-muted-foreground">Add individuals to this group or remove them when their membership changes.</p></div>
      <div className="flex flex-wrap gap-2">
        <select className={inputClass} value={selectedMember} onChange={(event) => setSelectedMember(event.target.value)}>
          <option value="">Select an individual member</option>
          {availableCandidates.map((member) => <option key={member.id} value={member.id}>{member.full_name} · {member.membership_number}</option>)}
        </select>
        <button onClick={addMember} disabled={!selectedMember || saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"><UserPlus className="h-4 w-4" /> Add member</button>
      </div>
      {group.members.length ? <div className="divide-y divide-border rounded-lg border border-border">
        {group.members.map((member) => <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div><Link href={`/app/members/${member.id}`} className="font-medium text-blue-700 hover:underline">{member.full_name}</Link><div className="text-xs text-muted-foreground">{member.membership_number} · {member.status}</div></div>
          <button onClick={() => removeMember(member.id)} disabled={saving} className="rounded-lg px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50">Remove from group</button>
        </div>)}
      </div> : <p className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground">No individual members are linked to this group yet.</p>}
    </section>}

    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <div><h2 className="font-semibold">Accounts</h2><p className="text-sm text-muted-foreground">{groupMember ? 'Account status and balances for this group.' : 'This group does not hold an account under the current organization policy.'}</p></div>
      {group.accounts.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-xs uppercase text-muted-foreground"><th className="py-2">Account</th><th className="py-2">Type</th><th className="py-2">Status</th><th className="py-2 text-right">Balance</th></tr></thead><tbody>
        {group.accounts.map((account) => <tr key={account.id} className="border-b border-border last:border-0"><td className="py-3 font-mono">{account.account_number}</td><td className="py-3 capitalize">{account.account_type}</td><td className="py-3 capitalize">{account.status}</td><td className="py-3 text-right">{formatCurrency(account.balance, account.currency || 'UGX')}</td></tr>)}
      </tbody></table></div> : <p className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground">No group accounts are open.</p>}
    </section>

    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <div><h2 className="font-semibold">Recent transactions</h2><p className="text-sm text-muted-foreground">Latest account ledger entries for this group.</p></div>
      {group.recent_transactions.length ? <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-xs uppercase text-muted-foreground"><th className="py-2">Date</th><th className="py-2">Account</th><th className="py-2">Description</th><th className="py-2">Entry</th><th className="py-2 text-right">Amount</th></tr></thead><tbody>
        {group.recent_transactions.map((transaction) => <tr key={transaction.id} className="border-b border-border last:border-0"><td className="py-3">{new Date(transaction.created_at).toLocaleString()}</td><td className="py-3 font-mono">{transaction.account_number}</td><td className="py-3">{transaction.transaction_description || transaction.description || transaction.transaction_type || 'Transaction'}{transaction.reference ? <span className="ml-2 text-xs text-muted-foreground">{transaction.reference}</span> : null}</td><td className="py-3 capitalize">{String(transaction.entry_type || '').toLowerCase()}</td><td className="py-3 text-right">{formatCurrency(transaction.amount, transaction.currency || 'UGX')}</td></tr>)}
      </tbody></table></div> : <p className="rounded-lg bg-muted/30 p-4 text-sm text-muted-foreground">No transactions have been recorded for this group.</p>}
    </section>
  </div>;
}
