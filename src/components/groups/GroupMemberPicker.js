'use client';

import { useMemo, useState } from 'react';

export default function GroupMemberPicker({ candidates, selectedIds, onChange, disabled = false }) {
  const [search, setSearch] = useState('');
  const visibleCandidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return candidates;
    return candidates.filter((member) =>
      `${member.full_name || ''} ${member.membership_number || ''}`.toLowerCase().includes(term)
    );
  }, [candidates, search]);

  const toggle = (id) => onChange(selectedIds.includes(id)
    ? selectedIds.filter((selectedId) => selectedId !== id)
    : [...selectedIds, id]);

  return <div className="w-full space-y-2">
    <label className="sr-only" htmlFor="group-member-search">Search members to add</label>
    <input id="group-member-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
      placeholder="Search by member name or number" disabled={disabled}
      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
    {selectedIds.length > 0 && <div className="text-xs text-muted-foreground">{selectedIds.length} member{selectedIds.length === 1 ? '' : 's'} selected</div>}
    <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border" role="group" aria-label="Individual members">
      {visibleCandidates.length ? visibleCandidates.map((member) => <label key={member.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
        <input type="checkbox" checked={selectedIds.includes(member.id)} onChange={() => toggle(member.id)} disabled={disabled} />
        <span className="min-w-0"><span className="block truncate">{member.full_name}</span><span className="block text-xs text-muted-foreground">{member.membership_number || ''}</span></span>
      </label>) : <p className="p-3 text-sm text-muted-foreground">No available members match this search.</p>}
    </div>
  </div>;
}
