/**
 * XHAIRA — Loan Engine Service
 * 
 * Handles: loan application, approval, disbursement, repayment, default detection.
 * All money flows go through the transaction service (double-entry).
 * 
 * Lifecycle: PENDING → APPROVED → DISBURSED → ACTIVE → COMPLETED
 *   - Approval ≠ Money given (sets approved_amount)
 *   - Disbursement = actual ledger transaction (supports partial)
 *   - DISBURSED → ACTIVE once fully disbursed
 * 
 * Rules:
 * - Loans MUST go through ledger
 * - No direct balance edits
 * - Every repayment = transaction
 * - Approval is mandatory when product.requires_approval = true
 * - Eligibility + guarantors validated via rule-engine
 */

import { getPool } from '@/lib/db.js';
import { createTransaction, getSystemAccountId } from '@/lib/transaction-service.js';
import { checkLoanEligibility, validateGuarantor, getRule } from '@/lib/rule-engine.js';
import { getOrganizationContext } from '@/lib/organization-context.js';
import {
  resolveGuarantorRequirements,
  validateExternalGuarantor,
} from '@/lib/loan-guarantor-rules.js';
import { calculateLoan } from '@/lib/loan-calculation.js';

function requireOrganizationId() {
  const organizationId = getOrganizationContext();
  if (!organizationId) throw new Error('Organization context is required for loan operations');
  return organizationId;
}

/**
 * Apply for a loan — with eligibility checks
 */
export async function applyForLoan({
  memberId,
  productId,
  memberAccountId,
  principal,
  guarantors,
  externalGuarantors,
  userId,
}) {
  const organizationId = requireOrganizationId();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify member is active
    const member = await client.query(
      `SELECT id, full_name, status, member_kind FROM members
        WHERE id = $1 AND organization_id = $2`,
      [memberId, organizationId]
    );
    if (member.rows.length === 0) throw new Error('Member not found');
    if (member.rows[0].status !== 'active') throw new Error('Member is not active');
    const groupPolicy = await client.query(
      `SELECT config_key, config_value FROM sacco_configurations
        WHERE organization_id = $1 AND config_key IN ('groups.requirement', 'groups.nature')`,
      [organizationId]
    );
    const policy = Object.fromEntries(groupPolicy.rows.map((row) => [row.config_key, row.config_value]));
    if (member.rows[0].member_kind === 'group' &&
        (policy['groups.requirement'] === 'disabled' || policy['groups.nature'] === 'sub_organization')) {
      throw new Error('Group borrowing is disabled by this organization configuration');
    }
    if (member.rows[0].member_kind === 'individual' && policy['groups.requirement'] === 'required') {
      const membership = await client.query(
        'SELECT 1 FROM member_group_links WHERE member_id = $1 AND organization_id = $2 LIMIT 1',
        [memberId, organizationId]
      );
      if (!membership.rows[0]) throw new Error('Member must join a group before applying for a loan');
    }

    // Verify member account exists
    if (memberAccountId) {
      const acct = await client.query(
        `SELECT id, status FROM member_accounts
          WHERE id = $1 AND member_id = $2 AND organization_id = $3`,
        [memberAccountId, memberId, organizationId]
      );
      if (acct.rows.length === 0) throw new Error('Member account not found');
      if (acct.rows[0].status !== 'active') throw new Error('Member account is not active');
    }

    // Load organization-owned defaults for applications without complete product terms.
    const [defaultInterestRule, defaultDurationRule, defaultCycleRule] = await Promise.all([
      getRule('LOAN', 'default_interest_rate'),
      getRule('LOAN', 'default_duration'),
      getRule('LOAN', 'default_repayment_cycle'),
    ]);
    const defaultInterestRate = Number(defaultInterestRule?.rate_percent);
    const defaultDuration = Number(defaultDurationRule?.value);
    const defaultDurationUnit = String(defaultDurationRule?.unit || '').toUpperCase();
    const defaultRepaymentCycle = String(defaultCycleRule?.cycle || '').toUpperCase();
    if (!Number.isFinite(defaultInterestRate) || defaultInterestRate < 0 ||
        !Number.isInteger(defaultDuration) || defaultDuration < 1 ||
        !['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].includes(defaultDurationUnit) ||
        !['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'].includes(defaultRepaymentCycle)) {
      throw new Error('Organization loan defaults are missing or invalid; configure them in Loan Rules.');
    }

    // Get product details, using organization defaults only for missing terms.
    let interestRate, duration, durationUnit, repaymentCycle, requiresApproval;
    if (productId) {
      const product = await client.query(
        `SELECT * FROM products
          WHERE id = $1 AND organization_id = $2 AND is_active = true`,
        [productId, organizationId]
      );
      if (product.rows.length === 0) throw new Error('Product not found or inactive');
      const p = product.rows[0];
      interestRate = p.interest_rate === null || p.interest_rate === undefined
        ? defaultInterestRate
        : Number(p.interest_rate);
      duration = p.duration && Number(p.duration) > 0 ? Number(p.duration) : defaultDuration;
      durationUnit = p.duration && Number(p.duration) > 0
        ? p.duration_unit || defaultDurationUnit
        : defaultDurationUnit;
      repaymentCycle = p.repayment_cycle || defaultRepaymentCycle;
      requiresApproval = p.requires_approval !== false;

      if (p.min_amount && principal < parseFloat(p.min_amount)) {
        throw new Error(`Amount below minimum: ${p.min_amount}`);
      }
      if (p.max_amount && principal > parseFloat(p.max_amount)) {
        throw new Error(`Amount exceeds maximum: ${p.max_amount}`);
      }
    } else {
      interestRate = defaultInterestRate;
      duration = defaultDuration;
      durationUnit = defaultDurationUnit;
      repaymentCycle = defaultRepaymentCycle;
      requiresApproval = true;
    }

    // Eligibility failures must surface; a failed check must never look successful.
    const eligibility = await checkLoanEligibility(memberId, principal);
    if (!eligibility.eligible) {
      throw new Error(`Member is not eligible for this loan: ${eligibility.reasons.join('; ')}`);
    }

    // Validate configured member and outside-guarantor requirements.
    const guarantorRule = await getRule('LOAN', 'guarantors_required');
    const requirements = resolveGuarantorRequirements(guarantorRule);
    const validatedGuarantors = [];
    const requestedGuarantors = Array.isArray(guarantors) ? guarantors : [];
    const requestedExternalGuarantors = Array.isArray(externalGuarantors) ? externalGuarantors : [];
    if (requestedGuarantors.length < requirements.member_count) {
      throw new Error(`Loan requires at least ${requirements.member_count} member guarantor${requirements.member_count === 1 ? '' : 's'}`);
    }
    const guarantorIds = requestedGuarantors.map((guarantor) => guarantor.guarantor_member_id);
    if (new Set(guarantorIds).size !== guarantorIds.length) {
      throw new Error('A member cannot be selected as a guarantor more than once');
    }
    if (requestedExternalGuarantors.length < requirements.external_count) {
      throw new Error(`Loan requires at least ${requirements.external_count} outside guarantor${requirements.external_count === 1 ? '' : 's'}`);
    }

    if (requestedGuarantors.length > 0) {
      for (const g of requestedGuarantors) {
        const guaranteedAmount = Number(g.guaranteed_amount);
        if (!g.guarantor_member_id || !Number.isFinite(guaranteedAmount) || guaranteedAmount <= 0) {
          throw new Error('Each guarantor must have a valid member and guaranteed amount');
        }
        if (requirements.member_scope === 'SAME_GROUP') {
          const sameGroup = await client.query(
            `SELECT 1
               FROM member_group_links guarantor_link
               JOIN members guarantor
                 ON guarantor.id = guarantor_link.member_id
                AND guarantor.status = 'active'
                AND guarantor.member_kind = 'individual'
                AND guarantor.organization_id = $3
              WHERE guarantor_link.member_id = $1
                AND guarantor_link.organization_id = $3
                AND guarantor_link.group_id IN (
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
              LIMIT 1`,
            [g.guarantor_member_id, memberId, organizationId]
          );
          if (!sameGroup.rows[0]) {
            throw new Error("Guarantors must be active individual members of the loan applicant's group");
          }
        }
        const validation = await validateGuarantor(g.guarantor_member_id, g.guaranteed_amount, memberId);
        if (!validation.valid) {
          throw new Error(`Guarantor validation failed: ${validation.issues.join(', ')}`);
        }
        validatedGuarantors.push({ ...g, guaranteed_amount: guaranteedAmount });
      }
    }

    const validatedExternalGuarantors = requestedExternalGuarantors.map((guarantor) => {
      const validationError = validateExternalGuarantor(guarantor, requirements.external_required_fields);
      if (validationError) throw new Error(validationError);
      return {
        full_name: typeof guarantor.full_name === 'string' ? guarantor.full_name.trim() : null,
        phone: typeof guarantor.phone === 'string' ? guarantor.phone.trim() : null,
        national_id: typeof guarantor.national_id === 'string' ? guarantor.national_id.trim() : null,
        physical_address: typeof guarantor.physical_address === 'string' ? guarantor.physical_address.trim() : null,
        occupation: typeof guarantor.occupation === 'string' ? guarantor.occupation.trim() : null,
        relationship: typeof guarantor.relationship === 'string' ? guarantor.relationship.trim() : null,
        guaranteed_amount: Number(guarantor.guaranteed_amount),
      };
    });

    // Calculate loan
    const calc = calculateLoan({ principal, interestRate, duration, durationUnit, repaymentCycle });

    // Create loan record
    const loanResult = await client.query(
      `INSERT INTO loans
        (organization_id, member_id, product_id, member_account_id, principal, interest_rate,
         duration, duration_unit, repayment_cycle, total_interest, total_payable, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [organizationId, memberId, productId || null, memberAccountId || null, principal, interestRate,
        duration, durationUnit, repaymentCycle, calc.totalInterest, calc.totalPayable,
        requiresApproval ? 'PENDING' : 'APPROVED', userId]
    );
    const loan = loanResult.rows[0];

    // Create repayment schedule
    for (const installment of calc.schedule) {
      await client.query(
        `INSERT INTO loan_schedules
          (organization_id, loan_id, installment_number, due_date, principal_amount, interest_amount, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [organizationId, loan.id, installment.installment_number, installment.due_date,
          installment.principal_amount, installment.interest_amount, installment.total_amount]
      );
    }

    // Insert guarantors
    for (const g of validatedGuarantors) {
      await client.query(
        `INSERT INTO loan_guarantors (organization_id, loan_id, guarantor_member_id, guaranteed_amount)
         VALUES ($1, $2, $3, $4)`,
        [organizationId, loan.id, g.guarantor_member_id, g.guaranteed_amount]
      );
    }

    for (const guarantor of validatedExternalGuarantors) {
      await client.query(
        `INSERT INTO loan_external_guarantors
          (organization_id, loan_id, full_name, phone, national_id, physical_address, occupation, relationship, guaranteed_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [organizationId, loan.id, guarantor.full_name, guarantor.phone, guarantor.national_id,
          guarantor.physical_address, guarantor.occupation, guarantor.relationship, guarantor.guaranteed_amount]
      );
    }

    await client.query('COMMIT');

    // If auto-approved, disburse immediately
    if (loan.status === 'APPROVED' && memberAccountId) {
      await disburseLoan({ loanId: loan.id, userId });
      const updated = await pool.query(
        `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
        [loan.id, organizationId]
      );
      return { loan: updated.rows[0], schedule: calc.schedule, eligibility };
    }

    return { loan, schedule: calc.schedule, eligibility };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Approve a loan — sets approved_amount (can be different from principal).
 * Approval ≠ Money given. Disbursement is a separate step.
 */
export async function approveLoan({ loanId, approvedAmount, userId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();

  const loan = await pool.query(
    `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
    [loanId, organizationId]
  );
  if (loan.rows.length === 0) throw new Error('Loan not found');
  if (loan.rows[0].status !== 'PENDING') throw new Error(`Cannot approve loan with status: ${loan.rows[0].status}`);

  // Validate guarantors if required
  const guarantorRule = await getRule('LOAN', 'guarantors_required');
  const requirements = resolveGuarantorRequirements(guarantorRule);
  const [memberGuarantors, outsideGuarantors] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS count FROM loan_guarantors
        WHERE loan_id = $1 AND organization_id = $2`,
      [loanId, organizationId]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM loan_external_guarantors
        WHERE loan_id = $1 AND organization_id = $2 AND status NOT IN ('DECLINED', 'RELEASED')`,
      [loanId, organizationId]
    ),
  ]);
  if (Number(memberGuarantors.rows[0].count) < requirements.member_count) {
    throw new Error(`Loan requires ${requirements.member_count} member guarantors`);
  }
  if (Number(outsideGuarantors.rows[0].count) < requirements.external_count) {
    throw new Error(`Loan requires ${requirements.external_count} outside guarantors`);
  }

  const amount = approvedAmount || parseFloat(loan.rows[0].principal);
  if (amount > parseFloat(loan.rows[0].principal)) {
    throw new Error('Approved amount cannot exceed requested principal');
  }

  // Recalculate if approved_amount differs from principal
  let updateFields = `status = 'APPROVED', approved_amount = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW()`;
  const params = [amount, userId];

  if (amount !== parseFloat(loan.rows[0].principal)) {
    const calc = calculateLoan({
      principal: amount,
      interestRate: parseFloat(loan.rows[0].interest_rate),
      duration: loan.rows[0].duration,
      durationUnit: loan.rows[0].duration_unit || 'MONTHS',
      repaymentCycle: loan.rows[0].repayment_cycle,
    });
    updateFields += `, total_interest = $3, total_payable = $4`;
    params.push(calc.totalInterest, calc.totalPayable);

    // Rebuild schedule
    await pool.query(
      `DELETE FROM loan_schedules WHERE loan_id = $1 AND organization_id = $2`,
      [loanId, organizationId]
    );
    for (const inst of calc.schedule) {
      await pool.query(
        `INSERT INTO loan_schedules
          (organization_id, loan_id, installment_number, due_date, principal_amount, interest_amount, total_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [organizationId, loanId, inst.installment_number, inst.due_date,
          inst.principal_amount, inst.interest_amount, inst.total_amount]
      );
    }
  }

  params.push(loanId);
  await pool.query(
    `UPDATE loans SET ${updateFields}
      WHERE id = $${params.length} AND organization_id = $${params.length + 1}`,
    [...params, organizationId]
  );

  return { loanId, status: 'APPROVED', approved_amount: amount };
}

/**
 * Reject a loan
 */
export async function rejectLoan({ loanId, reason, userId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();

  const loan = await pool.query(
    `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
    [loanId, organizationId]
  );
  if (loan.rows.length === 0) throw new Error('Loan not found');
  if (loan.rows[0].status !== 'PENDING') throw new Error(`Cannot reject loan with status: ${loan.rows[0].status}`);

  await pool.query(
    `UPDATE loans SET status = 'REJECTED', approved_by = $1, rejected_reason = $2, updated_at = NOW()
      WHERE id = $3 AND organization_id = $4`,
    [userId, reason || 'No reason provided', loanId, organizationId]
  );

  return { loanId, status: 'REJECTED' };
}

/**
 * Disburse an approved loan — CRITICAL LEDGER FLOW
 * Supports partial disbursement.
 *
 * CREDIT → Member account (they receive money)
 * DEBIT → System cash account (cash goes out)
 *
 * Status transitions:
 *   APPROVED → DISBURSED (partial) or ACTIVE (fully disbursed)
 *   DISBURSED → ACTIVE (remaining disbursed)
 */
export async function disburseLoan({ loanId, amount, userId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();
  const client = await pool.connect();

  try {
    const loan = await client.query(
      `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
      [loanId, organizationId]
    );
    if (loan.rows.length === 0) throw new Error('Loan not found');
    const l = loan.rows[0];
    if (!['APPROVED', 'DISBURSED'].includes(l.status)) {
      throw new Error(`Cannot disburse loan with status: ${l.status}`);
    }
    if (!l.member_account_id) throw new Error('Loan has no member account for disbursement');

    const approvedAmt = parseFloat(l.approved_amount || l.principal);
    const alreadyDisbursed = parseFloat(l.disbursed_amount || 0);
    const remaining = approvedAmt - alreadyDisbursed;

    if (remaining <= 0) throw new Error('Loan is already fully disbursed');

    const disburseAmount = amount ? Math.min(amount, remaining) : remaining;
    if (disburseAmount <= 0) throw new Error('Disbursement amount must be positive');

    const newDisbursed = alreadyDisbursed + disburseAmount;
    const fullyDisbursed = Math.abs(newDisbursed - approvedAmt) < 0.01;
    const newStatus = fullyDisbursed ? 'ACTIVE' : 'DISBURSED';

    const systemAccountId = await getSystemAccountId(client);
    client.release();

    // Create disbursement transaction via ledger
    const result = await createTransaction({
      description: `Loan disbursement — ${disburseAmount} UGX${!fullyDisbursed ? ' (partial)' : ''}`,
      transaction_type: 'loan_disbursement',
      reference: loanId,
      metadata: { loan_id: loanId, amount: disburseAmount, total_disbursed: newDisbursed, partial: !fullyDisbursed },
      userId,
      entries: [
        { member_account_id: l.member_account_id, type: 'CREDIT', amount: disburseAmount, description: 'Loan disbursement received' },
        { account_id: systemAccountId, type: 'DEBIT', amount: disburseAmount, description: 'Loan disbursement to member' },
      ],
    });

    // Update loan
    await pool.query(
      `UPDATE loans SET status = $1, disbursed_amount = $2, disbursement_transaction_id = $3,
              disbursed_at = NOW(), updated_at = NOW()
        WHERE id = $4 AND organization_id = $5`,
      [newStatus, newDisbursed, result.transaction.id, loanId, organizationId]
    );

    return {
      loanId,
      status: newStatus,
      disbursed: disburseAmount,
      total_disbursed: newDisbursed,
      remaining: approvedAmt - newDisbursed,
      transactionId: result.transaction.id,
      receiptNumber: result.transaction.receipt_number,
    };
  } catch (err) {
    if (client) client.release();
    throw err;
  }
}

/**
 * Record a loan repayment
 * DEBIT → Member account (money leaves their account)
 * CREDIT → System cash account (SACCO receives money)
 */
export async function repayLoan({ loanId, amount, userId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();

  const loan = await pool.query(
    `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
    [loanId, organizationId]
  );
  if (loan.rows.length === 0) throw new Error('Loan not found');
  const l = loan.rows[0];
  if (l.status !== 'ACTIVE') throw new Error(`Cannot repay loan with status: ${l.status}`);
  if (!l.member_account_id) throw new Error('Loan has no member account');

  const remaining = parseFloat(l.total_payable) - parseFloat(l.total_paid);
  if (amount > remaining + 0.01) {
    throw new Error(`Repayment of ${amount} exceeds remaining balance of ${remaining}`);
  }

  const client = await pool.connect();
  try {
    const systemAccountId = await getSystemAccountId(client);
    client.release();

    // Create repayment transaction via ledger
    const result = await createTransaction({
      description: `Loan repayment — ${amount} UGX`,
      transaction_type: 'loan_repayment',
      reference: loanId,
      metadata: { loan_id: loanId, repayment_amount: amount },
      userId,
      entries: [
        { member_account_id: l.member_account_id, type: 'DEBIT', amount, description: 'Loan repayment' },
        { account_id: systemAccountId, type: 'CREDIT', amount, description: 'Loan repayment received' },
      ],
    });

    // Update total_paid on loan
    const newTotalPaid = parseFloat(l.total_paid) + amount;
    const isComplete = newTotalPaid >= parseFloat(l.total_payable) - 0.01;

    await pool.query(
      `UPDATE loans SET total_paid = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND organization_id = $4`,
      [newTotalPaid, isComplete ? 'COMPLETED' : 'ACTIVE', loanId, organizationId]
    );

    // Update schedule — apply payment to oldest pending installments
    let remainingPayment = amount;
    const schedules = await pool.query(
      `SELECT * FROM loan_schedules
        WHERE loan_id = $1 AND organization_id = $2 AND status IN ('PENDING', 'PARTIAL', 'OVERDUE')
        ORDER BY installment_number ASC`,
      [loanId, organizationId]
    );

    for (const sched of schedules.rows) {
      if (remainingPayment <= 0) break;
      const due = parseFloat(sched.total_amount) - parseFloat(sched.paid_amount);
      const payment = Math.min(remainingPayment, due);

      const newPaid = parseFloat(sched.paid_amount) + payment;
      const schedStatus = newPaid >= parseFloat(sched.total_amount) - 0.01 ? 'PAID' : 'PARTIAL';

      await pool.query(
        `UPDATE loan_schedules SET paid_amount = $1, status = $2,
                paid_at = CASE WHEN $2 = 'PAID' THEN NOW() ELSE paid_at END, transaction_id = $3
          WHERE id = $4 AND organization_id = $5`,
        [newPaid, schedStatus, result.transaction.id, sched.id, organizationId]
      );
      remainingPayment -= payment;
    }

    return {
      loanId,
      repaid: amount,
      totalPaid: newTotalPaid,
      remaining: parseFloat(l.total_payable) - newTotalPaid,
      status: isComplete ? 'COMPLETED' : 'ACTIVE',
      transactionId: result.transaction.id,
      receiptNumber: result.transaction.receipt_number,
    };
  } catch (err) {
    if (client) client.release();
    throw err;
  }
}

/**
 * Mark overdue installments
 */
export async function markOverdueInstallments() {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE loan_schedules 
     SET status = 'OVERDUE' 
     WHERE due_date < CURRENT_DATE AND status IN ('PENDING', 'PARTIAL')
     RETURNING id, loan_id`
  );
  return result.rows;
}

// ─── Guarantor Management ───

/**
 * Add a guarantor to a loan
 */
export async function addGuarantor({ loanId, guarantorMemberId, guaranteedAmount, userId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();

  const loan = await pool.query(
    `SELECT * FROM loans WHERE id = $1 AND organization_id = $2`,
    [loanId, organizationId]
  );
  if (loan.rows.length === 0) throw new Error('Loan not found');
  if (!['PENDING'].includes(loan.rows[0].status)) {
    throw new Error('Can only add guarantors to pending loans');
  }

  // Validate via rule engine
  const validation = await validateGuarantor(guarantorMemberId, guaranteedAmount, loan.rows[0].member_id);
  if (!validation.valid) {
    throw new Error(validation.issues.join('; '));
  }

  const result = await pool.query(
    `INSERT INTO loan_guarantors (organization_id, loan_id, guarantor_member_id, guaranteed_amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (loan_id, guarantor_member_id) DO UPDATE SET guaranteed_amount = $4
     RETURNING *`,
    [organizationId, loanId, guarantorMemberId, guaranteedAmount]
  );

  return { guarantor: result.rows[0], capacity: validation.capacity };
}

/**
 * Get guarantors for a loan
 */
export async function getLoanGuarantors(loanId) {
  const organizationId = requireOrganizationId();
  const pool = getPool();
  const result = await pool.query(
    `SELECT lg.*, m.full_name, m.membership_number
     FROM loan_guarantors lg
     JOIN members m ON lg.guarantor_member_id = m.id AND m.organization_id = lg.organization_id
     WHERE lg.loan_id = $1 AND lg.organization_id = $2
     ORDER BY lg.created_at`,
    [loanId, organizationId]
  );
  return result.rows;
}

/**
 * Remove a guarantor from a pending loan
 */
export async function removeGuarantor({ loanId, guarantorId }) {
  const organizationId = requireOrganizationId();
  const pool = getPool();

  const loan = await pool.query(
    `SELECT status FROM loans WHERE id = $1 AND organization_id = $2`,
    [loanId, organizationId]
  );
  if (loan.rows.length === 0) throw new Error('Loan not found');
  if (loan.rows[0].status !== 'PENDING') throw new Error('Can only remove guarantors from pending loans');

  await pool.query(
    `DELETE FROM loan_guarantors
      WHERE id = $1 AND loan_id = $2 AND organization_id = $3`,
    [guarantorId, loanId, organizationId]
  );
  return { removed: true };
}
