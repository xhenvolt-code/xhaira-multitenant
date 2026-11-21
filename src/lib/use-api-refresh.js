'use client';

import { useEffect, useRef } from 'react';

/** Register the current route's API loader with the shared refresh control. */
export function useApiRefresh(refresh) {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const handleRefresh = (event) => {
      const requestedPath = event.detail?.pathname;
      if (requestedPath && requestedPath !== window.location.pathname) return;
      refreshRef.current?.();
    };
    window.addEventListener('xhaira:refresh-apis', handleRefresh);
    return () => window.removeEventListener('xhaira:refresh-apis', handleRefresh);
  }, []);
}
