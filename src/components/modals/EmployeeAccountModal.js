import { useState } from 'react';
import { Save, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';
import Modal from '@/components/ui/Modal';

export function EmployeeAccountModal({ isOpen, onClose, staffList, onSuccess }) {
  const toast = useToast();
  const [staffId, setStaffId] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!staffId) {
      setError('Select a staff member');
      return;
    }
    setIsLoading(true);

    try {
      const data = await fetchWithAuth('/api/employee-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staff_id: staffId })
      });

      if (!data.success) {
        setError(data.error || 'Failed to create employee account');
        return;
      }

      toast.success('Staff wallet created. No balance was added.');
      setStaffId('');
      onClose();
      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass = 'w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Staff Wallet" size="md" footer={
      <div className="flex items-center justify-between">
        <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition">Cancel</button>
        <button onClick={handleSubmit} disabled={isLoading} className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition text-sm"><Save className="w-4 h-4" /> {isLoading ? 'Creating...' : 'Create Account'}</button>
      </div>
    }>
      <div className="space-y-4">
        {error && <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 rounded-lg text-sm"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</div>}
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Staff Member *</label>
          <select value={staffId} onChange={event => setStaffId(event.target.value)} className={inputClass} required>
            <option value="">Select staff...</option>
            {staffList?.map(staff => <option key={staff.id} value={staff.id}>{staff.name}</option>)}
          </select>
        </div>
        <p className="text-sm text-muted-foreground">
          This creates an empty, tenant-scoped UGX wallet. It does not create a balance or move money.
        </p>
      </div>
    </Modal>
  );
}
