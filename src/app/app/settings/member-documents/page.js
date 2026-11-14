'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Save, Plus } from 'lucide-react';
import Link from 'next/link';
import { fetchWithAuth } from '@/lib/fetch-client';
import { useToast } from '@/components/ui/Toast';

const TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export default function MemberDocumentsSettingsPage() {
  const toast = useToast();
  const [documents, setDocuments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newDocument, setNewDocument] = useState({ document_key: '', label: '', is_enabled: true, is_required: false,
    accepted_mime_types: ['application/pdf', 'image/jpeg', 'image/png'], max_size_bytes: 10485760, sort_order: 100 });

  const load = async () => {
    try {
      const result = await (await fetchWithAuth('/api/member-document-configs')).json();
      if (result.success) setDocuments(result.data || []);
      else toast.error(result.error || 'Could not load document settings');
    } catch { toast.error('Could not load document settings'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const update = (key, values) => setDocuments((current) => current.map((item) => item.document_key === key ? { ...item, ...values } : item));
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetchWithAuth('/api/member-document-configs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [...documents.map(({ document_key, label, is_enabled, is_required, accepted_mime_types, max_size_bytes, sort_order }) => ({ document_key, label, is_enabled, is_required, accepted_mime_types, max_size_bytes, sort_order })), ...(newDocument.label.trim() ? [newDocument] : [])] }),
      });
      const result = await response.json();
      if (result.success) { setDocuments(result.data || []); setNewDocument({ document_key: '', label: '', is_enabled: true, is_required: false,
        accepted_mime_types: ['application/pdf', 'image/jpeg', 'image/png'], max_size_bytes: 10485760, sort_order: 100 }); toast.success('Document settings saved'); }
      else toast.error(result.error || 'Save failed');
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  return <div className="p-6 max-w-4xl mx-auto space-y-6">
    <Link href="/app/settings" className="flex items-center gap-1.5 text-sm text-muted-foreground"><ArrowLeft className="w-4 h-4" /> Settings</Link>
    <div className="flex justify-between items-start">
      <div><h1 className="text-2xl font-bold">Member Document Collection</h1><p className="text-sm text-muted-foreground mt-1">Choose required documents and accepted formats for this organization.</p></div>
      <button onClick={save} disabled={saving || loading} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"><Save className="w-4 h-4" />{saving ? 'Saving…' : 'Save changes'}</button>
    </div>
    {loading ? <p>Loading…</p> : <div className="bg-card border border-border rounded-xl divide-y divide-border">
      {documents.map((document) => <section key={document.document_key} className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><p className="font-medium">{document.label}</p><p className="text-xs text-muted-foreground font-mono">{document.document_key}</p></div>
          <div className="flex gap-5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={document.is_enabled} onChange={(event) => update(document.document_key, { is_enabled: event.target.checked, is_required: event.target.checked ? document.is_required : false })} /> Enabled</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={document.is_required} disabled={!document.is_enabled} onChange={(event) => update(document.document_key, { is_required: event.target.checked })} /> Required</label>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <fieldset className="space-y-2"><legend className="text-xs text-muted-foreground mb-1">Accepted file types</legend>
            <div className="flex gap-4">{TYPES.map((type) => <label key={type} className="text-xs flex gap-1.5 items-center"><input type="checkbox" checked={document.accepted_mime_types.includes(type)} onChange={(event) => update(document.document_key, { accepted_mime_types: event.target.checked ? [...document.accepted_mime_types, type] : document.accepted_mime_types.filter((value) => value !== type) })} />{type.replace('application/', '').replace('image/', '').toUpperCase()}</label>)}</div>
          </fieldset>
          <label className="text-xs text-muted-foreground">Maximum size (MB)
            <input type="number" min="1" max="10" value={Math.ceil(Number(document.max_size_bytes) / 1048576)} onChange={(event) => update(document.document_key, { max_size_bytes: Number(event.target.value) * 1048576 })} className="block w-full mt-1 px-3 py-2 border border-border rounded-lg bg-background text-foreground text-sm" />
          </label>
        </div>
      </section>)}
      <section className="p-5 space-y-3">
        <h2 className="font-medium">Add a document type</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <input value={newDocument.label} onChange={(event) => setNewDocument((prev) => ({ ...prev, label: event.target.value, document_key: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') }))} placeholder="Document label" className="px-3 py-2 border border-border rounded-lg bg-background text-sm" />
          <div className="text-xs text-muted-foreground self-center">Key: {newDocument.document_key || 'generated from label'}</div>
          <button onClick={save} disabled={saving || !newDocument.label.trim()} className="flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"><Plus className="w-4 h-4" /> Add & save</button>
        </div>
      </section>
    </div>}
  </div>;
}
