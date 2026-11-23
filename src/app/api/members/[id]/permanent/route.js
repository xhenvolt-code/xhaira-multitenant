import { NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';
import { getPool } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Permanently remove a member and all organization-scoped financial records.
export async function DELETE(request, { params }) {
  const permission = await requirePermission(request, 'members.manage');
  if (permission instanceof NextResponse) return permission;

  const { id } = await params;
  if (!UUID_PATTERN.test(String(id || ''))) {
    return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
  }

  const organizationId = permission.auth.organizationId;
  return runWithOrganizationContext(organizationId, async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);

      const memberResult = await client.query(
        `SELECT id, full_name, membership_number
           FROM public.members
          WHERE id = $1 AND organization_id = $2 AND trashed_at IS NOT NULL
          FOR UPDATE`,
        [id, organizationId]
      );
      if (!memberResult.rows[0]) {
        await client.query('ROLLBACK');
        return NextResponse.json({ success: false, error: 'Member not found in Trash. Move it to Trash before permanently purging it.' }, { status: 404 });
      }

      const documentResult = await client.query(
        `SELECT md.public_id, md.resource_type, md.cloudinary_account,
                ca.cloud_name, ca.api_key, ca.api_secret
           FROM public.member_documents md
           LEFT JOIN public.cloud_accounts ca
             ON ca.organization_id = md.organization_id
            AND (ca.account_name = md.cloudinary_account OR ca.cloud_name = md.cloudinary_account)
          WHERE md.member_id = $1 AND md.organization_id = $2`,
        [id, organizationId]
      );
      const documents = documentResult.rows;

      const accountResult = await client.query(
        `SELECT id FROM public.member_accounts
          WHERE member_id = $1 AND organization_id = $2`,
        [id, organizationId]
      );
      const accountIds = accountResult.rows.map((row) => row.id);

      if (accountIds.length) {
        const unresolved = await client.query(
          `SELECT COUNT(*)::int AS count
             FROM public.payment_intents
            WHERE organization_id = $1
              AND member_account_id = ANY($2::uuid[])
              AND status IN ('created', 'processing', 'review')`,
          [organizationId, accountIds]
        );
        if (unresolved.rows[0].count > 0) {
          await client.query('ROLLBACK');
          return NextResponse.json({
            success: false,
            error: `Cannot permanently delete this member while ${unresolved.rows[0].count} MarzPay payment request(s) are pending or under review. Resolve them first.`,
          }, { status: 409 });
        }
        await client.query(
          `DELETE FROM public.payment_intents
            WHERE organization_id = $1 AND member_account_id = ANY($2::uuid[])`,
          [organizationId, accountIds]
        );
      }

      // Remove relationships where the member is a borrower or guarantor.
      await client.query(
        `DELETE FROM public.loan_guarantors
          WHERE guarantor_member_id = $1
             OR loan_id IN (SELECT id FROM public.loans WHERE member_id = $1 AND organization_id = $2)`,
        [id, organizationId]
      );
      await client.query('DELETE FROM public.loans WHERE member_id = $1 AND organization_id = $2', [id, organizationId]);
      await client.query('DELETE FROM public.shares WHERE member_id = $1 AND organization_id = $2', [id, organizationId]);
      await client.query('DELETE FROM public.dividends WHERE member_id = $1 AND organization_id = $2', [id, organizationId]);

      if (accountIds.length) {
        const transactionResult = await client.query(
          `SELECT DISTINCT transaction_id
             FROM public.ledger_entries
            WHERE organization_id = $1 AND member_account_id = ANY($2::uuid[])`,
          [organizationId, accountIds]
        );
        const transactionIds = transactionResult.rows.map((row) => row.transaction_id);
        if (transactionIds.length) {
          await client.query("SELECT set_config('app.allow_transaction_delete', 'on', true)");
          await client.query(
            `DELETE FROM public.transactions
              WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
            [organizationId, transactionIds]
          );
        }
        await client.query(
          'DELETE FROM public.member_accounts WHERE organization_id = $1 AND id = ANY($2::uuid[])',
          [organizationId, accountIds]
        );
      }

      await client.query('DELETE FROM public.members WHERE id = $1 AND organization_id = $2', [id, organizationId]);
      await client.query('COMMIT');

      const documentCleanupWarnings = [];
      for (const document of documents) {
        let account = document;
        if (!account.cloud_name || !account.api_key || !account.api_secret) {
          if (document.cloudinary_account !== 'primary' || !process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
            documentCleanupWarnings.push(document.public_id);
            continue;
          }
          account = {
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
          };
        }
        try {
          cloudinary.config({ cloud_name: account.cloud_name, api_key: account.api_key, api_secret: account.api_secret });
          const result = await cloudinary.uploader.destroy(document.public_id, {
            resource_type: document.resource_type,
            type: 'authenticated',
          });
          if (!['ok', 'not found'].includes(result.result)) documentCleanupWarnings.push(document.public_id);
        } catch (cleanupError) {
          console.error('[Members] private document cleanup failed:', cleanupError.message);
          documentCleanupWarnings.push(document.public_id);
        }
      }
      return NextResponse.json({ success: true, data: { id, deleted: true, documentCleanupWarnings } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Members] permanent delete error:', error.message);
      if (error.code === '23503') {
        return NextResponse.json({
          success: false,
          error: 'This member still has linked records that cannot be safely removed. No data was deleted.',
        }, { status: 409 });
      }
      return NextResponse.json({ success: false, error: 'Could not permanently delete member. No data was deleted.' }, { status: 500 });
    } finally {
      await client.release();
    }
  });
}
