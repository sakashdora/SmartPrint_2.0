# Audit and hardening pass — 25 Nov 2026

Scope of this pass: a read-through of the server, connector, agent, payment and schema code; a baseline test run; fixes for the issues below that could be made **and verified locally**. Everything not listed under "Changed" was **not** changed. Status labels used throughout:

- **Verified** — reproduced or covered by an automated test in this repository.
- **Read only** — seen in the code, not exercised.
- **Not inspected** — needs access I do not have (see "Blocked").

Baseline before changes: 231 tests, 230 pass, 1 skipped, 0 fail (run with no database URL, so nothing touched Neon). After: **244 tests, 243 pass, 1 skipped, 0 fail**; `npm run build`, `npm run check` pass; `npm audit --omit=dev` reports 0 vulnerabilities.

## What exists today (read only)

Express 5 server (`server/`), SQLite for local tests and PostgreSQL (Neon, schema `smartprint`) in production, static front end (`public/`), Windows shop connector (`connector/`, SumatraPDF) for Business shops, and a separate institution agent (`agent/`, v3 protocol with a durable journal). Payments: cash and direct UPI (owner confirms), Razorpay online for shop orders in `single_merchant` mode, and per-institution Razorpay for wallet top-ups. Order states are enforced by guarded `UPDATE … WHERE status=…` statements and `server/state-machine.js`.

Configuration facts (values not recorded here): Razorpay keys in `.env` and `.env.production` are **test-mode** keys; `.env` and `.env.production` point at the **same Neon database host**, so `npm start` in development writes to the production database (the README already warns about this). No Azure configuration exists anywhere in the repository. Cloudflare appears only as a tunnel script and a static-assets `wrangler.jsonc`.

## Changed in this pass

| # | Problem (root cause) | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | **Rate limits could be bypassed.** `index.js` keyed every limit — including the 40-per-15-minute sign-in limit — on the `CF-Connecting-IP` header, which any client can send when it reaches the server without passing through Cloudflare. | High | `clientIp()` in `server/security.js` believes the header only from a loopback peer (a `cloudflared` tunnel on the same PC) or when `TRUST_CF_CONNECTING_IP=true`; invalid values are ignored. Logger uses it too. | `clientIp trusts CF-Connecting-IP…` |
| 2 | **Printers were reported "Ready" because the connector's heartbeat was alive.** Paper jam, no paper, open cover, Windows-offline etc. were never stored or shown, and the claim loop sent paid jobs to such printers. | High | New `server/printer-health.js`: classifies the Windows spooler status, stores `health/health_detail/health_checked/health_source` per printer (migration `0019`), shows state, detail and check time on the owner card, raises one notification per new fault, and the claim loop (server and connector) does not offer work to a printer with a fresh blocking fault. Unknown stays "unknown" and is labelled as unverified; it does not block, so older connectors keep working. A fault report that stops refreshing expires after 5 minutes instead of pinning the printer shut. | 9 tests in `test/printer-health.test.js` |
| 3 | **Customers could pay online for a job nobody could print.** | High | `POST /api/orders` (online) and `POST /api/orders/:id/payment` call `shopPrinterAvailability()` before any provider order exists: needs a connected, unpaused printer with no blocking fault that supports the job's colour/two-sided needs. Shops with no registered printer (manual printing) are unaffected. Cash and UPI are still offered. A Razorpay order that already exists is never cancelled, and a paid order is never un-paid. | `online payment is refused…`, `colour order…`, `no registered printer…`, `paid order is never un-paid…` |
| 4 | **Admin "printers online" counted any device that had ever sent a heartbeat**, including stale and revoked ones. | Medium | Online = heartbeat within 3 minutes on an active device. Added `ready`, `attention`, `verified` counts. `GET /api/admin/devices` returns the same evaluated health. | `admin counts online printers…` |
| 5 | **Admin "failed orders" included cancelled and expired orders**, inflating failures. Revenue showed gross only. | Medium | `failed` is only `failed`; new `printing`, `review`, `cancelled`, `expired`, `refunded`, `net`. | same test |
| 6 | `/api/health` returned an invented commit id (`0bf8e4f`). | Low | Real commit from the host's environment, otherwise `null`. | `/api/health does not invent…` |
| 7 | Customer shop page exposed only "printers connected (ever)". | Low | Adds `printersReady` (a count). No printer names, faults or toner detail reach customers. | `customers see how many printers are ready…` |

An existing test asserted `status_note === 'Ready'` after a bare heartbeat; it now asserts the new, honest wording. That is a deliberate behaviour change.

### Customer print options (second pass)

Shop customers (the order page) now get one-tap page choices and a four-up layout, and the on-screen price follows what is actually charged.

- **Pages to print:** All pages, First page, First 2 pages, Odd pages, Even pages, or type your own (`1-3, 5`). A live line says "Printing 6 of 12 pages." An impossible choice (pages 5-40 of 12, "even" on a one-page file) is explained at once and the order button stays disabled until it is fixed, instead of failing on the server.
- **Layouts:** Standard, 2 pages on 1, **4 pages on 1** (new, a 2 x 2 grid on A4, read left to right then down), ID Card. Pricing and imposition share one pages-per-sheet table (`PAGES_PER_SIDE` in `server/print-options.js`).
- **Server:** `range` accepts `all`, `odd`, `even` as well as lists; `layout` accepts `four`.
- **Bug fixed:** the instant price estimate used the whole document's page count and ignored the page range, so it disagreed with the final quote. It now counts only the chosen pages, using the same rules as the server (a test compares both across 500+ combinations). For office files, whose page count is only known after server conversion, the estimate stays on the whole document until the server quote returns.
- **Verified:** `test/page-selection-and-layouts.test.js` (5 tests). Also exercised by hand in the built-in browser against a local demo server (isolated SQLite, no Neon): a 12-page PDF, each choice, 4-up, a bad range, and a phone-width layout with no horizontal scrolling. Not verified: physical output of a four-up page on a real printer or the institution (education) print flow, which has its own options and was not changed.

### Adding printers: several at once, USB and Wi-Fi (third pass)

**What was wrong.** One shop connector held a single printer and a single device key, so connecting a second printer re-paired the same connector and the first printer's row went offline. The page could only list printers already installed in Windows, so a Wi-Fi printer that Windows had not set up could not be added at all.

**What changed.**
- **One connector, many printers.** `connector/worker.js` runs one worker per printer (own key, heartbeat and claim loop). `connector/config.js` stores them in `settings.json` as `Printers: [{ Name, Token }]`; an old single-printer file is read as one printer, and `Token`/`Printer` still mirror the first one, so nothing is lost and an older connector still starts. Disconnecting one printer leaves the others running.
- **A job prints on exactly its printer.** With more than one printer on the PC the connector uses strict matching (`selectPrintTarget`): the exact Windows name or a clear failure. The old behaviour (fall back to a similar printer, the Windows default or any printer) is kept for a single-printer PC, and is the reason a colour job could previously land on the wrong printer.
- **Page:** Printers has USB and Wi-Fi tabs, brand chips (HP, Brother, Epson, Canon, and others), a Connect button per printer, per-printer Disconnect, links to each maker's driver page, and an **Add by address** form for Wi-Fi/network printers. The form creates a standard TCP/IP port and a printer using a driver that is **already installed**; it never downloads or installs a driver. Only private network addresses (192.168.x, 10.x, 172.16-31.x) are accepted, values reach PowerShell through environment variables, and software drivers are refused. Windows normally needs administrator rights to create a port; when it refuses, the page shows the exact command to paste into an administrator PowerShell.
- **Brand and connection detection** covers the common HP, Brother, Epson and Canon port names (USB and network). `/api/owner/devices` now includes `manufacturer`.

**Verified.** `test/multi-printer.test.js` (14 tests): settings migration; brand and USB/network detection for the four makers; address and driver validation; the add command and its administrator fallback with an injected PowerShell; two printers on one PC against the real server (colour job to the colour printer, black-and-white job to the other, at the same time; a jammed printer takes nothing while its neighbour prints; print errors go to review; no job is printed twice); strict printer matching; the bridge routes and their refusal of other websites. Also run for real on this PC with a sandboxed connector (own settings folder, own port, own database; the live connector was not touched): the page read the real HP LaserJet 1020 and Brother DCP-T820DW, connected both through the page at the same time, each showed online with its own Windows-reported state, restarting kept them linked, and disconnecting one left the other online.

**Not verified.**
- **No page was printed** in these checks, so printing on two printers at once is verified with a stand-in print step, not on paper.
- **Epson and Canon hardware was not available.** Their detection is tested against typical Windows names and ports, not real devices.
- **Adding a printer by address was not run for real** (it would create a printer on this PC). The checks, the command and the page's handling of the administrator error are tested; the Windows step itself is not.
- The shop PC's existing connector keeps running the old code until it is restarted (the startup task restarts it at next sign-in); restart it to get multi-printer support.

### Things I checked and deliberately did not change

- **Status decoding.** On this PC `Get-Printer` returned `PrinterStatus: 128` for an offline Brother network (WSD) printer, i.e. the spooler's `0x80` offline flag, so the connector's existing bitmask decoding is correct. I built on it rather than switching to the PowerShell enum.
- **Razorpay verification.** Checkout signature (`order_id|payment_id`, constant-time compare), webhook signature over the raw body, event-id and payment-id de-duplication, and `WHERE payment='pending'` on collection are present and tested. Not replaced.

## Deploying this change (needs your decision)

Migration `0019_printer_health` adds four nullable columns to `devices`. The production runtime login is restricted, so in production the server **will refuse to start the new release until the migration has been applied** with the owner login (the previous release keeps serving). I have **not** run it. Run it deliberately, ideally against a Neon branch first:

```powershell
npm run migrate    # uses MIGRATION_DATABASE_URL; run BEFORE deploying this release
```

Shop PCs need the updated connector (`connector/index.js`) to start reporting printer status; until then their printers show "Connected · status unverified" and behave as before.

## Not done — and why

| Item | Why it is not done |
|---|---|
| **Physical printer test** | Not performed. This PC lists an HP LaserJet 1020 and a Brother DCP-T820DW (USB copy) with spooler status 0, and a Brother network (WSD) queue reported offline (128). I only read statuses; I printed nothing. A USB printer can show "normal" while unplugged, and ink/toner levels are exposed only by some drivers (no SNMP is used), so fault coverage on real hardware is **unverified**. |
| **Cloudflare configuration** | No account access. Not inspected: WAF, rate rules, TLS mode, origin protection, cache rules (never cache `/api/*`). Needs your approval and an API token with the scope you choose. |
| **Azure** | Nothing in the repo uses Azure; nothing to inspect. |
| **Razorpay live account, Route/split settlement, payouts, platform commission, fees** | Keys are test-mode; I did not call Razorpay. The app has no commission, platform-fee or payout ledger for shop orders: money would settle to the single company account (`PAYMENT_SETTLEMENT_MODE=single_merchant`). Per-shop settlement needs Razorpay Route (KYC, approval, fees) — confirm that product with Razorpay before building on it. |
| **Online refunds** | Shop-order refunds are manually recorded and do not move money (README). Only wallet top-ups call the Razorpay refund API. |
| **Webhook coverage** | Only `payment.captured` is handled; `payment.failed` and `refund.*` are ignored and there is no scheduled reconciliation against Razorpay. |
| **Order exception states** | `PRINTER_UNAVAILABLE`, `PAYMENT_FAILED`, `REFUND_PENDING`, `REFUNDED` do not exist in `state-machine.js`. A paid order whose printer is faulty simply waits as `queued` (now with an owner notification). Adding states touches many queries and the UI, so it needs its own change with a migration plan. |
| **In-memory server state** | `pendingKeys`, `shopScannedPrinters`, `alertedOrders`, `qrCache` live in process memory. Fine on one Node process; on serverless or multiple instances (Vercel) a Connect key or scan report can land on a different instance. Move to the database before scaling out. |
| **Secrets hygiene** | `.env`, `.env.production` and `.data/admin-access.txt` are git-ignored (not tracked) but sit on disk in plaintext. The README says the original Neon owner password was exposed in chat and must be rotated before public launch — I cannot confirm it was. |
| **Wider test areas** | Unit/integration/security tests were extended only where changed. Not run: load/performance, mobile-responsive checks of the changed card, PostgreSQL test pass (`SMARTPRINT_TEST_DATABASE_URL` is not set), real browser pass. |

## Next steps, in order

1. Review the diff and commit if you are happy (nothing is committed).
2. Apply migration `0019` to a Neon branch, then production, then deploy.
3. Update the connector on shop PCs and confirm on a real printer: unplug it, open the cover, and remove paper, and check the owner card and claim behaviour for each.
4. Decide the settlement model with Razorpay before any commission or payout work.
5. Give Cloudflare access (or the settings) if you want that reviewed.
