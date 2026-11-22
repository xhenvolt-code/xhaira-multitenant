import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers.js';
import { getPlatformSession, PLATFORM_COOKIE } from '@/lib/platform/auth.js';
import PlatformSignOut from '@/components/platform/PlatformSignOut.js';

const links = [
  ['/app/platform/dashboard', 'Overview'],
  ['/app/platform/institutions', 'Institutions'],
  ['/app/platform/transactions', 'Transactions'],
  ['/app/platform/fees', 'Transaction fees'],
  ['/app/platform/funding', 'Funding & settlements'],
  ['/app/platform/administrators', 'Platform administrators'],
  ['/app/platform/audit', 'Audit trail'],
];

export default async function PlatformConsoleLayout({ children }) {
  const cookieStore = await cookies();
  const session = await getPlatformSession(cookieStore.get(PLATFORM_COOKIE)?.value);
  if (!session) redirect('/app/platform/login');
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:flex">
      <aside className="border-b border-slate-800 bg-slate-900 lg:min-h-screen lg:w-64 lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-800 px-5 py-5">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-300">Xhenvolt</div>
          <div className="mt-1 text-lg font-bold">Platform Control</div>
          <div className="mt-1 text-xs text-slate-500">Xhaira institutional management</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-3 lg:flex-col">
          {links.map(([href, label]) => <Link key={href} href={href} className="shrink-0 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white">{label}</Link>)}
        </nav>
        <div className="border-t border-slate-800 p-4 text-xs text-slate-400 lg:mt-auto">
          <div className="truncate font-medium text-slate-200">{session.name}</div>
          <div className="truncate">{session.email}</div>
          <div className="mt-1 capitalize">{session.role.replaceAll('_', ' ')}</div>
          <PlatformSignOut />
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
