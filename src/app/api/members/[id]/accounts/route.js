import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/members/[id]/accounts — List accounts for a member
export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get('active_only') === 'true';

    // Verify member exists
    const member = await query(
      `SELECT id, full_name FROM members WHERE id = $1 AND organization_id = $2`,
      [id, perm.auth.organizationId]
    );
    if (member.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
    }

    const accounts = await query(
      `SELECT vb.*
         FROM v_member_account_balances vb
         JOIN member_accounts ma ON ma.id = vb.member_account_id
        WHERE vb.member_id = $1 AND ma.organization_id = $2
          ${activeOnly ? `AND vb.status = 'active'` : ''}
        ORDER BY vb.opened_at DESC`,
      [id, perm.auth.organizationId]
    );

    return NextResponse.json({
      success: true,
      data: accounts.rows,
      member: member.rows[0],
    });
    });
  } catch (error) {
    console.error('[Member Accounts] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/members/[id]/accounts — Open a new account for a member
export async function POST(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { id } = await params;
    const body = await request.json();
    const { account_type, account_type_id, currency } = body;

    // Verify member exists and is active
    const member = await query(`SELECT id, full_name, status, member_kind FROM members WHERE id = $1 AND organization_id = $2`, [id, perm.auth.organizationId]);
    if (member.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
    }
    if (member.rows[0].status !== 'active') {
      return NextResponse.json({ success: false, error: 'Cannot open account for inactive member' }, { status: 400 });
    }
    if (member.rows[0].member_kind === 'group') {
      const groupPolicy = await query(`SELECT config_key, config_value FROM sacco_configurations
        WHERE config_key IN ('groups.requirement', 'groups.nature')`);
      const policies = Object.fromEntries(groupPolicy.rows.map((row) => [row.config_key, row.config_value]));
      if (policies['groups.requirement'] === 'disabled' || policies['groups.nature'] === 'sub_organization') {
        return NextResponse.json({ success: false, error: 'Group saving and borrowing are disabled by organization policy' }, { status: 400 });
      }
    }

    const legacyTypeCodes = { savings: 'VOL_SAV', fixed_deposit: 'FIXED_SAV', shares: 'SHARES', loan: 'LOAN_ACC', investment: 'INVEST' };
    const selectedType = account_type_id
      ? await query('SELECT id, code FROM account_types WHERE id = $1 AND organization_id = $2', [account_type_id, perm.auth.organizationId])
      : await query('SELECT id, code FROM account_types WHERE code = $1 AND organization_id = $2', [legacyTypeCodes[account_type] || '', perm.auth.organizationId]);
    if (!selectedType.rows[0]) {
      return NextResponse.json({ success: false, error: 'That account type is not configured for your organization. Refresh the page and select one of your organization’s account types.' }, { status: 400 });
    }
    const resolvedTypeId = selectedType.rows[0].id;
    const typeCode = selectedType.rows[0].code;
    const accountTypeByCode = { VOL_SAV: 'savings', FIXED_SAV: 'fixed_deposit', FIXED_DEP: 'fixed_deposit', SHARES: 'shares', LOAN_ACC: 'loan', INVEST: 'investment' };
    const resolvedAccountType = accountTypeByCode[typeCode] || String(typeCode).toLowerCase();

    // Generate account number: ACC-TYPE-RANDOM
    const typePrefix = String(typeCode).substring(0, 3).toUpperCase();
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const account_number = `ACC-${typePrefix}-${randomSuffix}`;

    const result = await query(
      `INSERT INTO member_accounts (organization_id, member_id, account_type, account_number, currency, account_type_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [perm.auth.organizationId, id, resolvedAccountType, account_number, currency || 'UGX', resolvedTypeId, perm.auth.userId]
    );

    return NextResponse.json({ success: true, data: result.rows[0] }, { status: 201 });
    });
  } catch (error) {
    console.error('[Member Accounts] POST error:', error.message);
    const status = error.code === '23514' ? 409 : 500;
    const message = error.code === '23514'
      ? 'The selected member, account type, or user does not belong to your active organization. Refresh and try again.'
      : error.message;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
