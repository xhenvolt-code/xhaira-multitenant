import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { v2 as cloudinary } from 'cloudinary';
import { query } from '@/lib/db.js';
import { requirePermission } from '@/lib/permissions.js';
import { runWithOrganizationContext } from '@/lib/organization-context.js';

export const runtime = 'nodejs';
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);

async function getCloudinaryAccount(organizationId, accountName) {
  try {
    const result = await query(
      'SELECT * FROM cloud_accounts WHERE organization_id = $1 AND is_active = true ORDER BY is_primary DESC',
      [organizationId]
    );
    const account = accountName ? result.rows.find((row) => row.account_name === accountName) : result.rows[0];
    if (account) return account;
  } catch {}
  if (accountName) throw new Error('Document storage account is unavailable');
  const envAccount = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    account_name: 'primary',
  };
  if (!envAccount.cloud_name || !envAccount.api_key || !envAccount.api_secret) throw new Error('Private document storage is not configured');
  return envAccount;
}

function isValidSignature(mimeType, bytes) {
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return false;
}

// POST /api/member-documents — upload a tenant-private, authenticated asset.
export async function POST(request) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const form = await request.formData();
    const file = form.get('file');
    const memberId = form.get('member_id');
    const documentKey = form.get('document_key');
    if (!file || typeof memberId !== 'string' || typeof documentKey !== 'string') {
      return NextResponse.json({ success: false, error: 'file, member_id, and document_key are required' }, { status: 400 });
    }
    const member = await query('SELECT id FROM members WHERE id = $1 AND organization_id = $2', [memberId, perm.auth.organizationId]);
    if (!member.rows[0]) return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
    const configResult = await query(
      'SELECT * FROM member_document_type_configs WHERE document_key = $1 AND organization_id = $2',
      [documentKey, perm.auth.organizationId]
    );
    const docConfig = configResult.rows[0];
    if (!docConfig?.is_enabled) return NextResponse.json({ success: false, error: 'This document type is disabled' }, { status: 400 });
    if (!ALLOWED_MIME.has(file.type) || !docConfig.accepted_mime_types.includes(file.type)) {
      return NextResponse.json({ success: false, error: 'This file type is not accepted for this document' }, { status: 415 });
    }
    if (!file.size || file.size > Number(docConfig.max_size_bytes)) {
      return NextResponse.json({ success: false, error: 'File is empty or exceeds the configured size limit' }, { status: 413 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!isValidSignature(file.type, bytes)) return NextResponse.json({ success: false, error: 'File content does not match its declared type' }, { status: 415 });

    const account = await getCloudinaryAccount(perm.auth.organizationId);
    cloudinary.config({ cloud_name: account.cloud_name, api_key: account.api_key, api_secret: account.api_secret });
    const publicId = `xhaira/${perm.auth.organizationId}/member-documents/${memberId}/${documentKey}/${randomUUID()}`;
    const resourceType = file.type.startsWith('image/') ? 'image' : 'raw';
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({
        public_id: publicId,
        resource_type: resourceType,
        type: 'authenticated',
        overwrite: false,
        context: { organization_id: perm.auth.organizationId, member_id: memberId, document_key: documentKey },
      }, (error, result) => error ? reject(error) : resolve(result));
      stream.end(bytes);
    });
    const saved = await query(
      `INSERT INTO member_documents
        (organization_id, member_id, document_key, original_filename, mime_type, file_size, cloudinary_account, public_id, resource_type, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, member_id, document_key, original_filename, mime_type, file_size, uploaded_at`,
      [perm.auth.organizationId, memberId, documentKey, String(file.name || 'document').slice(0, 255), file.type, file.size,
        account.account_name || account.cloud_name, uploaded.public_id, resourceType, perm.auth.userId]
    );
    await query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [perm.auth.userId, 'UPLOAD', 'member_document', saved.rows[0].id, JSON.stringify({ member_id: memberId, document_key: documentKey })]);
    return NextResponse.json({ success: true, data: saved.rows[0] }, { status: 201 });
    });
  } catch (error) {
    console.error('[Member documents] Upload failed:', error.message);
    return NextResponse.json({ success: false, error: error.message || 'Upload failed' }, { status: 500 });
  }
}

// GET /api/member-documents?member_id=... — return short-lived private download links.
export async function GET(request) {
  try {
    const perm = await requirePermission(request, 'members.manage');
    if (perm instanceof NextResponse) return perm;
    return await runWithOrganizationContext(perm.auth.organizationId, async () => {
    const memberId = new URL(request.url).searchParams.get('member_id');
    if (!memberId) return NextResponse.json({ success: false, error: 'member_id is required' }, { status: 400 });
    const member = await query(
      'SELECT id FROM members WHERE id = $1 AND organization_id = $2',
      [memberId, perm.auth.organizationId]
    );
    if (!member.rows[0]) return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 });
    const result = await query(
      'SELECT * FROM member_documents WHERE member_id = $1 AND organization_id = $2 ORDER BY uploaded_at DESC',
      [memberId, perm.auth.organizationId]
    );
    await query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
      [perm.auth.userId, 'VIEW', 'member_documents', memberId, JSON.stringify({ document_count: result.rows.length })]);
    const data = result.rows.map((document) => ({ id: document.id, member_id: document.member_id, document_key: document.document_key,
        original_filename: document.original_filename, mime_type: document.mime_type, file_size: document.file_size,
        uploaded_at: document.uploaded_at, download_url: `/api/member-documents/${document.id}/download` }));
    return NextResponse.json({ success: true, data });
    });
  } catch (error) {
    console.error('[Member documents] Read failed:', error.message);
    return NextResponse.json({ success: false, error: error.message || 'Failed to fetch documents' }, { status: 500 });
  }
}
