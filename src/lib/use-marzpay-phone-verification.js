'use client';

import { useCallback, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/fetch-client';

function phoneForLookup(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (/^0[37]/.test(digits)) digits = `256${digits.slice(1)}`;
  else if (/^[37]/.test(digits)) digits = `256${digits}`;
  return digits;
}

export function useMarzpayPhoneVerification(enabled = true) {
  const [verification, setVerification] = useState({ status: 'idle', fullName: '', error: '' });
  const requestVersion = useRef(0);

  const onPhoneInput = useCallback(async (value) => {
    const requestId = ++requestVersion.current;
    const lookupPhone = phoneForLookup(value);
    if (!enabled || !lookupPhone) {
      setVerification({ status: 'idle', fullName: '', error: '' });
      return;
    }

    setVerification({ status: 'checking', fullName: '', error: '', phone: lookupPhone });
    try {
      const response = await fetchWithAuth('/api/marzpay/phone-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: lookupPhone }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'MarzPay could not verify this number');
      if (requestId === requestVersion.current) setVerification({ status: 'verified', fullName: result.data.fullName, error: '', phone: lookupPhone });
    } catch (error) {
      if (requestId === requestVersion.current) setVerification({ status: 'error', fullName: '', error: error.message || 'Phone verification failed', phone: lookupPhone });
    }
  }, [enabled]);

  return { ...verification, onPhoneInput };
}
