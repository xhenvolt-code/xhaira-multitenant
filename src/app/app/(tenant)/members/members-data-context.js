'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { usePermissions } from '@/components/providers/PermissionProvider';

const MembersDataContext = createContext(null);

export function MembersDataProvider({ children }) {
  const { user } = usePermissions();
  const cacheOwner = user?.id && user?.organizationId
    ? `${user.organizationId}:${user.id}`
    : null;
  const [memberCache, setMemberCache] = useState({ owner: null, records: {} });

  const rememberMembers = useCallback((members) => {
    if (!cacheOwner) return;
    setMemberCache((current) => ({
      owner: cacheOwner,
      records: {
        ...(current.owner === cacheOwner ? current.records : {}),
        ...Object.fromEntries(members.map((member) => [member.id, member])),
      },
    }));
  }, [cacheOwner]);

  const rememberMember = useCallback((member) => {
    if (!cacheOwner) return;
    setMemberCache((current) => {
      const records = current.owner === cacheOwner ? current.records : {};
      return {
        owner: cacheOwner,
        records: { ...records, [member.id]: { ...records[member.id], ...member } },
      };
    });
  }, [cacheOwner]);

  const forgetMember = useCallback((id) => {
    if (!cacheOwner) return;
    setMemberCache((current) => {
      if (current.owner !== cacheOwner) return current;
      const records = { ...current.records };
      delete records[id];
      return { ...current, records };
    });
  }, [cacheOwner]);

  const getMember = useCallback((id) => (
    cacheOwner && memberCache.owner === cacheOwner ? memberCache.records[id] || null : null
  ), [memberCache, cacheOwner]);
  const value = useMemo(
    () => ({ getMember, rememberMember, rememberMembers, forgetMember }),
    [getMember, rememberMember, rememberMembers, forgetMember]
  );

  return <MembersDataContext.Provider value={value}>{children}</MembersDataContext.Provider>;
}

export function useMembersData() {
  const context = useContext(MembersDataContext);
  if (!context) throw new Error('useMembersData must be used within MembersDataProvider');
  return context;
}
