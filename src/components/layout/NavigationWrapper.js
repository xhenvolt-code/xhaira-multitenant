'use client';

import { usePathname } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { Navbar } from '@/components/layout/Navbar';

/**
 * Navigation Wrapper Component
 * Only renders Sidebar and Navbar on institution /app and /admin routes.
 * The isolated Xhenvolt platform console supplies its own navigation.
 */
export function NavigationWrapper() {
  const pathname = usePathname();
  
  // Keep institutional navigation out of the separately authenticated console.
  const isPlatformRoute = pathname.startsWith('/app/platform');
  const showNavigation = (!isPlatformRoute && pathname.startsWith('/app')) || pathname.startsWith('/admin');
  
  if (!showNavigation) {
    return null;
  }

  return (
    <>
      {/* Sidebar Navigation - Desktop Only */}
      <Sidebar />

      {/* Top Navigation Bar - Desktop Only */}
      <Navbar />
    </>
  );
}
