'use client';

import { useState, useEffect } from 'react';
import { Save, User, Lock, Bell, DollarSign, Palette, ChevronRight, Landmark, Building2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { usePermissions } from '@/components/providers/PermissionProvider';
import Link from 'next/link';

export default function SettingsPage() {
  const [user, setUser] = useState(null);
  const [form, setForm] = useState({ name: '', email: '' });
  const [organizationForm, setOrganizationForm] = useState({
    organization_name: '',
    contact_phones: '',
    contact_email: '',
    website: '',
    address: '',
    use_organization_name_as_app_name: false,
    sidebar_app_name_mode: 'xhaira',
    organization_code: '',
    logo_url: '',
  });
  const [passwordForm, setPasswordForm] = useState({ current: '', newPass: '', confirm: '' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationSaving, setOrganizationSaving] = useState(false);
  const [organizationSaved, setOrganizationSaved] = useState(false);
  const [organizationError, setOrganizationError] = useState('');
  const { hasPermission, loading: permissionsLoading, refreshPermissions } = usePermissions();
  const canManageOrganization = !permissionsLoading && hasPermission('settings.manage');

  useEffect(() => {
    fetchWithAuth('/api/auth/me').then(r => r.json()).then(j => {
      if (j.success && j.data) { setUser(j.data); setForm({ name: j.data.name || '', email: j.data.email || '' }); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!canManageOrganization) return;
    let active = true;
    setOrganizationLoading(true);
    fetchWithAuth('/api/organization/branding')
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Unable to load organization information');
        if (active) setOrganizationForm(result.data);
      })
      .catch((loadError) => {
        if (active) setOrganizationError(loadError.message || 'Unable to load organization information');
      })
      .finally(() => {
        if (active) setOrganizationLoading(false);
      });
    return () => { active = false; };
  }, [canManageOrganization]);

  const saveProfile = async () => {
    setError('');
    try {
      // Profile update would go through a user profile API
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { setError(err.message); }
  };

  const saveOrganization = async (event) => {
    event.preventDefault();
    setOrganizationError('');
    setOrganizationSaved(false);
    setOrganizationSaving(true);
    try {
      const response = await fetchWithAuth('/api/organization/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(organizationForm),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Unable to save organization information');
      setOrganizationForm(result.data);
      setOrganizationSaved(true);
      await refreshPermissions();
      setTimeout(() => setOrganizationSaved(false), 3000);
    } catch (saveError) {
      setOrganizationError(saveError.message || 'Unable to save organization information');
    } finally {
      setOrganizationSaving(false);
    }
  };

  const uploadOrganizationLogo = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setOrganizationError('Choose a PNG, JPEG, WebP, or GIF image.');
      event.target.value = '';
      return;
    }
    if (file.size > 1024 * 1024) {
      setOrganizationError('Logo must be 1 MB or smaller.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setOrganizationForm((formState) => ({ ...formState, logo_url: String(reader.result || '') }));
    reader.onerror = () => setOrganizationError('Unable to read the selected logo.');
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const chooseSidebarName = (mode) => setOrganizationForm((formState) => ({
    ...formState,
    sidebar_app_name_mode: mode,
    use_organization_name_as_app_name: mode === 'organization_name',
  }));

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your account preferences</p>
      </div>

      {/* Quick nav to sub-settings */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[
          { href: '/app/settings/financial', icon: DollarSign, label: 'Financial', desc: 'Currency & formatting' },
          { href: '/app/settings/configurations#marzpay-settlement', icon: Landmark, label: 'Payments & settlement', desc: 'Choose the organization account used for MarzPay collections' },
          { href: '/app/settings/appearance', icon: Palette, label: 'Appearance', desc: 'Theme & colors' },
          { href: '/app/settings/member-fields', icon: User, label: 'Member fields', desc: 'Configure collected member information' },
          { href: '/app/settings/member-documents', icon: Lock, label: 'Member documents', desc: 'Configure private document collection' },
          { href: '/app/settings/configurations', icon: Save, label: 'SACCO policies', desc: 'Groups, membership, and organization policies' },
        ].map(item => (
          <Link key={item.href} href={item.href} className="flex items-center justify-between p-4 bg-card border border-border rounded-xl hover:bg-muted/50 transition group">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
                <item.icon className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
          </Link>
        ))}
      </div>

      {canManageOrganization && (
        <form onSubmit={saveOrganization} className="bg-card rounded-xl border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-muted-foreground" />
            <div>
              <h2 className="font-semibold text-foreground">Organization information</h2>
              <p className="text-xs text-muted-foreground">Used for organization-branded documents and app identity.</p>
            </div>
          </div>
          {organizationLoading ? (
            <p className="text-sm text-muted-foreground">Loading organization information...</p>
          ) : (
            <>
              <div>
                <label htmlFor="organization-name" className="block text-sm text-muted-foreground mb-1">Organization name</label>
                <input id="organization-name" required maxLength={255} value={organizationForm.organization_name}
                  onChange={e => setOrganizationForm(f => ({ ...f, organization_name: e.target.value }))}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="organization-phones" className="block text-sm text-muted-foreground mb-1">Telephone contacts</label>
                  <input id="organization-phones" maxLength={500} value={organizationForm.contact_phones}
                    onChange={e => setOrganizationForm(f => ({ ...f, contact_phones: e.target.value }))}
                    placeholder="Separate multiple numbers with commas"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
                </div>
                <div>
                  <label htmlFor="organization-email" className="block text-sm text-muted-foreground mb-1">Organization email</label>
                  <input id="organization-email" type="email" maxLength={254} value={organizationForm.contact_email}
                    onChange={e => setOrganizationForm(f => ({ ...f, contact_email: e.target.value }))}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
                </div>
                <div>
                  <label htmlFor="organization-website" className="block text-sm text-muted-foreground mb-1">Website</label>
                  <input id="organization-website" type="url" maxLength={500} value={organizationForm.website}
                    onChange={e => setOrganizationForm(f => ({ ...f, website: e.target.value }))}
                    placeholder="https://example.org"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
                </div>
                <div>
                  <label htmlFor="organization-address" className="block text-sm text-muted-foreground mb-1">Address</label>
                  <textarea id="organization-address" maxLength={1000} rows={2} value={organizationForm.address}
                    onChange={e => setOrganizationForm(f => ({ ...f, address: e.target.value }))}
                    className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
                </div>
              </div>
              <div className="space-y-3">
                <label htmlFor="organization-logo" className="block text-sm text-muted-foreground">Sidebar logo</label>
                <div className="flex items-center gap-3">
                  {organizationForm.logo_url ? (
                    <img src={organizationForm.logo_url} alt="Organization logo preview" className="h-12 w-12 rounded-lg border border-border object-contain bg-white p-1" />
                  ) : (
                    <div className="h-12 w-12 rounded-lg border border-border bg-muted flex items-center justify-center text-muted-foreground"><Building2 className="h-5 w-5" /></div>
                  )}
                  <div className="space-y-2">
                    <input id="organization-logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={uploadOrganizationLogo}
                      className="block max-w-full text-xs text-muted-foreground" />
                    {organizationForm.logo_url && <button type="button" onClick={() => setOrganizationForm(f => ({ ...f, logo_url: '' }))} className="text-xs text-red-600 hover:underline">Remove logo</button>}
                  </div>
                </div>
                <div>
                  <label htmlFor="organization-logo-url" className="block text-xs text-muted-foreground mb-1">Or use an image URL</label>
                  <input id="organization-logo-url" type="url" maxLength={2048} value={organizationForm.logo_url.startsWith('data:') ? '' : organizationForm.logo_url}
                    onChange={e => setOrganizationForm(f => ({ ...f, logo_url: e.target.value }))} placeholder="https://example.org/logo.png"
                    className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">Sidebar app name</legend>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="sidebar-app-name" value="xhaira" checked={organizationForm.sidebar_app_name_mode === 'xhaira'}
                    onChange={() => chooseSidebarName('xhaira')} />
                  Use XHAIRA
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="sidebar-app-name" value="organization" checked={organizationForm.sidebar_app_name_mode === 'organization_name'}
                    onChange={() => chooseSidebarName('organization_name')} />
                  Use the organization name
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="sidebar-app-name" value="organization-code" checked={organizationForm.sidebar_app_name_mode === 'organization_code'}
                    onChange={() => chooseSidebarName('organization_code')} />
                  Use organization code ({organizationForm.organization_code || 'your organization slug'})
                </label>
              </fieldset>
            </>
          )}
          {organizationError && <p role="alert" className="text-sm text-red-600">{organizationError}</p>}
          <div className="flex items-center gap-3">
            <button type="submit" disabled={organizationSaving || organizationLoading}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              <Save className="w-4 h-4" /> {organizationSaving ? 'Saving...' : 'Save organization information'}
            </button>
            {organizationSaved && <span role="status" className="text-sm text-emerald-600">Saved</span>}
          </div>
        </form>
      )}

      {/* Profile */}
      <div className="bg-card rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <User className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">Profile</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">Email</label>
            <input value={form.email} disabled className="w-full px-3 py-2 border border-border rounded-lg bg-muted text-muted-foreground" />
          </div>
        </div>
        {user && (
          <div className="text-xs text-muted-foreground">
            Role: <span className="capitalize font-medium text-muted-foreground">{user.role}</span> &middot; 
            Joined: {new Date(user.created_at).toLocaleDateString()}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button onClick={saveProfile} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
            <Save className="w-4 h-4" /> Save Profile
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved!</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </div>

      {/* Security */}
      <div className="bg-card rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <Lock className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">Security</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">Current Password</label>
            <input type="password" value={passwordForm.current} onChange={e => setPasswordForm(f => ({ ...f, current: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-muted-foreground mb-1">New Password</label>
              <input type="password" value={passwordForm.newPass} onChange={e => setPasswordForm(f => ({ ...f, newPass: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">Confirm Password</label>
              <input type="password" value={passwordForm.confirm} onChange={e => setPasswordForm(f => ({ ...f, confirm: e.target.value }))} className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground" />
            </div>
          </div>
        </div>
        <button className="bg-muted text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted/80 transition">
          Change Password
        </button>
      </div>

      {/* App Info */}
      <div className="bg-card rounded-xl border p-5">
        <div className="flex items-center gap-2 mb-3">
          <Bell className="w-5 h-5 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">About</h2>
        </div>
        <div className="text-sm text-muted-foreground space-y-1">
          <div>Xhaira Founder OS</div>
          <div>Architecture: Ledger-based finance, event-driven</div>
          <div>Database: PostgreSQL on Neon</div>
        </div>
      </div>
    </div>
  );
}
