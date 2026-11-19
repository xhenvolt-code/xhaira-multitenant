export async function ensureEmployeeWallet(client, { staffId, organizationId, currency = 'UGX' }) {
  const staffResult = await client.query(
    `SELECT id, name
       FROM staff
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE`,
    [staffId, organizationId]
  );
  const staff = staffResult.rows[0];
  if (!staff) throw new Error('Staff member not found');

  const existingResult = await client.query(
    `SELECT ea.id, ea.account_id, ea.currency, ea.status,
            a.type AS account_type, a.is_active, a.status AS account_status
       FROM employee_accounts ea
       JOIN accounts a
         ON a.id = ea.account_id
        AND a.organization_id = ea.organization_id
      WHERE ea.staff_id = $1
        AND ea.organization_id = $2
      FOR UPDATE OF ea, a`,
    [staffId, organizationId]
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (existing.account_type !== 'internal' || existing.currency !== currency ||
        existing.status !== 'active' || existing.is_active !== true ||
        existing.account_status !== 'active') {
      throw new Error('Staff wallet is not an active internal account in the requested currency');
    }
    return existing;
  }

  const accountResult = await client.query(
    `INSERT INTO accounts
       (organization_id, name, type, currency, description, is_active, status)
     VALUES ($1, $2, 'internal', $3, $4, TRUE, 'active')
     RETURNING id, type, currency, is_active, status`,
    [
      organizationId,
      `Staff wallet ${staff.id}`,
      currency,
      `Internal wallet for staff member ${staff.id}`,
    ]
  );
  const account = accountResult.rows[0];
  const employeeAccountResult = await client.query(
    `INSERT INTO employee_accounts
       (organization_id, staff_id, account_id, balance, currency, status)
     VALUES ($1, $2, $3, 0, $4, 'active')
     RETURNING id, account_id, currency, status`,
    [organizationId, staffId, account.id, currency]
  );

  return {
    ...employeeAccountResult.rows[0],
    account_type: account.type,
    is_active: account.is_active,
    account_status: account.status,
  };
}
