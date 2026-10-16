# IntraCore

Multi-tenant CRM/ERP SaaS. Authentication is **Supabase Auth**. Application data is **Prisma + PostgreSQL**. Deploy on **Vercel**.

> `IntraCore-backend` is deprecated. All product code lives here.

## Architecture

- Next.js App Router — Server Components, Server Actions, Route Handlers
- Supabase Auth (`@supabase/ssr`) — cookie sessions
- Prisma User.id **equals** `auth.users.id` (UUID)
- Row-level tenancy via `organizationId`
- Permission-based RBAC (`lead.create`, never `role === "admin"`)
- `SUPABASE_SERVICE_ROLE_KEY` is **server-only** (`src/lib/supabase/admin.ts`). The browser client uses the **anon** key.

## Auth flow

Signup → Supabase `auth.users` → Prisma `User` (same UUID) → create Organization → Owner membership → dashboard.

Password reset and email confirmation go through `/auth/callback`.

## Setup

```bash
cp .env.example .env
# Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY (server only), DATABASE_URL, DIRECT_URL
npm install
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

In the Supabase dashboard, set redirect URLs:

- `http://localhost:3000/auth/callback`
- Production: `https://<your-domain>/auth/callback`

### Environment variables

| Variable | Client? | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Anon/public key for browser + cookie auth |
| `SUPABASE_SERVICE_ROLE_KEY` | **No** | Service role. Never import in `"use client"` files |
| `DATABASE_URL` | No | Pooled Postgres URL |
| `DIRECT_URL` | No | Direct/session URL for Prisma migrations |
| `NEXT_PUBLIC_SITE_URL` | Yes | App origin for invite/reset links |
| `ENCRYPTION_KEY` | No | Future integration credential encryption |
| `RESEND_API_KEY` | **No** | Resend API key for transactional email (optional) |
| `RESEND_FROM_EMAIL` | **No** | Verified From address, e.g. `IntraCore <onboarding@resend.dev>` |

Never commit `.env` (use `.env.example` as the template).

### Supabase Storage (call recordings)

Create a **private** Storage bucket named `lead-call-recordings` in the Supabase dashboard (or via SQL). Recordings are uploaded server-side with the service role and played back via short-lived signed URLs. Max file size: 25MB. Allowed MIME types: `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/webm`, `audio/x-m4a`.

### Transactional email (Resend)

When `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are set, the app sends:

- Member invitation emails
- Lead assignment notifications
- Follow-up created notifications
- Manual due reminders (2h, 24h, 48h, 72h) via Leads → E-mail
- Meeting logged alerts to the lead assignee

Without these vars, actions still succeed; invites show a copyable URL fallback.

## Deploy on Vercel

1. Import the repo and set the root directory to `IntraCore-Frontend` if needed.
2. In **Project Settings → Environment Variables**, add every variable from `.env.example` for **Production** (and Preview if you use it):

| Variable | Example (production) |
|----------|----------------------|
| `NEXT_PUBLIC_SITE_URL` | `https://intracore-ou3h.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `DATABASE_URL` | Supabase **pooler** Postgres URL |
| `DIRECT_URL` | Supabase **direct** Postgres URL |
| `ENCRYPTION_KEY` | Random 32+ char string |
| `RESEND_API_KEY` | Resend API key (optional) |
| `RESEND_FROM_EMAIL` | Verified sender address (optional) |
| `CRON_SECRET` | Random 32+ char string for `/api/v1/jobs/run` and `/api/health?db=1` |

3. In Supabase → **Authentication → URL Configuration**, add:
   - Site URL: your Vercel domain
   - Redirect URL: `https://<your-domain>/auth/callback`

4. Redeploy after saving env vars. If config is missing, the app shows `/setup` instead of a generic 500.

5. Run migrations as a **separate release step** against production Postgres (the build
   no longer migrates, so preview builds cannot change the production schema):
   ```bash
   npx prisma migrate deploy
   ```
6. Run `supabase/migrations/*.sql` in the Supabase SQL editor (private storage buckets).
7. Schedule background jobs: call `POST /api/v1/jobs/run` with
   `Authorization: Bearer $CRON_SECRET` (Vercel Cron, Supabase pg_cron + pg_net, or any
   scheduler). Daily is enough for quotation expiry and low-stock alerts; run it more often
   if you rely on task reminders.

Check deployment config: `GET /api/health` returns `{ missingEnv: [...] }` when something is not set.

## Lead Management

Org-scoped leads with configurable sources and pipelines (seeded on org create). Includes list/create/detail, notes, tasks, follow-ups, timeline, CSV import/export, duplicate warnings.

Permissions: `lead.create`, `lead.view`, `lead.edit`, `lead.delete`, `lead.assign`, `lead.import`, `lead.export`, `lead.convert`, `lead.change_stage`.

## Scripts

```bash
npm run dev
npm run build
npm test
npm run lint
```

## ERP modules

Companies & branches (multi-GSTIN), customers, contacts, opportunities, products, quotations,
sales orders, inventory (warehouses, stock ledger, reservations, batches/serials) and
purchasing (vendors, purchase orders, goods receipts, vendor bills). REST API under
`/api/v1` — see [docs/API.md](docs/API.md); stock rules in [docs/INVENTORY.md](docs/INVENTORY.md).

## Tests

Tests run against a throwaway local Postgres (never the database in `.env`):

```bash
brew install postgresql@17          # once
# start a cluster on port 54329 (see .env.test), then:
./scripts/reset-test-db.sh          # recreate test DBs and apply all migrations
npm test
```

`tests/setup.ts` refuses to run if `DATABASE_URL` is not on localhost.
