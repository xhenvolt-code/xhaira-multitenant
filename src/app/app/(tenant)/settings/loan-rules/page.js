'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save } from 'lucide-react';
import { usePermissions } from '@/components/providers/PermissionProvider';
import { useToast } from '@/components/ui/Toast';
import { fetchWithAuth } from '@/lib/fetch-client';
import { EXTERNAL_GUARANTOR_FIELDS, resolveGuarantorRequirements } from '@/lib/loan-guarantor-rules.js';

const INPUT_CLASS = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground';

export default function LoanRulesPage() {
  const { can } = usePermissions();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState({
    member_count: 2,
    external_count: 1,
    member_scope: 'SAME_GROUP',
    external_required_fields: Object.keys(EXTERNAL_GUARANTOR_FIELDS),
    min_fixed_savings: 500000,
    max_loan_multiplier: 3,
    max_active_loans: 2,
    default_interest_rate: 10,
    default_duration: 12,
    default_duration_unit: 'MONTHS',
    default_repayment_cycle: 'MONTHLY',
    min_membership_months: 3,
    max_guarantee_percentage: 50,
  });

  useEffect(() => {
    let active = true;
    async function loadRules() {
      try {
        const result = await fetchWithAuth('/api/sacco-rules');
        if (!result.success) throw new Error(result.error || 'Could not load loan rules.');
        if (!active) return;
        const data = result.data || [];
        setRules(data);
        const valueFor = (type, key) => data.find(rule =>
          rule.rule_type === type && rule.rule_key === key && rule.is_active
        )?.rule_value;
        const guarantorRequirements = resolveGuarantorRequirements(valueFor('LOAN', 'guarantors_required'));
        setForm({
          member_count: guarantorRequirements.member_count,
          external_count: guarantorRequirements.external_count,
          member_scope: guarantorRequirements.member_scope,
          external_required_fields: guarantorRequirements.external_required_fields,
          min_fixed_savings: Number(valueFor('LOAN', 'min_fixed_savings_for_loan')?.amount ?? 500000),
          max_loan_multiplier: Number(valueFor('LOAN', 'max_loan_multiplier')?.multiplier ?? 3),
          max_active_loans: Number(valueFor('LOAN', 'max_active_loans')?.count ?? 2),
          default_interest_rate: Number(valueFor('LOAN', 'default_interest_rate')?.rate_percent ?? 10),
          default_duration: Number(valueFor('LOAN', 'default_duration')?.value ?? 12),
          default_duration_unit: valueFor('LOAN', 'default_duration')?.unit || 'MONTHS',
          default_repayment_cycle: valueFor('LOAN', 'default_repayment_cycle')?.cycle || 'MONTHLY',
          min_membership_months: Number(valueFor('GUARANTOR', 'min_membership_months')?.months ?? 3),
          max_guarantee_percentage: Number(valueFor('GUARANTOR', 'max_guarantee_percentage')?.percentage ?? 50),
        });
      } catch (error) {
        if (active) toast.error(error.message || 'Could not load loan rules.');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadRules();
    return () => { active = false; };
  }, []);

  function setNumber(field, rawValue) {
    setForm(current => ({ ...current, [field]: rawValue }));
  }

  function toggleExternalField(field) {
    setForm(current => ({
      ...current,
      external_required_fields: current.external_required_fields.includes(field)
        ? current.external_required_fields.filter(item => item !== field)
        : [...current.external_required_fields, field],
    }));
  }

  async function save(event) {
    event.preventDefault();
    const numericFields = [
      ['member_count', 0, 10],
      ['external_count', 0, 10],
      ['min_fixed_savings', 0, Number.MAX_SAFE_INTEGER],
      ['max_loan_multiplier', 0, 100],
      ['max_active_loans', 1, 100],
      ['default_interest_rate', 0, 1000],
      ['default_duration', 1, 10000],
      ['min_membership_months', 0, 1200],
      ['max_guarantee_percentage', 0, 100],
    ];
    for (const [field, minimum, maximum] of numericFields) {
      const value = Number(form[field]);
      if (!Number.isFinite(value) || value < minimum || value > maximum ||
          (field !== 'min_fixed_savings' && field !== 'max_loan_multiplier' &&
            field !== 'default_interest_rate' && !Number.isInteger(value))) {
        toast.error(`${field.replaceAll('_', ' ')} is outside its allowed range.`);
        return;
      }
    }
    if (form.external_required_fields.length === 0 && Number(form.external_count) > 0) {
      toast.error('Select at least one required field for outside guarantors.');
      return;
    }

    setSaving(true);
    const updates = [
      {
        rule_type: 'LOAN',
        rule_key: 'guarantors_required',
        rule_value: {
          count: Number(form.member_count),
          member_count: Number(form.member_count),
          external_count: Number(form.external_count),
          member_scope: form.member_scope,
          external_required_fields: form.external_required_fields,
        },
        description: 'Required active member and outside guarantors; required outside-guarantor fields are configurable',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'min_fixed_savings_for_loan',
        rule_value: { amount: Number(form.min_fixed_savings) },
        description: 'Minimum fixed savings balance required to qualify for a loan',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'max_loan_multiplier',
        rule_value: { multiplier: Number(form.max_loan_multiplier) },
        description: 'Maximum loan amount as a multiple of eligible fixed savings',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'max_active_loans',
        rule_value: { count: Number(form.max_active_loans) },
        description: 'Maximum pending, approved, or active loans per member',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'default_interest_rate',
        rule_value: { rate_percent: Number(form.default_interest_rate) },
        description: 'Default annual simple-interest rate used when a loan product has no rate or is not selected',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'default_duration',
        rule_value: { value: Number(form.default_duration), unit: form.default_duration_unit },
        description: 'Default loan term when no loan product is selected',
      },
      {
        rule_type: 'LOAN',
        rule_key: 'default_repayment_cycle',
        rule_value: { cycle: form.default_repayment_cycle },
        description: 'Default repayment cycle when no loan product is selected',
      },
      {
        rule_type: 'GUARANTOR',
        rule_key: 'min_membership_months',
        rule_value: { months: Number(form.min_membership_months) },
        description: 'Minimum membership period before a member can guarantee a loan',
      },
      {
        rule_type: 'GUARANTOR',
        rule_key: 'max_guarantee_percentage',
        rule_value: { percentage: Number(form.max_guarantee_percentage) },
        description: 'Maximum percentage of savings a member may guarantee',
      },
    ];

    try {
      for (const rule of updates) {
        const existing = rules.find(item =>
          item.rule_type === rule.rule_type && item.rule_key === rule.rule_key
        );
        const result = existing
          ? await fetchWithAuth(`/api/sacco-rules/${existing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule_value: rule.rule_value, description: rule.description, is_active: true }),
          })
          : await fetchWithAuth('/api/sacco-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rule),
          });
        if (!result.success) throw new Error(result.error || `Could not save ${rule.rule_key}.`);
        setRules(current => {
          const next = current.filter(item => item.id !== result.data.id);
          return [...next, result.data];
        });
      }
      toast.success('Loan rules saved.');
    } catch (error) {
      toast.error(`${error.message || 'Could not save loan rules.'} Earlier rules may already have been saved; reload to verify.`);
    } finally {
      setSaving(false);
    }
  }

  if (!can('finance.manage')) {
    return <div className="p-8 text-center text-muted-foreground">You do not have permission to manage loan rules.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Link href="/app/settings" className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Settings
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Loan Rules</h1>
        <p className="mt-1 text-sm text-muted-foreground">Configure eligibility, member guarantors, outside guarantors, and guarantor capacity for this organization.</p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading loan rules…</div>
      ) : (
        <form onSubmit={save} className="space-y-6 rounded-xl border border-border bg-card p-5">
          <section className="space-y-4">
            <h2 className="font-semibold text-foreground">Guarantor requirements</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted-foreground">
                Minimum member guarantors
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="10" step="1" value={form.member_count}
                  onChange={event => setNumber('member_count', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground">
                Minimum outside guarantors
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="10" step="1" value={form.external_count}
                  onChange={event => setNumber('external_count', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground sm:col-span-2">
                Eligible member guarantors
                <select className={`${INPUT_CLASS} mt-1`} value={form.member_scope}
                  onChange={event => setForm(current => ({ ...current, member_scope: event.target.value }))}>
                  <option value="SAME_GROUP">Only active members of the applicant&apos;s group</option>
                  <option value="ANY_ORGANIZATION_MEMBER">Any active individual member of this organization</option>
                </select>
              </label>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Required outside-guarantor details</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(EXTERNAL_GUARANTOR_FIELDS).map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input type="checkbox" checked={form.external_required_fields.includes(field)}
                      onChange={() => toggleExternalField(field)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          <section className="space-y-4 border-t border-border pt-5">
            <h2 className="font-semibold text-foreground">Loan eligibility</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted-foreground">
                Minimum fixed savings (UGX)
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" step="1" value={form.min_fixed_savings}
                  onChange={event => setNumber('min_fixed_savings', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground">
                Maximum loan / eligible savings multiplier
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="100" step="0.01" value={form.max_loan_multiplier}
                  onChange={event => setNumber('max_loan_multiplier', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground">
                Maximum pending or active loans per member
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="1" max="100" step="1" value={form.max_active_loans}
                  onChange={event => setNumber('max_active_loans', event.target.value)} />
              </label>
            </div>
          </section>

          <section className="space-y-4 border-t border-border pt-5">
            <h2 className="font-semibold text-foreground">Default loan terms</h2>
            <p className="text-sm text-muted-foreground">Used when no loan product is selected or a product leaves a term unset. Product-specific values override these defaults.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted-foreground">
                Default annual simple-interest rate (%)
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="1000" step="0.01" value={form.default_interest_rate}
                  onChange={event => setNumber('default_interest_rate', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground">
                Default loan duration
                <div className="mt-1 flex gap-2">
                  <input className={INPUT_CLASS} type="number" min="1" max="10000" step="1" value={form.default_duration}
                    onChange={event => setNumber('default_duration', event.target.value)} />
                  <select className={INPUT_CLASS} value={form.default_duration_unit}
                    onChange={event => setForm(current => ({ ...current, default_duration_unit: event.target.value }))}>
                    {['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].map(unit => <option key={unit} value={unit}>{unit.toLowerCase()}</option>)}
                  </select>
                </div>
              </label>
              <label className="text-sm text-muted-foreground">
                Default repayment cycle
                <select className={`${INPUT_CLASS} mt-1`} value={form.default_repayment_cycle}
                  onChange={event => setForm(current => ({ ...current, default_repayment_cycle: event.target.value }))}>
                  {['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'].map(cycle => (
                    <option key={cycle} value={cycle}>{cycle.toLowerCase()}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="space-y-4 border-t border-border pt-5">
            <h2 className="font-semibold text-foreground">Member guarantor limits</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm text-muted-foreground">
                Minimum membership (months)
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="1200" step="1" value={form.min_membership_months}
                  onChange={event => setNumber('min_membership_months', event.target.value)} />
              </label>
              <label className="text-sm text-muted-foreground">
                Maximum guarantee as % of savings
                <input className={`${INPUT_CLASS} mt-1`} type="number" min="0" max="100" step="0.01" value={form.max_guarantee_percentage}
                  onChange={event => setNumber('max_guarantee_percentage', event.target.value)} />
              </label>
            </div>
          </section>

          <div className="flex justify-end border-t border-border pt-5">
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save Loan Rules'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
