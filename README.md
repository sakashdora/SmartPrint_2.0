# SmartPrint

QR-based document printing platform for independent print shops and educational institutions — featuring live document previews, mobile-first uploads, shop/college workspaces, centralized Razorpay & cash payments, and real-time printer dispatch.

---

## Key Features

- **Customer QR Ordering:** Mobile-first upload for PDF, JPG, PNG, and office documents (up to 20 MiB / 100 pages), with live page-range selection, colour/grayscale, duplex, 2-up layout, and ID card front/back pairing.
- **Image Preparation:** Built-in crop, rotation, blank-border trimming, and contrast/sharpness enhancement.
- **Workspaces & Multi-Tenant Roles:** Dedicated portals for **Customers**, **Print Shop Owners**, **College/Institution Admins**, and **Platform Admins**.
- **Payments & Ledgers:** Centralized **Razorpay** (`single_merchant` mode with webhook reconciliation), counter cash/UPI confirmation, immutable transaction ledgers, and CSV exports.
- **Hardware Print Dispatch:** Persistent long-polling connector (`connector/` & `agent/`) for Windows/local printers with lease tracking, failure recovery, and automatic file deletion after confirmed output.
- **Security & Privacy:** Argon2id password hashing, TOTP/WebAuthn MFA, AES-256-GCM encrypted file storage, distributed rate limiting, origin validation, and automated retention sweeps.

---

## Tech Stack

- **Runtime:** Node.js 24 (`ESM`) + Express 5
- **Database:** PostgreSQL ([Neon](https://neon.tech)) in production, SQLite fallback for isolated local demos
- **Image & PDF:** `sharp`, `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`
- **Frontend:** Vanilla ES modules, PWA (`manifest.json` + service worker), responsive CSS design tokens

---

## Local Development

Requires **Node.js 24.x**:

```powershell
# 1. Install dependencies and build static assets
npm ci
npm run build

# 2. Configure environment
cp .env.example .env

# 3. Apply database migrations
npm run migrate

# 4. Provision an admin account
$env:ADMIN_PASSWORD="YourStrongPassword123!"
npm run admin:create

# 5. Start the development server
npm run dev
```

Open **http://localhost:3000**.

> **Isolated Local Demo:** Run `npm run demo` (without remote `DATABASE_URL`) to preview with sample SQLite accounts (`owner@smartprint.local` / `admin@smartprint.local`, password `SmartPrintDemo!2026`).

---

## Production Deployment (Render + Neon)

SmartPrint runs best on a persistent Node.js / Docker host such as **Render** (`render.yaml` & `Dockerfile` included) backed by **Neon PostgreSQL**:

1. **Database:** Provision a PostgreSQL database on [Neon](https://neon.tech) and run `npm run migrate`.
2. **Web Service:** Deploy the `main` branch on [Render](https://render.com) using the **Docker** runtime and Health Check Path `/api/health`.
3. **Required Environment Variables:**
   - `NODE_ENV=production`
   - `PORT=3000`
   - `DATABASE_URL` — Neon pooled PostgreSQL connection string
   - `FILE_ENCRYPTION_KEY` — 64-character hex secret *(keep unchanged across deployments)*
   - `CRON_SECRET` — 64-character hex secret for maintenance sweeps
4. **Centralized Razorpay (Optional):**
   - Set `PAYMENT_SETTLEMENT_MODE=single_merchant`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and `RAZORPAY_LIVE_ENABLED=true` (for live keys).
   - Point Razorpay Webhooks (`payment.captured`) to `https://<your-domain>/api/payments/webhook`.
5. **Keep-Alive:** Ping `/readyz` every 5–10 minutes (e.g., via a Cloudflare Worker Cron trigger `*/5 * * * *`) if hosting on a free tier that sleeps on inactivity.

---

## Connecting a Shop Printer

On the Windows PC connected to your printer:

```cmd
start-connector.bat
```

---

## Verification & Maintenance

```powershell
npm run check       # JavaScript syntax verification
npm test            # Full unit & integration test suite
npm run test:neon   # Live Neon transaction & schema integration check (auto-rolls back)
npm run env:check   # Verify environment variable presence
npm audit --omit=dev
```

> Schema migrations live in `server/migrations.js` and are tracked in `schema_migrations`. Always run `npm run migrate` before deploying a release that introduces new migrations.

---

## Documentation

- [Documentation Index](docs/README.md)
- [Product Requirements](docs/01-product-requirements.md)
- [Architecture & Data Model](docs/02-architecture-and-data.md)
- [Security & Privacy](docs/03-security-and-privacy.md)
- [Test & Release Plan](docs/06-test-and-release-plan.md)
- [Deployment & Shop Setup](docs/08-deployment-and-shop-setup.md)
- [Operations & Recovery](docs/09-operations-and-recovery.md)

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
