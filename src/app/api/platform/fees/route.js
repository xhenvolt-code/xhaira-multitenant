import { NextResponse } from 'next/server';
import { getPlatformPool, queryPlatform } from '@/lib/db.js';
import { requirePlatformAdmin } from '@/lib/platform/guard.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await requirePlatformAdmin(request);
  if (auth.response) return auth.response;
  try {
    const [configurations, organizations] = await Promise.all([
      queryPlatform(
        `SELECT c.*, o.name AS organization_name
           FROM public.transaction_fee_configurations c
           LEFT JOIN public.organizations o ON o.id = c.organization_id
          ORDER BY c.effective_from DESC, c.created_at DESC
          LIMIT 500`
      ),
      queryPlatform('SELECT id, name FROM public.organizations WHERE status = \'active\' ORDER BY name'),
    ]);
    return NextResponse.json({ success: true, data: configurations.rows, organizations: organizations.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Platform fees] Failed to load fee schedules:', error.message);
    return NextResponse.json({ success: false, error: 'Fee schedules are unavailable. Apply migrations 965 and 981.' }, { status: 503 });
  }
}

export async function POST(request) {
  const auth = await requirePlatformAdmin(request, { write: true });
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  const scope = body?.scope;
  const organizationId = scope === 'organization' ? String(body?.organizationId || '') : null;
  const component = body?.component;
  const transactionType = body?.transactionType;
  const basisPoints = Number(body?.basisPoints);
  const enabled = body?.enabled;
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  const effectiveDate = new Date(body?.effectiveFrom);
  if (!['platform', 'organization'].includes(scope) ||
      !['xhenvolt', 'marzpay'].includes(component) ||
      (scope === 'organization' && component !== 'xhenvolt') ||
      !['deposit', 'withdrawal'].includes(transactionType) ||
      !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000 ||
      typeof enabled !== 'boolean' || !reason || Number.isNaN(effectiveDate.getTime()) || effectiveDate.getTime() < Date.now() - 60000 ||
      (scope === 'organization' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId))) {
    return NextResponse.json({ success: false, error: 'Provide a valid scope, fee, rate from 0% to 100%, future effective date, and reason' }, { status: 400 });
  }

  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const key = `${scope}:${organizationId || 'default'}:${component}:${transactionType}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    if (organizationId) {
      const organization = await client.query('SELECT id FROM public.organizations WHERE id = $1 AND status = \'active\'', [organizationId]);
      if (!organization.rows[0]) throw Object.assign(new Error('Active organization not found'), { status: 404 });
    }
    const future = await client.query(
      `SELECT id FROM public.transaction_fee_configurations
        WHERE scope = $1 AND organization_id IS NOT DISTINCT FROM $2::uuid
          AND component = $3 AND transaction_type = $4 AND effective_from >= $5
          AND effective_to IS NULL
        LIMIT 1`, [scope, organizationId, component, transactionType, effectiveDate.toISOString()]
    );
    if (future.rows[0]) throw Object.assign(new Error('A later fee version already exists. Choose an effective date after it.'), { status: 409 });

    const previous = await client.query(
      `SELECT * FROM public.transaction_fee_configurations
        WHERE scope = $1 AND organization_id IS NOT DISTINCT FROM $2::uuid
          AND component = $3 AND transaction_type = $4
          AND effective_from < $5 AND (effective_to IS NULL OR effective_to > $5)
        ORDER BY effective_from DESC LIMIT 1 FOR UPDATE`,
      [scope, organizationId, component, transactionType, effectiveDate.toISOString()]
    );
    const versionResult = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
         FROM public.transaction_fee_configurations
        WHERE scope = $1 AND organization_id IS NOT DISTINCT FROM $2::uuid
          AND component = $3 AND transaction_type = $4`,
      [scope, organizationId, component, transactionType]
    );
    if (previous.rows[0]) {
      await client.query('UPDATE public.transaction_fee_configurations SET effective_to = $2 WHERE id = $1', [previous.rows[0].id, effectiveDate.toISOString()]);
    }
    const inserted = await client.query(
      `INSERT INTO public.transaction_fee_configurations
         (scope, organization_id, component, transaction_type, version, enabled, basis_points,
          effective_from, change_reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [scope, organizationId, component, transactionType, versionResult.rows[0].version,
        enabled, basisPoints, effectiveDate.toISOString(), reason, auth.user.id]
    );
    await client.query(
      `INSERT INTO public.platform_audit_logs (admin_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, 'transaction_fee_version_created', 'transaction_fee_configuration', $2, $3::jsonb, $4)`,
      [auth.user.id, inserted.rows[0].id, JSON.stringify({ scope, organization_id: organizationId,
        component, transaction_type: transactionType, previous: previous.rows[0] || null,
        next: inserted.rows[0], effective_from: effectiveDate.toISOString(), reason }),
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null]
    );
    await client.query('COMMIT');
    return NextResponse.json({ success: true, data: inserted.rows[0] }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ success: false, error: error.message || 'Fee schedule was not saved' }, { status: error.status || 500 });
  } finally {
    await client.release();
  }
}
