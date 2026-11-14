'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';

const inputClass = 'w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const CORE = new Set(['first_name', 'last_name']);

export default function MemberRegistrationForm({ memberKind = 'individual', onDone }) {
  const toast = useToast();
  const [fields, setFields] = useState([]);
  const [groups, setGroups] = useState([]);
  const [form, setForm] = useState({ full_name: '', group_id: '' });
  const [groupRequirement, setGroupRequirement] = useState('optional');
  const [groupNature, setGroupNature] = useState('member_type');
  const [saving, setSaving] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState('');

  const loadFormConfig = async () => {
    setLoadingConfig(true);
    setConfigError('');
    try {
      const [fieldResult, groupResult] = await Promise.all([
        fetchWithAuth('/api/member-field-configs'),
        fetchWithAuth('/api/groups'),
      ]);
      if (!fieldResult.success) throw new Error(fieldResult.error || 'Could not load the member registration fields.');
      if (!groupResult.success) throw new Error(groupResult.error || 'Could not load group registration settings.');
      setFields((fieldResult.data || []).filter((field) => field.is_active && !CORE.has(field.field_name)));
      setGroups(groupResult.data || []);
      if (groupResult.policy) {
        setGroupRequirement(groupResult.policy['groups.requirement'] ?? 'optional');
        setGroupNature(groupResult.policy['groups.nature'] ?? 'member_type');
      }
    } catch (error) {
      setConfigError(error.message || 'Could not load registration settings.');
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => { loadFormConfig(); }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (loadingConfig || configError) return;
    setSaving(true);
    try {
      const isSuborganizationGroup = memberKind === 'group' && groupNature === 'sub_organization';
      const response = await fetchWithAuth(isSuborganizationGroup ? '/api/groups' : '/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isSuborganizationGroup ? { name: form.full_name } : { ...form, member_kind: memberKind }),
      });
      const result = await response.json();
      if (!result.success) {
        toast.error(result.error || 'Failed to register');
        return;
      }
      toast.success(memberKind === 'group' ? 'Group registered' : 'Member registered');
      onDone?.(result.data);
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field) => {
    const type = field.field_type === 'select' ? 'select' : field.field_type === 'date' ? 'date' :
      field.field_type === 'email' ? 'email' : field.field_type === 'number' ? 'number' :
      field.field_type === 'phone' ? 'tel' : 'text';
    const common = {
      id: `member-${field.field_name}`,
      name: field.field_name,
      required: field.is_required,
      value: form[field.field_name] || '',
      onChange: (event) => setForm((previous) => ({ ...previous, [field.field_name]: event.target.value })),
      className: inputClass,
    };
    let options = field.options;
    if (typeof options === 'string') {
      try { options = JSON.parse(options); } catch { options = []; }
    }
    return <div key={field.field_name}>
      <label htmlFor={common.id} className="block text-xs font-medium text-muted-foreground mb-1">
        {field.label}{field.is_required ? ' *' : ''}
      </label>
      {field.field_type === 'textarea' ? <textarea {...common} rows={3} /> : type === 'select' ? <select {...common}>
        <option value="">—</option>
        {(Array.isArray(options) ? options : []).map((option) => {
          const value = typeof option === 'object' ? option.value : option;
          const label = typeof option === 'object' ? option.label : option;
          return <option key={value} value={value}>{label}</option>;
        })}
      </select> : <input {...common} type={type} />}
    </div>;
  };

  return <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-6 space-y-4">
    <h2 className="text-lg font-semibold text-foreground">{memberKind === 'group' ? 'Register Group' : 'Register New Member'}</h2>
    {configError && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      <span>{configError}</span>
      <button type="button" onClick={loadFormConfig} className="shrink-0 underline">Retry</button>
    </div>}
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <div>
        <label htmlFor="member-full-name" className="block text-xs font-medium text-muted-foreground mb-1">
          {memberKind === 'group' ? 'Group Name' : 'Full Name'} *
        </label>
        <input id="member-full-name" value={form.full_name} required
          onChange={(event) => setForm((previous) => ({ ...previous, full_name: event.target.value }))}
          className={inputClass} />
      </div>
      {!(memberKind === 'group' && groupNature === 'sub_organization') && fields.map(renderField)}
      {memberKind === 'individual' && groupRequirement !== 'disabled' && ['sub_organization', 'both'].includes(groupNature) && <div>
        <label htmlFor="member-group" className="block text-xs font-medium text-muted-foreground mb-1">Group{groupRequirement === 'required' ? ' *' : ''}</label>
        <select id="member-group" value={form.group_id} required={groupRequirement === 'required'}
          onChange={(event) => setForm((previous) => ({ ...previous, group_id: event.target.value }))} className={inputClass}>
          <option value="">Select a group</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.full_name}</option>)}
        </select>
      </div>}
    </div>
    <button type="submit" disabled={saving || loadingConfig || Boolean(configError)} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
      {saving ? 'Saving...' : loadingConfig ? 'Loading registration fields...' : memberKind === 'group' ? 'Register Group' : 'Register Member'}
    </button>
  </form>;
}
