import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';

const pool = getPool();
const VALID_LOG_STATUSES = new Set(['success', 'pending', 'warning', 'error', 'failed']);

function parseLimit(value) {
  const parsed = Number.parseInt(value ?? '50', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

function isValidDate(value) {
  if (!value || typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

/**
 * GET /api/operations-log
 * Fetch operations log with filtering
 */
export async function GET(req) {
  try {
    const perm = await requirePermission(req, 'operations.view');
    if (perm instanceof NextResponse) {
      return perm;
    }

    const { searchParams } = new URL(req.url);
    const status = (searchParams.get('status') ?? '').trim().toLowerCase() || null;
    const staff_id = searchParams.get('staff_id');
    const start_date = searchParams.get('start_date');
    const end_date = searchParams.get('end_date');
    const limit = parseLimit(searchParams.get('limit'));

    if (status && !VALID_LOG_STATUSES.has(status)) {
      return NextResponse.json(
        { error: 'Invalid status filter. Allowed values: success, pending, warning, error, failed' },
        { status: 400 }
      );
    }

    if (staff_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staff_id)) {
      return NextResponse.json({ error: 'Invalid staff_id format' }, { status: 400 });
    }

    if (start_date && !isValidDate(start_date)) {
      return NextResponse.json({ error: 'Invalid start_date format' }, { status: 400 });
    }

    if (end_date && !isValidDate(end_date)) {
      return NextResponse.json({ error: 'Invalid end_date format' }, { status: 400 });
    }

    let query = 'SELECT * FROM operations_log WHERE 1 = 1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    if (staff_id) {
      query += ` AND staff_id = $${paramIndex++}`;
      params.push(staff_id);
    }
    if (start_date) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(end_date);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);

    const result = await pool.query(query, params);

    return NextResponse.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
    });
  } catch (error) {
    console.error('Error fetching operations log:', error);
    return NextResponse.json(
      { error: 'Failed to fetch operations log' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/operations-log
 * Create new operation log entry
 */
export async function POST(req) {
  try {
    const perm = await requirePermission(req, 'operations.manage');
    if (perm instanceof NextResponse) {
      return perm;
    }

    let body;
    try {
      body = await req.json();
    } catch (error) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const {
      title,
      description,
      staff_id,
      department_id,
      status,
      started_at,
      completed_at,
      duration_ms,
    } = body;

    const normalizedStatus = typeof status === 'string' ? status.trim().toLowerCase() : status;
    const normalizedDescription = typeof description === 'string' ? description.trim() : '';

    if (!normalizedDescription) {
      return NextResponse.json(
        { error: 'Description is required' },
        { status: 400 }
      );
    }

    if (normalizedStatus && !VALID_LOG_STATUSES.has(normalizedStatus)) {
      return NextResponse.json(
        { error: 'Invalid status. Allowed values: success, pending, warning, error, failed' },
        { status: 400 }
      );
    }

    if (staff_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staff_id)) {
      return NextResponse.json({ error: 'Invalid staff_id format' }, { status: 400 });
    }

    if (department_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(department_id)) {
      return NextResponse.json({ error: 'Invalid department_id format' }, { status: 400 });
    }

    if (started_at && !isValidDate(started_at)) {
      return NextResponse.json({ error: 'Invalid started_at format' }, { status: 400 });
    }

    if (completed_at && !isValidDate(completed_at)) {
      return NextResponse.json({ error: 'Invalid completed_at format' }, { status: 400 });
    }

    if (duration_ms !== undefined && duration_ms !== null && (!Number.isInteger(duration_ms) || duration_ms < 0)) {
      return NextResponse.json({ error: 'duration_ms must be a non-negative integer' }, { status: 400 });
    }

    const result = await pool.query(
      `INSERT INTO operations_log (
        title,
        description,
        staff_id,
        department_id,
        status,
        started_at,
        completed_at,
        duration_ms,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        title ?? null,
        normalizedDescription,
        staff_id ?? null,
        department_id ?? null,
        normalizedStatus || 'success',
        started_at ?? null,
        completed_at ?? null,
        duration_ms ?? null,
      ]
    );

    return NextResponse.json(result.rows[0], { status: 201 });
  } catch (error) {
    console.error('Error creating operations log:', error);
    return NextResponse.json(
      { error: 'Failed to create operation: ' + error.message },
      { status: 500 }
    );
  }
}
