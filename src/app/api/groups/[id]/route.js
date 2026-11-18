import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const groupResult = await query(
        `SELECT g.id, g.group_member_id, g.group_name, g.created_at,
                m.status AS group_status, m.membership_number AS group_membership_number,
                COUNT(link.member_id)::int AS member_count
           FROM member_groups g
           LEFT JOIN members m ON m.id = g.group_member_id AND m.organization_id = g.organization_id
           LEFT JOIN member_group_links link ON link.group_id = g.id AND link.organization_id = g.organization_id
          WHERE g.id = $1 AND g.organization_id = $2
          GROUP BY g.id, m.status, m.membership_number`,
        [id, perm.auth.organizationId]
      );
      if (!groupResult.rows[0]) return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 });

      const [membersResult, policiesResult, accountsResult] = await Promise.all([
        query(`SELECT m.id, m.full_name, m.membership_number, m.status
                 FROM member_group_links link JOIN members m ON m.id = link.member_id
                   AND m.organization_id = link.organization_id
                WHERE link.group_id = $1 AND link.organization_id = $2 ORDER BY m.full_name`,
          [id, perm.auth.organizationId]),
        query(`SELECT config_key, config_value FROM sacco_configurations
                WHERE organization_id = $1
                  AND config_key IN ('groups.requirement', 'groups.nature', 'groups.cardinality')`,
          [perm.auth.organizationId]),
        groupResult.rows[0].group_member_id
          ? query(`SELECT ma.id, ma.account_type, ma.account_number, ma.status, ma.currency,
                          COALESCE(b.balance, 0) AS balance
                     FROM member_accounts ma
                     LEFT JOIN v_member_account_balances b ON b.member_account_id = ma.id
                    WHERE ma.member_id = $1 AND ma.organization_id = $2
                    ORDER BY ma.created_at DESC`, [groupResult.rows[0].group_member_id, perm.auth.organizationId])
          : Promise.resolve({ rows: [] }),
      ]);
      const accountIds = accountsResult.rows.map((account) => account.id);
      const transactionsResult = accountIds.length
        ? await query(`SELECT le.id, le.entry_type, le.amount, le.currency, le.description,
                              le.created_at, ma.account_number, t.description AS transaction_description,
                              t.transaction_type, t.reference
                         FROM ledger_entries le
                         JOIN transactions t ON t.id = le.transaction_id
                         JOIN member_accounts ma ON ma.id = le.member_account_id
                        WHERE le.member_account_id = ANY($1::uuid[])
                          AND le.organization_id = $2 AND t.organization_id = $2
                          AND ma.organization_id = $2
                        ORDER BY le.created_at DESC LIMIT 20`, [accountIds, perm.auth.organizationId])
        : { rows: [] };
      return NextResponse.json({
        success: true,
        data: {
          ...groupResult.rows[0],
          members: membersResult.rows,
          accounts: accountsResult.rows,
          recent_transactions: transactionsResult.rows,
          policy: Object.fromEntries(policiesResult.rows.map((row) => [row.config_key, row.config_value])),
        },
      });
    });
  } catch (error) {
    console.error('[Groups] GET detail error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    if (perm.auth?.role !== 'superadmin') {
      return NextResponse.json({ success: false, error: 'Only the organization administrator can rename a group' }, { status: 403 });
    }
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const body = await request.json();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 255) return NextResponse.json({ success: false, error: 'Group name must be between 1 and 255 characters' }, { status: 400 });

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const group = await client.query(
          'SELECT id, group_member_id FROM member_groups WHERE id = $1 AND organization_id = $2 FOR UPDATE',
          [id, perm.auth.organizationId]
        );
        if (!group.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 });
        }
        await client.query('UPDATE member_groups SET group_name = $3 WHERE id = $1 AND organization_id = $2',
          [id, perm.auth.organizationId, name]);
        if (group.rows[0].group_member_id) {
          const words = name.split(/\s+/);
          await client.query(
            `UPDATE members SET full_name = $2, first_name = $3, last_name = $4, updated_at = NOW()
              WHERE id = $1 AND organization_id = $5`,
            [group.rows[0].group_member_id, name, words[0], words.slice(1).join(' ') || null, perm.auth.organizationId]
          );
        }
        await client.query('COMMIT');
        return NextResponse.json({ success: true, data: { id, group_name: name } });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Groups] PATCH error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    if (perm.auth?.role !== 'superadmin') {
      return NextResponse.json({ success: false, error: 'Only the organization administrator can remove a group' }, { status: 403 });
    }
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
      const { id } = await params;
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const group = await client.query(
          'SELECT id, group_member_id FROM member_groups WHERE id = $1 AND organization_id = $2 FOR UPDATE',
          [id, perm.auth.organizationId]
        );
        if (!group.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({ success: false, error: 'Group not found' }, { status: 404 });
        }
        const current = group.rows[0];
        const [memberCount, accountCount, loanCount] = await Promise.all([
          client.query('SELECT 1 FROM member_group_links WHERE group_id = $1 AND organization_id = $2 LIMIT 1', [id, perm.auth.organizationId]),
          current.group_member_id
            ? client.query('SELECT 1 FROM member_accounts WHERE member_id = $1 AND organization_id = $2 LIMIT 1', [current.group_member_id, perm.auth.organizationId])
            : Promise.resolve({ rows: [] }),
          current.group_member_id
            ? client.query('SELECT 1 FROM loans WHERE member_id = $1 AND organization_id = $2 LIMIT 1', [current.group_member_id, perm.auth.organizationId])
            : Promise.resolve({ rows: [] }),
        ]);
        if (memberCount.rows[0] || accountCount.rows[0] || loanCount.rows[0]) {
          await client.query('ROLLBACK');
          return NextResponse.json({
            success: false,
            error: 'This group has linked members or financial records. Remove linked members first; groups with account or loan history cannot be deleted.',
          }, { status: 409 });
        }
        await client.query('DELETE FROM member_groups WHERE id = $1 AND organization_id = $2', [id, perm.auth.organizationId]);
        await client.query('COMMIT');
        return NextResponse.json({ success: true });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.release();
      }
    });
  } catch (error) {
    console.error('[Groups] DELETE error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
