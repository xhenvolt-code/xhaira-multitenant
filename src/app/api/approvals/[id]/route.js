/**
 * PUT /api/approvals/[id] - Approve or reject an approval request
 * GET /api/approvals/[id] - Get approval request details
 */
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { getUserHierarchyLevel } from '@/lib/permissions.js';
import { logRbacEvent, extractRbacMetadata } from '@/lib/rbac-audit.js';
import { requirePermission } from '@/lib/permissions.js';
import { withOrganizationRbac } from '@/lib/rbac-tenant.js';

export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'approvals.view');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { id } = await params;

    const result = await withOrganizationRbac(auth, () => query(
      `SELECT ar.*,
        u_req.name AS requester_name, u_req.email AS requester_email,
        u_app.name AS approver_name
       FROM approval_requests ar
       JOIN users u_req
         ON ar.requester_user_id = u_req.id
        AND u_req.organization_id = $2
       LEFT JOIN users u_app
         ON ar.approver_user_id = u_app.id
        AND u_app.organization_id = $2
       WHERE ar.id = $1`,
      [id, auth.organizationId]
    ));

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: 'Approval request not found' }, { status: 404 });
    }

    // Only allow the requester or someone with higher authority to view
    const req = result.rows[0];
    if (req.requester_user_id !== auth.userId && auth.role !== 'superadmin') {
      const [myLevel, requesterLevel] = await withOrganizationRbac(auth, () => Promise.all([
        getUserHierarchyLevel(auth.userId),
        getUserHierarchyLevel(req.requester_user_id),
      ]));
      if (myLevel >= requesterLevel) {
        return NextResponse.json({ success: false, error: 'Insufficient authority to view this request' }, { status: 403 });
      }
    }

    return NextResponse.json({ success: true, data: req });
  } catch (error) {
    console.error('Failed to fetch approval:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch approval request' }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const perm = await requirePermission(request, 'approvals.manage');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;

    const { id } = await params;
    const { status, notes } = await request.json();

    if (!status || !['approved', 'rejected'].includes(status)) {
      return NextResponse.json(
        { success: false, error: 'Status must be "approved" or "rejected"' },
        { status: 400 }
      );
    }

    // Fetch the request
    const reqResult = await withOrganizationRbac(auth, () => query(
      `SELECT ar.*
         FROM approval_requests ar
         JOIN users u_requester
           ON u_requester.id = ar.requester_user_id
          AND u_requester.organization_id = $2
        WHERE ar.id = $1`,
      [id, auth.organizationId]
    ));

    if (!reqResult.rows[0]) {
      return NextResponse.json({ success: false, error: 'Approval request not found' }, { status: 404 });
    }

    const approvalReq = reqResult.rows[0];

    if (approvalReq.status !== 'pending') {
      return NextResponse.json(
        { success: false, error: 'This request has already been resolved' },
        { status: 400 }
      );
    }

    // Verify authority: approver must have higher authority than requester
    if (auth.role !== 'superadmin') {
      const [approverLevel, requesterLevel] = await withOrganizationRbac(auth, () => Promise.all([
        getUserHierarchyLevel(auth.userId),
        getUserHierarchyLevel(approvalReq.requester_user_id),
      ]));

      if (approverLevel >= requesterLevel) {
        return NextResponse.json(
          { success: false, error: 'You do not have sufficient authority to resolve this request' },
          { status: 403 }
        );
      }
    }

    // Cannot approve own request
    if (approvalReq.requester_user_id === auth.userId) {
      return NextResponse.json(
        { success: false, error: 'You cannot approve your own request' },
        { status: 400 }
      );
    }

    // Resolve the request
    const result = await withOrganizationRbac(auth, () => query(
      `UPDATE approval_requests
          SET status = $1, approver_user_id = $2, approver_notes = $3, resolved_at = NOW()
        WHERE id = $4
          AND status = 'pending'
          AND requester_user_id IN (
            SELECT id FROM users WHERE organization_id = $5
          )
        RETURNING *`,
      [status, auth.userId, notes || null, id, auth.organizationId]
    ));

    if (!result.rows[0]) {
      return NextResponse.json(
        { success: false, error: 'Failed to resolve request' },
        { status: 500 }
      );
    }

    // Audit log
    const meta = extractRbacMetadata(request);
    await withOrganizationRbac(auth, () => logRbacEvent({
      userId: auth.userId,
      action: `approval_request_${status}`,
      entityType: 'approval_request',
      entityId: id,
      details: {
        requesterId: approvalReq.requester_user_id,
        targetRecordType: approvalReq.target_record_type,
        targetRecordId: approvalReq.target_record_id,
        actionRequested: approvalReq.action_requested,
        notes,
      },
      ...meta,
    }));

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Failed to resolve approval:', error);
    return NextResponse.json({ success: false, error: 'Failed to resolve approval request' }, { status: 500 });
  }
}
