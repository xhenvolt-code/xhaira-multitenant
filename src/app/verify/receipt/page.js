import ReceiptVerification from '@/components/receipts/ReceiptVerification.js';

export const dynamic = 'force-dynamic';

export default async function VerifyReceiptPage({ searchParams }) {
  const params = await searchParams;
  return <ReceiptVerification
    receiptNumber={String(params?.number || '').toUpperCase()}
    stamp={String(params?.stamp || '')}
  />;
}
