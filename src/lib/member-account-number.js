import { randomInt } from 'node:crypto';
import { getPool } from '@/lib/db.js';

function organizationPrefix(organization) {
  const fromSlug = String(organization?.slug || '').replace(/[^a-z]/gi, '');
  const fromName = String(organization?.name || '').replace(/[^a-z]/gi, '');
  return (fromSlug || fromName || 'ORG').slice(0, 4).toUpperCase().padEnd(4, 'X');
}

function accountTypeSegment(accountType) {
  const segment = String(accountType || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (!segment) throw new TypeError('An account type is required to generate an account number');
  return segment.slice(0, 20);
}

export async function generateMemberAccountNumber(organizationId, accountType, client = getPool()) {
  const organization = await client.query(
    'SELECT slug, name FROM public.organizations WHERE id = $1 LIMIT 1',
    [organizationId]
  );
  if (!organization.rows[0]) throw new Error('Organization not found while generating account number');

  const prefix = organizationPrefix(organization.rows[0]);
  const type = accountTypeSegment(accountType);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const suffix = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const accountNumber = `${prefix}-${type}-099${suffix}`;
    const existing = await client.query(
      'SELECT 1 FROM public.member_accounts WHERE account_number = $1 LIMIT 1',
      [accountNumber]
    );
    if (!existing.rows[0]) return accountNumber;
  }
  throw new Error('Could not generate a unique member account number; retry the request');
}
