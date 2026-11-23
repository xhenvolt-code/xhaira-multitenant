import { NextResponse } from 'next/server';
import { getPool, query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { getMemberFields, getMissingRequiredMemberFields, validateMemberFields } from '@/lib/member-config.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';
import { generateMemberAccountNumber } from '@/lib/member-account-number.js';

const PRIVATE_NO_STORE = { headers: { 'Cache-Control': 'private, no-store' } };

// GET /api/members — List all SACCO members
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'members.view');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') || '';
    const status = searchParams.get('status') || '';
    const kind = searchParams.get('kind') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
    const offset = (page - 1) * limit;

    let where = `WHERE m.organization_id = $1 AND (m.member_kind <> 'group' OR EXISTS (
      SELECT 1 FROM member_groups registered_group
       WHERE registered_group.group_member_id = m.id
         AND registered_group.organization_id = m.organization_id
    ))`;
    const params = [perm.auth.organizationId];
    const groupPolicyResult = await query(`SELECT config_key, config_value FROM sacco_configurations
      WHERE organization_id = $1 AND config_key IN ('groups.requirement', 'groups.nature')`,
      [perm.auth.organizationId]);
    const groupPolicy = Object.fromEntries(groupPolicyResult.rows.map((row) => [row.config_key, row.config_value]));
    if (kind === 'individual') {
      where += ` AND m.member_kind = 'individual'`;
    } else if (kind === 'group') {
      where += ` AND m.member_kind = 'group'`;
    } else if (groupPolicy['groups.requirement'] === 'disabled' || groupPolicy['groups.nature'] === 'sub_organization') {
      where += ` AND m.member_kind = 'individual'`;
    }

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (m.full_name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.phone ILIKE $${params.length} OR m.membership_number ILIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      where += ` AND m.status = $${params.length}`;
    }

    const countParams = [...params];
    params.push(limit, offset);

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT m.*, u.name as user_name, u.email as user_email,
           (SELECT COUNT(*) FROM member_accounts ma
             WHERE ma.member_id = m.id AND ma.organization_id = m.organization_id) as account_count,
           (SELECT COALESCE(SUM(vb.balance), 0)
              FROM v_member_account_balances vb
              JOIN member_accounts ma ON ma.id = vb.member_account_id
             WHERE vb.member_id = m.id AND ma.organization_id = m.organization_id
               AND vb.status = 'active') as total_balance,
           ARRAY(SELECT dc.label FROM member_document_type_configs dc
                  WHERE dc.organization_id = m.organization_id AND dc.is_enabled AND dc.is_required AND NOT EXISTS
                    (SELECT 1 FROM member_documents md
                      WHERE md.organization_id = m.organization_id
                        AND md.member_id = m.id AND md.document_key = dc.document_key)) AS missing_required_documents
         FROM members m
         LEFT JOIN users u ON m.user_id = u.id AND u.organization_id = m.organization_id
         ${where}
         ORDER BY m.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(`SELECT COUNT(*) as total FROM members m ${where}`, countParams),
    ]);

    const total = parseInt(countResult.rows[0]?.total || 0);
    const fieldConfigs = await getMemberFields(perm.auth.organizationId);
    const members = dataResult.rows.map((member) => {
      const missingRequiredFields = getMissingRequiredMemberFields(fieldConfigs, member);
      const missingDocuments = member.missing_required_documents || [];
      return { ...member, profile_incomplete: missingRequiredFields.length > 0 || missingDocuments.length > 0,
        missing_required_fields: missingRequiredFields, missing_required_documents: missingDocuments };
    });

    return NextResponse.json({
      success: true,
      data: members,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }, PRIVATE_NO_STORE);
    });
  } catch (error) {
    console.error('[Members] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500, ...PRIVATE_NO_STORE });
  }
}

// POST /api/members — Register a new SACCO member
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'members.create');
    if (perm instanceof NextResponse) return perm;
    const { auth } = perm;
    return await runWithOrganizationContext(auth.organizationId, async () => {

    const body = await request.json();
    const {
      // Core
      full_name, first_name, last_name, other_name, email, phone,
      national_id, id_type, gender, date_of_birth, address, user_id,
      // Extended profile
      photo_url, id_photo_url,
      occupation, employer, monthly_income,
      emergency_contact_name, emergency_contact_phone,
      next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
      joined_date, notes,
      custom_fields, member_kind = 'individual',
    } = body;

    // Build full_name from parts if not provided
    const resolvedFullName = full_name?.trim() ||
      [first_name, other_name, last_name].filter(Boolean).join(' ').trim();

    if (!resolvedFullName) {
      return NextResponse.json({ success: false, error: 'Full name (or first + last name) is required' }, { status: 400 });
    }

    if (!['individual', 'group'].includes(member_kind)) {
      return NextResponse.json({ success: false, error: 'Invalid member kind' }, { status: 400 });
    }
    const configuredFields = await getMemberFields(perm.auth.organizationId);
    const validation = validateMemberFields(configuredFields, { ...body, full_name: resolvedFullName, custom_fields });
    if (validation.error) return NextResponse.json({ success: false, error: validation.error }, { status: 400 });

    const policies = await query(
      `SELECT config_key, config_value FROM sacco_configurations
        WHERE organization_id = $1 AND config_key IN ('groups.requirement', 'groups.nature')`,
      [perm.auth.organizationId]
    );
    const policy = Object.fromEntries(policies.rows.map((row) => [row.config_key, row.config_value]));
    const groupRequirement = policy['groups.requirement'] ?? 'optional';
    const groupNature = policy['groups.nature'] ?? 'member_type';
    if (member_kind === 'group' && (groupRequirement === 'disabled' || !['member_type', 'both'].includes(groupNature))) {
      return NextResponse.json({ success: false, error: 'Group records are disabled by this organization configuration' }, { status: 400 });
    }
    if (member_kind === 'individual' && groupRequirement === 'required' && !body.group_id) {
      return NextResponse.json({ success: false, error: 'Select a group for this member' }, { status: 400 });
    }
    if (body.group_id && !['sub_organization', 'both'].includes(groupNature)) {
      return NextResponse.json({ success: false, error: 'This organization policy does not link individuals to groups' }, { status: 400 });
    }
    if (member_kind === 'individual' && body.group_id) {
      const target = await query(
        'SELECT id FROM member_groups WHERE id = $1 AND organization_id = $2',
        [body.group_id, perm.auth.organizationId]
      );
      if (!target.rows[0]) return NextResponse.json({ success: false, error: 'Selected group was not found' }, { status: 400 });
    }

    // Generate membership number: MBR-YYYYMMDD-XXXXX
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    const membership_number = `MBR-${dateStr}-${randomSuffix}`;

    const memberPool = getPool();
    const client = await memberPool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await client.query(
      `INSERT INTO members (
         full_name, first_name, last_name, other_name,
         email, phone, national_id, id_type, gender, date_of_birth, address,
         photo_url, id_photo_url,
         occupation, employer, monthly_income,
         emergency_contact_name, emergency_contact_phone,
         next_of_kin_name, next_of_kin_phone, next_of_kin_relationship,
         joined_date, notes, user_id, membership_number, custom_fields, member_kind, organization_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb, $27
         , $28
       ) RETURNING *`,
      [
        resolvedFullName,
        first_name || resolvedFullName.split(' ')[0] || null,
        last_name || resolvedFullName.split(' ').slice(1).join(' ') || null,
        other_name || null,
        email || null,
        phone || null,
        national_id || null,
        id_type || 'national_id',
        gender || null,
        date_of_birth || null,
        address || null,
        photo_url || null,
        id_photo_url || null,
        occupation || null,
        employer || null,
        monthly_income ? parseFloat(monthly_income) : null,
        emergency_contact_name || null,
        emergency_contact_phone || null,
        next_of_kin_name || null,
        next_of_kin_phone || null,
        next_of_kin_relationship || null,
        joined_date || new Date().toISOString().split('T')[0],
        notes || null,
        user_id || null,
        membership_number,
        JSON.stringify(validation.customFields),
        member_kind,
        perm.auth.organizationId,
      ]
      );

      const member = result.rows[0];

      if (member_kind === 'group') {
        await client.query(
          'INSERT INTO member_groups (organization_id, group_member_id, group_name) VALUES ($1, $2, $3)',
          [perm.auth.organizationId, member.id, resolvedFullName]
        );
      } else if (body.group_id) {
        await client.query(
          'INSERT INTO member_group_links (organization_id, group_id, member_id) VALUES ($1, $2, $3)',
          [perm.auth.organizationId, body.group_id, member.id]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.release();
    }

    const member = result.rows[0];

    // Audit log
    await query(
      `INSERT INTO member_audit_log (member_id, action, performed_by, new_values)
       VALUES ($1, 'created', $2, $3)`,
      [member.id, auth?.userId || null, JSON.stringify({ membership_number, full_name: resolvedFullName })]
    ).catch(() => {}); // Non-blocking

    // Auto-open savings account if configured
    const autoOpenSavings = await query(
      `SELECT config_value FROM sacco_configurations
        WHERE organization_id = $1 AND config_key = 'accounts.auto_open_savings'`,
      [perm.auth.organizationId]
    ).catch(() => ({ rows: [] }));

    if (autoOpenSavings.rows[0]?.config_value === true || autoOpenSavings.rows[0]?.config_value === 'true') {
      const volSavType = await query(
        `SELECT id FROM account_types WHERE code = 'VOL_SAV' AND organization_id = $1 LIMIT 1`,
        [perm.auth.organizationId]
      ).catch(() => ({ rows: [] }));

      if (volSavType.rows.length > 0) {
        const accNum = await generateMemberAccountNumber(perm.auth.organizationId, 'savings');
        await query(
          `INSERT INTO member_accounts (organization_id, member_id, account_type, account_type_id, account_number, currency, status, opened_at)
           VALUES ($1, $2, 'savings', $3, $4, 'UGX', 'active', NOW())
           ON CONFLICT DO NOTHING`,
          [perm.auth.organizationId, member.id, volSavType.rows[0].id, accNum]
        ).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, data: member }, { status: 201 });
    });
  } catch (error) {
    console.error('[Members] POST error:', error.message);
    if (error.message.includes('idx_members_national_id') || error.message.includes('idx_members_email_unique')) {
      return NextResponse.json({ success: false, error: 'A member with this National ID or email already exists' }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
