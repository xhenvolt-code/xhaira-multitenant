/**
 * GET /api/approvals - List approval requests (pending for authorized users, own for all)
 * POST /api/approvals - Create a new approval request
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { getUserHierarchyLevel } from '@/lib/permissions.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'approvals.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const view = searchParams.get('view');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    let sql;
    let params;
    if (view === 'mine') {
      sql = `
        SELECT ar.*, u_approver.name AS approver_name
          FROM approval_requests ar
          JOIN users u_requester
            ON u_requester.id = ar.requester_user_id
           AND u_requester.organization_id = $2
          LEFT JOIN users u_approver
            ON u_approver.id = ar.approver_user_id
           AND u_approver.organization_id = $2
         WHERE ar.requester_user_id = $1
           ${status ? 'AND ar.status = $3' : ''}
         ORDER BY ar.created_at DESC
         LIMIT $${status ? '4' : '3'} OFFSET $${status ? '5' : '4'}`;
      params = status
        ? [auth.userId, auth.organizationId, status, limit, offset]
        : [auth.userId, auth.organizationId, limit, offset];
    } else {
      const hierarchyLevel = await withOrganizationRbac(
        auth,
        () => getUserHierarchyLevel(auth.userId)
      );
      sql = `
        SELECT ar.*, u_requester.name AS requester_name, u_requester.email AS requester_email
          FROM approval_requests ar
          JOIN users u_requester
            ON u_requester.id = ar.requester_user_id
           AND u_requester.organization_id = $2
         WHERE ar.status = 'pending'
           AND $1 < (
             SELECT COALESCE(MIN(r.hierarchy_level), 5)
               FROM users u2
               JOIN staff s2
                 ON s2.id = u2.staff_id
                AND s2.organization_id = u2.organization_id
               JOIN staff_roles sr2
                 ON sr2.staff_id = s2.id
                AND sr2.organization_id = s2.organization_id
               JOIN roles r
                 ON r.id = sr2.role_id
                AND r.organization_id = sr2.organization_id
              WHERE u2.id = ar.requester_user_id
                AND u2.organization_id = $2
           )
         ORDER BY ar.created_at DESC
         LIMIT $3 OFFSET $4`;
      params = [hierarchyLevel, auth.organizationId, limit, offset];
    }

    const result = await withOrganizationRbac(auth, () => query(sql, params));
    const countResult = await withOrganizationRbac(auth, () => query(
      `SELECT COUNT(*) AS cnt
         FROM approval_requests ar
         JOIN users u_requester
           ON u_requester.id = ar.requester_user_id
          AND u_requester.organization_id = $1
        WHERE ar.status = 'pending'`,
      [auth.organizationId]
    ));

    return NextResponse.json({
      success: true,
      data: result.rows,
      meta: { total_pending: parseInt(countResult.rows[0]?.cnt || '0', 10), limit, offset },
    });
  } catch (error) {
    console.error('Failed to fetch approvals:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch approvals' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'approvals.manage');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { target_record_type, target_record_id, action_requested, reason } = await request.json();

    if (!target_record_type || !action_requested) {
      return NextResponse.json(
        { success: false, error: 'target_record_type and action_requested are required' },
        { status: 400 }
      );
    }

    const result = await withOrganizationRbac(auth, () => query(
      `INSERT INTO approval_requests (requester_user_id, target_record_type, target_record_id, action_requested, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, created_at`,
      [auth.userId, target_record_type, target_record_id || null, action_requested, reason || null]
    ));

    const meta = extractRbacMetadata(request);
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: 'approval_request_submitted',
      entityType: 'approval_request',
      entityId: result.rows[0].id,
      details: { targetRecordType: target_record_type, targetRecordId: target_record_id, actionRequested: action_requested },
      ...meta,
    }));

    return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error('Failed to create approval request:', error);
    return NextResponse.json({ success: false, error: 'Failed to create approval request' }, { status: 500 });
  }
}
