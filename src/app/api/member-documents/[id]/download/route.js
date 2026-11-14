import { NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export const runtime = 'nodejs';

async function getCloudinaryAccount(accountName) {
  try {
    const accounts = await query('SELECT * FROM cloud_accounts WHERE is_active = true ORDER BY is_primary DESC');
    const match = accounts.rows.find((account) => account.account_name === accountName || account.cloud_name === accountName);
    if (match) return match;
  } catch {}
  if (accountName !== 'primary' || !process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Private document storage account is unavailable');
  }
  return { cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET };
}

export async function GET(request, { params }) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const { id } = await params;
    const result = await query('SELECT * FROM member_documents WHERE id = $1', [id]);
    const document = result.rows[0];
    if (!document) return NextResponse.json({ success: false, error: 'Document not found' }, { status: 404 });

    const account = await getCloudinaryAccount(document.cloudinary_account);
    cloudinary.config({ cloud_name: account.cloud_name, api_key: account.api_key, api_secret: account.api_secret });
    const format = document.mime_type === 'application/pdf' ? 'pdf' : document.mime_type === 'image/png' ? 'png' : 'jpg';
    const signedUrl = cloudinary.utils.private_download_url(document.public_id, format, {
      cloud_name: account.cloud_name, api_key: account.api_key, api_secret: account.api_secret,
      resource_type: document.resource_type, type: 'authenticated', attachment: true,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const upstream = await fetch(signedUrl);
    if (!upstream.ok || !upstream.body) return NextResponse.json({ success: false, error: 'Document storage could not deliver the file' }, { status: 502 });
    await query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [perm.auth.userId, 'DOWNLOAD', 'member_document', document.id, JSON.stringify({ member_id: document.member_id, document_key: document.document_key })]);
    const filename = encodeURIComponent(document.original_filename || 'member-document');
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': document.mime_type,
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    });
  } catch (error) {
    console.error('[Member documents] Download failed:', error.message);
    return NextResponse.json({ success: false, error: error.message || 'Download failed' }, { status: 500 });
  }
}
