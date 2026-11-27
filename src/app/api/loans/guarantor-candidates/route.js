import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { getRule } from '@/lib/rule-engine.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { resolveGuarantorRequirements } from '@/lib/loan-guarantor-rules.js';

const MAX_RESULTS = 15;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeLikePrefix(value) {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function GET(request) {
  try {
    const permission = await requirePermission(request, 'finance.view');
    if (permission instanceof NextResponse) return permission;

    return await runWithOrganizationContext(permission.auth.organizationId, async () => {
      const { searchParams } = new URL(request.url);
      const memberId = searchParams.get('member_id') || '';
      const search = (searchParams.get('search') || '').trim();
      if (!UUID_PATTERN.test(memberId)) {
        return NextResponse.json({ success: false, error: 'Select a valid loan applicant.' }, { status: 400 });
      }
      if (search.length > 100) {
        return NextResponse.json({ success: false, error: 'Search text must be 100 characters or fewer.' }, { status: 400 });
      }

      const [applicantResult, guarantorRule] = await Promise.all([
        query(
          `SELECT id FROM members
            WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
          [memberId, permission.auth.organizationId]
        ),
        getRule('LOAN', 'guarantors_required'),
      ]);
      if (!applicantResult.rows[0]) {
        return NextResponse.json({ success: false, error: 'Loan applicant was not found or is inactive.' }, { status: 404 });
      }

      const requirements = resolveGuarantorRequirements(guarantorRule);
      const requiredCount = requirements.member_count;
      if (search.length < 2) {
        return NextResponse.json({ success: true, data: [], requiredCount, requirements });
      }

      const membershipFilter = requirements.member_scope === 'SAME_GROUP'
        ? `AND EXISTS (
              SELECT 1
                FROM member_group_links candidate_link
               WHERE candidate_link.member_id = m.id
                 AND candidate_link.organization_id = $3
                 AND candidate_link.group_id IN (
                   SELECT applicant_link.group_id
                     FROM member_group_links applicant_link
                    WHERE applicant_link.member_id = $2
                      AND applicant_link.organization_id = $3
                   UNION
                   SELECT applicant_group.id
                     FROM member_groups applicant_group
                    WHERE applicant_group.group_member_id = $2
                      AND applicant_group.organization_id = $3
                 )
            )`
        : '';
      const result = await query(
        `SELECT m.id, m.full_name, m.membership_number, m.phone
           FROM members m
          WHERE m.status = 'active'
            AND m.organization_id = $3
            AND m.member_kind = 'individual'
            AND m.id <> $2
            AND (
              lower(m.full_name) LIKE $1 ESCAPE '\\'
              OR lower(m.membership_number) LIKE $1 ESCAPE '\\'
              OR lower(m.phone) LIKE $1 ESCAPE '\\'
            )
            ${membershipFilter}
          ORDER BY lower(m.full_name), m.id
          LIMIT ${MAX_RESULTS}`,
        [escapeLikePrefix(search.toLowerCase()), memberId, permission.auth.organizationId]
      );

      return NextResponse.json({ success: true, data: result.rows, requiredCount, requirements });
    });
  } catch (error) {
    console.error('[Loan Guarantor Candidates] GET error:', error.message);
    return NextResponse.json({ success: false, error: 'Could not search guarantor candidates.' }, { status: 500 });
  }
}
