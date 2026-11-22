import { cookies } from 'next/headers.js';
import { redirect } from 'next/navigation';
import { getPlatformSession, hasPlatformAdmins, PLATFORM_COOKIE } from '@/lib/platform/auth.js';

export const dynamic = 'force-dynamic';

export default async function PlatformEntryPage() {
  const jar = await cookies();
  const token = jar.get(PLATFORM_COOKIE)?.value;
  const session = await getPlatformSession(token);
  if (session) redirect('/platform/dashboard');
  const initialized = await hasPlatformAdmins();
  if (initialized) redirect('/platform/login');
  redirect('/platform/login');
}
