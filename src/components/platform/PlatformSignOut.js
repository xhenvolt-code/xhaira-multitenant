'use client';

import { useRouter } from 'next/navigation';

export default function PlatformSignOut() {
  const router = useRouter();
  async function signOut() {
    await fetch('/api/platform/auth', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    router.replace('/platform/login');
  }
  return <button onClick={signOut} className="mt-4 w-full rounded-lg border border-slate-700 px-3 py-2 text-left text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white">Sign out of platform</button>;
}
