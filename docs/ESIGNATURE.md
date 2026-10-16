# E-signatures

## What counts as a signature here

A document is **SIGNED** only when an e-signature provider says so. The app learns this in one of two ways:
- A webhook whose HMAC verifies against the org's secret.
- A status poll (`POST /signature-requests/:id/refresh`).

There is no API, button or approval step that lets a user mark a request or a document signed.

The following are **not** electronic signatures, and the system never treats them as signatures:
- an approval checkbox or an "Approved" status
- an uploaded image of a handwritten signature
- typing a name into a field
- a document whose upload happened to be a scan of a signed paper

Legal validity comes from the provider's process. Depending on the jurisdiction and the type of signature, that process includes:
- signer authentication: email, OTP or Aadhaar eSign
- intent and consent capture
- tamper sealing of the PDF
- an audit trail or certificate

In India, for example, the IT Act 2000 (s.3A and the Second Schedule) recognizes Aadhaar eSign and DSC-based signatures. Some documents can't be signed electronically at all, such as negotiable instruments other than cheques, wills and property sale deeds. Choose a provider and signature type that fit the documents you sign, and get legal advice for your use case. This software stores the provider's evidence but does not itself confer validity.

## What is stored

| Where | What |
|---|---|
| `SignatureRequest.status` | DRAFT → SENT → VIEWED → SIGNED / DECLINED / EXPIRED / VOIDED / FAILED. Only the provider moves a request past SENT. Replayed and out-of-order events are ignored. |
| `SignatureRequest.evidence` | Whatever the provider returns as proof, such as a certificate id, an audit-trail reference or signer IPs. |
| `SignatureRequest.signedDocumentId` | The provider's signed PDF, stored as the next version of the document with its own SHA-256 checksum. |
| `SignatureRequest.simulated` | `true` for the mock provider. The API adds `notice: "Simulated – not a legal signature"`, and the UI shows the same label. |
| `Document.signatureStatus` | NONE / PENDING / SIGNED / DECLINED / EXPIRED / VOIDED, set on the version that was sent. |
| `WebhookEvent` | Every verified delivery, unique on (provider, event id). A redelivery is acknowledged without reprocessing. |
| Audit log | `signature_request.created / sent / voided / viewed / signed / …` and `document.version_added` |

Two deletion rules protect signed documents:
- A document with a SIGNED request cannot be deleted.
- A document with an open (SENT or VIEWED) request must have that request voided first.

## The mock provider (development and tests only)

The mock is enabled per organization by an `Integration` row with these values:
- `provider = "esign_mock"`
- `status = CONNECTED`
- `secrets = encrypt(JSON.stringify({ webhookSecret }))`

`encrypt` comes from `src/lib/crypto/encryption.ts`.

The mock sends no email to anyone. Its `createEnvelope` returns a `mock_…` id, and polling it never changes the status. To complete a request, post a signed webhook yourself:

```bash
BODY='{"eventId":"evt-1","requestId":"mock_…","status":"SIGNED","evidence":{"note":"test"}}'
TS=$(node -e 'console.log(Date.now())')
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/.* //')
curl -X POST "$APP_URL/api/webhooks/esign/esign_mock" \
  -H "content-type: application/json" -H "x-esign-timestamp: $TS" -H "x-esign-signature: sha256=$SIG" \
  -d "$BODY"
```

Every mock completion is stored with `simulated = true` and labelled "Simulated – not a legal signature".

With no enabled provider, signature endpoints return `409 NOT_CONFIGURED`.

## Plugging in a real provider

Examples of real providers: Leegality, Digio, DocuSign, Adobe Sign, Zoho Sign. To add one:

1. **Implement `ESignProvider`** in `src/features/documents/esign.ts`, or in a file next to it:
   - `key`: the `Integration.provider` value, e.g. `"esign_leegality"`.
   - `simulated: false`
   - `createEnvelope({ requestId, document: { fileName, mimeType, checksum, getBytes }, signers }, secrets)`: upload the PDF (`await document.getBytes()`) and return `{ providerRequestId }`. Pass `requestId` as your reference.
   - `getStatus(providerRequestId, secrets)`: map the provider's states onto SENT / VIEWED / SIGNED / DECLINED / EXPIRED / VOIDED / FAILED, and include `evidence`.
   - `voidEnvelope(providerRequestId, secrets)`: cancel at the provider.
   - `verifyWebhook(rawBody, headers, secret)`: verify the provider's own signature scheme over the **raw** body. Compare in constant time and check the timestamp skew. `verifyHmacWebhook` is a ready implementation for the generic `x-esign-*` headers.
   - `parseWebhook(body)`: validate the body with zod. Return `{ eventId, providerRequestId, status, evidence }`. `eventId` must be the provider's unique delivery or event id, because it is the dedupe key.
   - `downloadSigned(providerRequestId, secrets)`: return the sealed PDF bytes, or `null`.
2. **Register it** in `ESIGN_PROVIDERS`.
3. **Connect it** for an organization: an `Integration` row with `provider = key`, `status = CONNECTED` and the encrypted secrets JSON (`{ webhookSecret, apiKey, … }`). Secrets are never returned by the API. Errors are passed through `sanitizeError` before they are stored or logged.
4. **Point the provider's webhook** at `https://<app>/api/webhooks/esign/<key>`.

If a provider signs webhooks with a different mechanism, such as an RSA public key, `verifyWebhook` receives the integration's `webhookSecret`. Store whatever the check needs there.

## Known limits

- Reading a stored file for `createEnvelope` goes through a 60-second signed URL. `src/lib/storage/objects.ts` has no direct download helper.
- No scheduled job polls open requests. Webhooks drive updates, and `refresh` polls on demand.
- Each request covers one document.
