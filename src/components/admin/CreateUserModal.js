'use client';

/**
 * Create User Modal
 * Admin-only form for creating new user accounts
 * Used in /app/admin/users page
 */

import { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';

export function CreateUserModal({ isOpen, onClose, onUserCreated, roles = [] }) {
  const [form, setForm] = useState({
    email: '',
    name: '',
    username: '',
    password: '',
    role_id: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();

  useEffect(() => {
    if (!isOpen || form.role_id) return;
    const defaultRole = roles.find((role) => role.name === 'staff') || roles.find((role) => role.name === 'user') || roles.find((role) => role.name !== 'superadmin');
    if (defaultRole) setForm((current) => ({ ...current, role_id: defaultRole.id }));
  }, [isOpen, form.role_id, roles]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(f => ({ ...f, [name]: value }));
    setError(null);
  };

  const validateForm = () => {
    if (!form.email || !form.name || !form.username || !form.password || !form.role_id) {
      setError('All fields are required');
      return false;
    }
    if (!/^[a-z0-9_]{3,100}$/i.test(form.username.trim())) {
      setError('Username must be at least 3 characters and use only letters, numbers, or underscores');
      return false;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return false;
    }
    if (!form.email.includes('@')) {
      setError('Invalid email address');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetchWithAuth('/api/admin/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || data.message || 'Failed to create user');
        return;
      }

      toast.success(`User ${form.email} created successfully`);
      
      // Reset form
      setForm({
        email: '',
        name: '',
        username: '',
        password: '',
        role_id: '',
      });

      // Notify parent to refetch users
      if (onUserCreated) {
        onUserCreated(data.user);
      }

      onClose();
    } catch (err) {
      console.error('Error creating user:', err);
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-background border border-border rounded-lg max-w-md w-full p-6 shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold text-foreground">Create New User</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition"
            disabled={loading}
          >
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <input
              type="text"
              name="name"
              value={form.name}
              onChange={handleChange}
              placeholder="John Doe"
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Username
            </label>
            <input
              type="text"
              name="username"
              value={form.username}
              onChange={handleChange}
              placeholder="john_doe"
              autoComplete="username"
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Email
            </label>
            <input
              type="email"
              name="email"
              value={form.email}
              onChange={handleChange}
              placeholder="john@xhaira.app"
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Temporary Password
            </label>
            <input
              type="password"
              name="password"
              value={form.password}
              onChange={handleChange}
              placeholder="Min. 8 characters"
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Role
            </label>
            <select
              name="role_id"
              value={form.role_id}
              onChange={handleChange}
              className="w-full px-3 py-2 border border-border rounded bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            >
              <option value="">Select a role</option>
              {roles.filter((role) => role.name !== 'superadmin').map((role) => (
                <option key={role.id} value={role.id}>{role.alias || role.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-border rounded text-foreground hover:bg-muted/50 transition disabled:opacity-50"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition disabled:opacity-50 flex items-center justify-center gap-2"
              disabled={loading}
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              Create User
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
