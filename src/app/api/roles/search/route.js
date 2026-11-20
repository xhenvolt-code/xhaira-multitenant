import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { verifyAuth } from '@/lib/auth-utils.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

/**
 * GET /api/roles/search?q=eng&department_id=...
 * Dynamic typeahead search for roles — used in staff assignment, modals, etc.
 */
export async function GET(request) {
  try {
    const auth = await verifyAuth(request);
    if (!auth) return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });

    return await withOrganizationRbac(auth, async () => {
      const { searchParams } = new URL(request.url);
      const q = searchParams.get('q') || '';
      const departmentId = searchParams.get('department_id');
      const parsedLimit = Number.parseInt(searchParams.get('limit'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;

      let sql = `
        SELECT r.id, r.name, r.description, r.hierarchy_level, r.alias, r.department_id,
               d.name AS department_name
          FROM public.roles r
          LEFT JOIN public.departments d
            ON r.department_id = d.id AND d.organization_id = r.organization_id
         WHERE r.organization_id = $1
      `;
      const params = [auth.organizationId];

      if (q.trim()) {
        params.push(`%${q.trim()}%`);
        sql += ` AND (r.name ILIKE $${params.length} OR r.description ILIKE $${params.length} OR r.alias ILIKE $${params.length})`;
      }
      if (departmentId) {
        params.push(departmentId);
        sql += ` AND r.department_id = $${params.length}`;
      }

      params.push(limit);
      sql += ` ORDER BY r.hierarchy_level ASC, r.name ASC LIMIT $${params.length}`;

      const result = await query(sql, params);
      return NextResponse.json({ success: true, data: result.rows });
    });
  } catch (error) {
    console.error('[Roles Search] error:', error);
    return NextResponse.json({ success: false, error: 'Failed to search roles' }, { status: 500 });
  }
}
