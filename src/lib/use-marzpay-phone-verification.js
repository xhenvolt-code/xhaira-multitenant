'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/fetch-client';

function toUgandaPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (/^0[37]\d{8}$/.test(digits)) digits = `256${digits.slice(1)}`;
  else if (/^[37]\d{8}$/.test(digits)) digits = `256${digits}`;
  return /^256[37]\d{8}$/.test(digits) ? digits : null;
}

export function useMarzpayPhoneVerification(phone, enabled = true) {
  const [verification, setVerification] = useState({ status: 'idle', fullName: '', error: '' });
  const normalizedPhone = toUgandaPhone(phone);
  const requestVersion = useRef(0);

  const onPhoneChange = useCallback((value) => {
    requestVersion.current += 1;
    if (enabled && toUgandaPhone(value)) setVerification({ status: 'checking', fullName: '', error: '' });
    else setVerification({ status: 'idle', fullName: '', error: '' });
  }, [enabled]);

  useEffect(() => {
    const requestId = ++requestVersion.current;
    if (!enabled || !normalizedPhone) {
      setVerification({ status: 'idle', fullName: '', error: '' });
      return undefined;
    }
    setVerification({ status: 'checking', fullName: '', error: '' });
    const timer = setTimeout(async () => {
      try {
        const response = await fetchWithAuth('/api/marzpay/phone-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: normalizedPhone }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'MarzPay could not verify this number');
        if (requestId === requestVersion.current) setVerification({ status: 'verified', fullName: result.data.fullName, error: '' });
      } catch (error) {
        if (requestId === requestVersion.current) setVerification({ status: 'error', fullName: '', error: error.message || 'Phone verification failed' });
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      if (requestVersion.current === requestId) requestVersion.current += 1;
    };
  }, [enabled, normalizedPhone]);

  return { ...verification, onPhoneChange };
}
