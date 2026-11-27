function durationInMonths(duration, unit) {
  const factor = { DAYS: 1 / 30, WEEKS: 7 / 30, MONTHS: 1, YEARS: 12 }[unit];
  if (!factor) throw new TypeError('Duration unit must be DAYS, WEEKS, MONTHS, or YEARS');
  return duration * factor;
}

function installmentCount(duration, unit, cycle) {
  const days = duration * { DAYS: 1, WEEKS: 7, MONTHS: 30, YEARS: 365 }[unit];
  const months = durationInMonths(duration, unit);
  const periods = {
    DAILY: days,
    WEEKLY: days / 7,
    BIWEEKLY: days / 14,
    MONTHLY: months,
    QUARTERLY: months / 3,
    ANNUALLY: months / 12,
  }[cycle] ?? months;
  return Math.max(1, Math.ceil(periods));
}

export function calculateLoan({
  principal,
  interestRate,
  duration,
  durationUnit = 'MONTHS',
  repaymentCycle = 'MONTHLY',
}) {
  const normalizedUnit = String(durationUnit).toUpperCase();
  const normalizedCycle = String(repaymentCycle).toUpperCase();
  if (!Number.isFinite(Number(principal)) || Number(principal) <= 0 ||
      !Number.isFinite(Number(interestRate)) || Number(interestRate) < 0 ||
      !Number.isFinite(Number(duration)) || Number(duration) <= 0 ||
      !Number.isInteger(Number(duration))) {
    throw new TypeError('Principal and duration must be positive values; interest rate must be non-negative');
  }
  const totalInstallments = installmentCount(Number(duration), normalizedUnit, normalizedCycle);
  const principalCents = Math.round(Number(principal) * 100);
  const interestCents = Math.round(
    principalCents * (Number(interestRate) / 100) * (durationInMonths(Number(duration), normalizedUnit) / 12)
  );
  const totalCents = principalCents + interestCents;
  const principalPerInstallment = Math.floor(principalCents / totalInstallments);
  const interestPerInstallment = Math.floor(interestCents / totalInstallments);

  const schedule = [];
  const today = new Date();
  let allocatedPrincipal = 0;
  let allocatedInterest = 0;
  for (let i = 1; i <= totalInstallments; i++) {
    const principalInstallmentCents = i === totalInstallments
      ? principalCents - allocatedPrincipal
      : principalPerInstallment;
    const interestInstallmentCents = i === totalInstallments
      ? interestCents - allocatedInterest
      : interestPerInstallment;
    allocatedPrincipal += principalInstallmentCents;
    allocatedInterest += interestInstallmentCents;
    const dueDate = new Date(today);
    switch (normalizedCycle) {
      case 'DAILY': dueDate.setDate(dueDate.getDate() + i); break;
      case 'WEEKLY': dueDate.setDate(dueDate.getDate() + i * 7); break;
      case 'BIWEEKLY': dueDate.setDate(dueDate.getDate() + i * 14); break;
      case 'MONTHLY': dueDate.setMonth(dueDate.getMonth() + i); break;
      case 'QUARTERLY': dueDate.setMonth(dueDate.getMonth() + i * 3); break;
      case 'ANNUALLY': dueDate.setFullYear(dueDate.getFullYear() + i); break;
      default: throw new TypeError('Invalid repayment cycle');
    }

    schedule.push({
      installment_number: i,
      due_date: dueDate.toISOString().split('T')[0],
      principal_amount: principalInstallmentCents / 100,
      interest_amount: interestInstallmentCents / 100,
      total_amount: (principalInstallmentCents + interestInstallmentCents) / 100,
    });
  }

  return {
    totalInterest: interestCents / 100,
    totalPayable: totalCents / 100,
    schedule,
  };
}
