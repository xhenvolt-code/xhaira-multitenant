'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, RotateCcw, Trash2, Users } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { confirmDangerous } from '@/lib/confirm';

export default function MemberTrashPage() {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const loadTrash = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetchWithAuth('/api/members/trash', { cache: 'no-store' });
      const result = await response.json();
      if (!response._ok || !result.success) throw new Error(result.error || 'Could not load Trash.');
      setMembers(result.data || []);
    } catch (loadError) {
      setError(loadError.message || 'Could not load Trash.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTrash(); }, [loadTrash]);

  const restoreMember = async (member) => {
    setBusyId(member.id);
    try {
      const response = await fetchWithAuth(`/api/members/${member.id}/trash`, { method: 'PATCH' });
      const result = await response.json();
      if (!response._ok || !result.success) throw new Error(result.error || 'Could not restore member.');
      setMembers((current) => current.filter((item) => item.id !== member.id));
    } catch (restoreError) {
      setError(restoreError.message || 'Could not restore member.');
    } finally {
      setBusyId(null);
    }
  };

  const purgeMember = async (member) => {
    const confirmed = await confirmDangerous(
      `This permanently deletes ${member.full_name}, their member accounts, ledger transactions and receipts, loans, shares, dividends, payment history, and uploaded documents. Transfers in that history may affect other members' ledger entries. This cannot be undone.`,
      'Permanently purge member?'
    );
    if (!confirmed) return;

    setBusyId(member.id);
    try {
      const response = await fetchWithAuth(`/api/members/${member.id}/permanent`, { method: 'DELETE' });
      const result = await response.json();
      if (!response._ok || !result.success) throw new Error(result.error || 'Could not purge member.');
      setMembers((current) => current.filter((item) => item.id !== member.id));
      if (result.data?.documentCleanupWarnings?.length) {
        const { default: Swal } = await import('sweetalert2');
        await Swal.fire({ title: 'Member purged', text: `${result.data.documentCleanupWarnings.length} private document file(s) could not be removed from storage.`, icon: 'warning' });
      }
    } catch (purgeError) {
      const { default: Swal } = await import('sweetalert2');
      await Swal.fire({ title: 'Purge failed', text: purgeError.message || 'Could not purge member.', icon: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/app/members" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Members
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground"><Trash2 className="h-6 w-6 text-red-500" /> Member Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">Deleted and exited members are hidden from the system while they are here. Restore them or permanently purge all their linked data.</p>
        </div>
        <button type="button" onClick={loadTrash} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {loading ? <div className="py-12 text-center text-sm text-muted-foreground">Loading Trash…</div> : members.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Users className="mx-auto mb-3 h-10 w-10 text-muted-foreground opacity-40" />
          <p className="font-medium">Trash is empty</p>
          <p className="mt-1 text-sm text-muted-foreground">Deleted or exited members will appear here.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <th className="px-4 py-3">Member</th><th className="px-4 py-3">Membership #</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Accounts</th><th className="px-4 py-3">Moved to Trash</th><th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>{members.map((member) => (
                <tr key={member.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3"><div className="font-medium">{member.full_name}</div><div className="text-xs text-muted-foreground">{member.email || member.phone || ''}</div></td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{member.membership_number || '—'}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{member.member_kind || 'individual'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.account_count || 0}</td>
                  <td className="px-4 py-3 text-muted-foreground">{member.trashed_at ? new Date(member.trashed_at).toLocaleString() : '—'}</td>
                  <td className="px-4 py-3"><div className="flex justify-end gap-2">
                    <button type="button" onClick={() => restoreMember(member)} disabled={busyId === member.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" /> Restore</button>
                    <button type="button" onClick={() => purgeMember(member)} disabled={busyId === member.id} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/30"><Trash2 className="h-3.5 w-3.5" /> Purge</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
