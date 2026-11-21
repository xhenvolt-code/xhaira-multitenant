import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-utils.js';
import { requirePermission } from '@/lib/permissions.js';
import { getPool } from '@/lib/db.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export async function GET(request) {
  try {
    const auth = await requireAuth(request);
    const data = await runWithOrganizationContext(auth.organizationId, async () => {
      const client = await getPool().connect();
      try {
        const result = await client.query(
          `SELECT o.name AS organization_name, COALESCE(cb.contact_phones, '') AS contact_phones,
                  COALESCE(cb.contact_email, '') AS contact_email, COALESCE(cb.website, '') AS website,
                  COALESCE(cb.address, '') AS address,
                  COALESCE(cb.use_organization_name_as_app_name, false) AS use_organization_name_as_app_name
             FROM public.organizations o
             LEFT JOIN public.company_branding cb ON cb.organization_id = o.id AND cb.is_active = true
            WHERE o.id = $1`, [auth.organizationId]
        );
        return result.rows[0] || null;
      } finally { await client.release(); }
    });
    if (!data) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 404 });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const status = error.status || (error.message === 'Unauthorized' ? 401 : 500);
    console.error('[Organization branding] GET error:', error.message);
    return NextResponse.json({ success: false, error: status === 500 ? 'Failed to load organization information' : error.message }, { status });
  }
}

export async function PATCH(request) {
  try {
    const permission = await requirePermission(request, 'settings.manage');
    if (permission instanceof NextResponse) return permission;
    const { auth } = permission;
    const body = await request.json();
    const name = clean(body.organization_name, 255);
    const phones = clean(body.contact_phones, 500);
    const email = clean(body.contact_email, 254);
    const website = clean(body.website, 500);
    const address = clean(body.address, 1000);
    if (name.length < 2) return NextResponse.json({ success: false, error: 'Organization name must have at least 2 characters' }, { status: 400 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ success: false, error: 'Enter a valid organization email' }, { status: 400 });
    if (website) {
      try { const url = new URL(website); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { return NextResponse.json({ success: false, error: 'Website must be a valid http or https URL' }, { status: 400 }); }
    }
    if (typeof body.use_organization_name_as_app_name !== 'boolean') {
      return NextResponse.json({ success: false, error: 'Choose whether to show the organization name as the app name' }, { status: 400 });
    }

    const data = await runWithOrganizationContext(auth.organizationId, async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.organization_id', $1, true)", [auth.organizationId]);
        const org = await client.query(
          'UPDATE public.organizations SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING slug',
          [name, auth.organizationId]
        );
        if (!org.rows[0]) throw new Error('Organization not found');
        const values = [name, phones || null, email || null, website || null, address || null,
          body.use_organization_name_as_app_name, auth.userId, auth.organizationId, org.rows[0].slug];
        const updated = await client.query(
          `UPDATE public.company_branding
              SET organization_name = $1, contact_phones = $2, contact_email = $3,
                  website = $4, address = $5, use_organization_name_as_app_name = $6,
                  updated_by = $7, updated_at = NOW()
            WHERE organization_id = $8 AND is_active = true`, values.slice(0, 8)
        );
        if (!updated.rowCount) {
          const reactivated = await client.query(
            `UPDATE public.company_branding
                SET organization_name = $1, contact_phones = $2, contact_email = $3,
                    website = $4, address = $5, use_organization_name_as_app_name = $6,
                    updated_by = $7, updated_at = NOW(), is_active = true
              WHERE organization_id = $8 AND organization_slug = $9`, values
          );
          if (reactivated.rowCount) {
            await client.query('COMMIT');
            return { organization_name: name, contact_phones: phones, contact_email: email, website, address,
              use_organization_name_as_app_name: body.use_organization_name_as_app_name };
          }
          await client.query(
            `INSERT INTO public.company_branding
               (organization_name, organization_slug, contact_phones, contact_email, website, address,
                use_organization_name_as_app_name, is_active, updated_by, organization_id)
             VALUES ($1, $9, $2, $3, $4, $5, $6, true, $7, $8)`, values
          );
        }
        await client.query('COMMIT');
        return { organization_name: name, contact_phones: phones, contact_email: email, website, address,
          use_organization_name_as_app_name: body.use_organization_name_as_app_name };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { await client.release(); }
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const status = error.status || (error.message === 'Unauthorized' ? 401 : 500);
    console.error('[Organization branding] PATCH error:', error.message);
    return NextResponse.json({ success: false, error: status === 500 ? 'Failed to save organization information' : error.message }, { status });
  }
}
