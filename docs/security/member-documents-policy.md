# Member document handling

Member document files are uploaded to Cloudinary with the `authenticated` delivery type and stored below an organization-specific path. The database keeps the provider account, asset ID, MIME type, member link, file size, uploader, and timestamp; it does not store a public delivery URL. Only users with `members.manage` can upload or download these files. Downloads pass through an authenticated endpoint, are limited to the same organization by RLS, and are recorded in `audit_logs`.

The API enforces the organization’s enabled document type, allowed MIME type, configured size ceiling, and basic PDF/JPEG/PNG file signatures. The server accepts a maximum of 10 MiB per member document. Private storage prevents unauthenticated direct delivery, and the proxy returns `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

## Retention and security operations

- Collect only documents required for a stated SACCO purpose and explain that purpose to the member before collection.
- Each SACCO should set a retention schedule that accounts for applicable financial-record, dispute, and legal-hold requirements. Delete or irreversibly anonymize documents when the schedule ends; retain an audit record of the deletion without retaining the document itself.
- Keep Cloudinary credentials server-side, restrict access to the provider account, monitor access logs, and review the `members.manage` role assignment regularly.
- Current implementation does not run antivirus scanning, automated retention deletion, or a data-residency check. Before production use, add quarantine and malware scanning, define deletion schedules per document type, and verify the storage region and cross-border processing terms with the provider.
- Existing files previously uploaded through the generic media/documents endpoints are not converted by this migration. Inventory and move any member identity files from those public URLs before relying on this private flow; new uploads labeled as member identity documents are rejected by the generic endpoints.
- The organization acts as controller for the SACCO records and must assess its obligations under Uganda’s Data Protection and Privacy Act, 2019, including data minimality (s.14), retention (s.18), processing outside Uganda (s.19), and security safeguards (ss.20–21). The Act requires retention only as long as needed or otherwise authorized and appropriate technical and organizational protection. [Official Act text](https://ict.go.ug/site/documents/Data-Protection-and-Privacy-Act-2019.pdf).
