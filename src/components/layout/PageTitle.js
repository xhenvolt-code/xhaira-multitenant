'use client';

import { usePathname } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Page Title Component
 * Displays current page title and updates HTML title tag
 */
export function PageTitle() {
  const pathname = usePathname();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  // Map routes to readable titles
  const routeTitles = {
    '/app/dashboard': 'Dashboard',
    '/app/transactions': 'Ledger Transactions',
    '/app/assets-accounting': 'Accounting Assets',
    '/app/intellectual-property': 'Intellectual Property',
    '/app/infrastructure': 'Infrastructure',
    '/app/liabilities': 'Liabilities',
    '/app/deals': 'Deals',
    '/app/pipeline': 'Pipeline',
    '/app/prospecting': 'Prospecting Notebook',
    '/app/prospecting/dashboard': 'Today\'s Prospecting',
    '/app/staff': 'Staff',
    '/app/audit-logs': 'Audit Logs',
    '/app/settings': 'Settings',
  };

  const pageTitle = routeTitles[pathname] || 'Xhaira';
  const fullTitle = pageTitle === 'Xhaira' ? 'Xhaira - Executive Operating System' : `${pageTitle} | Xhaira`;

  // Update HTML title
  useEffect(() => {
    document.title = fullTitle;
  }, [fullTitle]);

  const refreshCurrentRoute = () => {
    setRefreshing(true);
    window.dispatchEvent(new CustomEvent('xhaira:refresh-apis', { detail: { pathname } }));
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 700);
  };

  if (pathname === '/' || pathname === '/login' || pathname === '/register') {
    return null;
  }

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-6 py-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{pageTitle}</p>
      <button
        type="button"
        onClick={refreshCurrentRoute}
        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        title="Refresh this route's data"
        aria-label="Refresh current route data"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  );
}
