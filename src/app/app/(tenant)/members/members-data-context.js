'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const MembersDataContext = createContext(null);

export function MembersDataProvider({ children }) {
  const [membersById, setMembersById] = useState({});

  const rememberMembers = useCallback((members) => {
    setMembersById((current) => ({
      ...current,
      ...Object.fromEntries(members.map((member) => [member.id, member])),
    }));
  }, []);

  const rememberMember = useCallback((member) => {
    setMembersById((current) => ({
      ...current,
      [member.id]: { ...current[member.id], ...member },
    }));
  }, []);

  const forgetMember = useCallback((id) => {
    setMembersById((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const getMember = useCallback((id) => membersById[id] || null, [membersById]);
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
