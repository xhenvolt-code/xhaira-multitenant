import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { ensureMemberConfigurationDefaults } from '@/lib/member-config.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

// GET /api/sacco-configurations — List all SACCO configuration toggles
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'finance.view');
    if (perm instanceof NextResponse) return perm;
    await ensureMemberConfigurationDefaults(perm.auth.organizationId);

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    let sql = `SELECT * FROM sacco_configurations ORDER BY category, config_key`;
    const params = [];
    if (category) {
      sql = `SELECT * FROM sacco_configurations WHERE category = $1 ORDER BY config_key`;
      params.push(category);
    }

    const result = await query(sql, params);
    return NextResponse.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[Config] GET error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/sacco-configurations — Upsert a configuration value
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'finance.manage');
    if (perm instanceof NextResponse) return perm;
    if (perm.auth?.role !== 'superadmin') {
      return NextResponse.json({ success: false, error: 'Only the organization administrator can change SACCO settings' }, { status: 403 });
    }
    await ensureMemberConfigurationDefaults(perm.auth.organizationId);
    const { auth } = perm;

    const body = await request.json();
    const { config_key, config_value, label, description, config_type, category } = body;

    if (!config_key) {
      return NextResponse.json({ success: false, error: 'config_key is required' }, { status: 400 });
    }
    let normalizedConfigValue = config_value;
    if (config_key === 'transfers.approval_threshold') {
      const amount = typeof config_value === 'object' && config_value !== null
        ? Number(config_value.amount)
        : Number(config_value);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ success: false, error: 'Approval threshold must be a non-negative amount' }, { status: 400 });
      }
      normalizedConfigValue = { amount };
    }

    const policyValues = {
      'groups.requirement': ['required', 'optional', 'disabled'],
      'groups.nature': ['member_type', 'sub_organization', 'both'],
      'groups.cardinality': ['one', 'many'],
    };
    if (policyValues[config_key] && !policyValues[config_key].includes(config_value)) {
      return NextResponse.json({ success: false, error: `Invalid value for ${config_key}` }, { status: 400 });
    }
    if (config_key.startsWith('groups.') && !policyValues[config_key]) {
      return NextResponse.json({ success: false, error: 'Unknown group policy setting' }, { status: 400 });
    }
    if (config_key === 'groups.cardinality' && config_value === 'one') {
      const conflicts = await query(`SELECT member_id FROM member_group_links GROUP BY member_id HAVING COUNT(*) > 1 LIMIT 1`);
      if (conflicts.rows[0]) return NextResponse.json({ success: false, error: 'Move members to one group each before changing this policy' }, { status: 409 });
    }
    if (config_key === 'groups.requirement' && config_value === 'required') {
      const nature = await query(`SELECT config_value FROM sacco_configurations WHERE config_key = 'groups.nature'`);
      if (!['sub_organization', 'both'].includes(nature.rows[0]?.config_value ?? 'member_type')) {
        return NextResponse.json({ success: false, error: 'Required group membership needs a group model that contains individual members' }, { status: 400 });
      }
    }
    if (config_key === 'groups.nature' && config_value === 'member_type') {
      const requirement = await query(`SELECT config_value FROM sacco_configurations WHERE config_key = 'groups.requirement'`);
      if ((requirement.rows[0]?.config_value ?? 'optional') === 'required') {
        return NextResponse.json({ success: false, error: 'Change the group requirement before switching to member-type groups' }, { status: 400 });
      }
    }
    if ((config_key === 'groups.requirement' && config_value === 'disabled') ||
        (config_key === 'groups.nature' && config_value === 'sub_organization')) {
      const financialGroups = await query(`SELECT 1 FROM member_groups g
        WHERE g.group_member_id IS NOT NULL AND (
          EXISTS (SELECT 1 FROM member_accounts ma WHERE ma.member_id = g.group_member_id)
          OR EXISTS (SELECT 1 FROM loans l WHERE l.member_id = g.group_member_id)
        ) LIMIT 1`);
      if (financialGroups.rows[0]) {
        return NextResponse.json({ success: false, error: 'Close or migrate group financial accounts and loans before changing this policy' }, { status: 409 });
      }
    }

    const saved = await runWithOrganizationContext(auth.organizationId, async () => {
      const context = await query('SELECT public.current_organization_id() AS organization_id');
      if (context.rows[0]?.organization_id !== auth.organizationId) {
        throw new Error('Authenticated organization context is missing or inconsistent. Please sign in again.');
      }
      const oldResult = await query('SELECT * FROM sacco_configurations WHERE organization_id = $1 AND config_key = $2', [auth.organizationId, config_key]);
      const result = await query(
        `INSERT INTO sacco_configurations (organization_id, config_key, config_value, label, description, config_type, category, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, config_key) DO UPDATE SET
           config_value = EXCLUDED.config_value,
           label = COALESCE(EXCLUDED.label, sacco_configurations.label),
           description = COALESCE(EXCLUDED.description, sacco_configurations.description),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         RETURNING *`,
        [
          auth.organizationId,
          config_key,
          JSON.stringify(normalizedConfigValue !== undefined ? normalizedConfigValue : true),
          label || null,
          description || null,
          config_type || (config_key === 'transfers.approval_threshold' ? 'json' : 'boolean'),
          category || 'general',
          auth.userId,
        ]
      );

      const oldValue = oldResult.rows[0];
      if (JSON.stringify(oldValue?.config_value ?? null) !== JSON.stringify(result.rows[0]?.config_value ?? null)) {
        await query(
          `INSERT INTO member_configuration_audit (setting_type, setting_key, old_value, new_value, changed_by)
           VALUES ('sacco_config', $1, $2::jsonb, $3::jsonb, $4)`,
          [config_key, JSON.stringify(oldValue ?? null), JSON.stringify(result.rows[0]), auth.userId]
        );
      }
      return result.rows[0];
    });

    return NextResponse.json({ success: true, data: saved });
  } catch (error) {
    console.error('[Config] POST error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
