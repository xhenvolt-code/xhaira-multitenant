# Receipt QR digital seals

Printed receipts include an embedded QR code that opens `/verify/receipt`. Its receipt number is signed with HMAC-SHA256; the verification endpoint validates the stamp and looks up the canonical issuer, date, transaction type, amount, and combined charges. The public result does not disclose member names or account details.

Configure a stable secret on every application instance:

```text
RECEIPT_QR_SECRET=<at least 32 random bytes, base64url encoded>
```

Generate a value with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Keep the secret stable; replacing it invalidates seals on already-issued receipts. `NEXTAUTH_SECRET` is accepted as a fallback for deployments that already configure it. Without either secret, receipt printing continues but the receipt shows that its verification seal is unavailable.
