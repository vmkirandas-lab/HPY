# Swap backend · API + Control Center

The server for Swap (a HPY initiative). It is one Node.js app that serves:

- **`/api`**: the REST API the app and website call.
- **`/admin`**: the **Control Center**, a staff console for running the platform.

Data lives in one SQLite file (Node's built-in `node:sqlite`), so there is no database server to install.

## Quick start

```bash
cd backend
npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-strong-one' npm run seed   # first admin + example data
TOKEN_SECRET=$(openssl rand -hex 32) npm start                                  # http://localhost:8080/admin
npm test                                                                         # 17 end-to-end tests
```

You need **Node 22.5 or newer**. Add `SEED_DEMO=0` to the seed command to create only the admin.

The example members sign in with their handle and the password `swap-demo-2026`. The moderator account is `mod.kochi`. Change the password with `DEMO_PASSWORD`, or skip the example data entirely in production.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `data/swap.db` | SQLite file (`:memory:` for tests) |
| `TOKEN_SECRET` | random | Signs login tokens. **Required in production**, otherwise every restart logs everyone out. |
| `TOKEN_TTL_SEC` | 7 days | Login lifetime |
| `CORS_ORIGINS` | none | Comma-separated origins allowed to call the API, e.g. your app's domain |
| `TRUST_PROXY` | off | Set to `1` behind a load balancer so rate limits see real IPs |
| `GOOGLE_CLIENT_ID` | none | Turns on "Continue with Google" (the server checks Google ID tokens against this client ID) |
| `APPLE_CLIENT_ID` | none | Turns on "Continue with Apple" (your Services ID) |
| `AUTH_RATE_MAX` | 20 | Login and sign-up attempts per IP per 10 minutes |

## The Control Center

There are two staff roles:

- **Moderators** handle trust and safety.
- **Admins** can also change money, roles and settings.

Every staff action is written to the audit log, along with automatic sales, draws and plan changes.

| Section | What staff can do |
|---|---|
| **Dashboard** | See what needs action: open reports, auctions to verify, ads to review, Circle requests, teens waiting for consent, flagged messages. See platform numbers: members, teens, Pro/Pro Plus, plan revenue, swaps, auction sales, coins, Circle, ads, events, calls. |
| **Users** | Search and filter members. Mark verified. Suspend or lift a suspension, with a reason. Confirm a teen's guardian consent. Approve or remove Women's Circle. *Admin:* change plan (never to a paid plan for teens), change role, set trust, add or remove coins with a reason. |
| **Reports** | Dismiss, warn (trust −10), remove the item, or suspend the owner. Also lists messages flagged for scam words (OTP, UPI, advance…). |
| **Auctions** | Verification queue: approve (the auction goes live and its timer starts) or reject with a reason. Cancel a live auction. *Admin:* track escrow (awaiting payment → paid → released / refunded / disputed). A refund adds a strike, and three strikes block bidding. |
| **Brands & bidders** | Verification queue for **Swap Exclusive** brand pages: check the GSTIN, trademark or authorisation, and website, then verify or reject with a reason. Suspending a brand cancels its live drops. Also approves **verified bidders** after their ID and PAN check. |
| **Studio & draws** | Pro Plus draws, giveaways, challenges, mystery boxes and videos. **Pick winners** uses a secure random draw and records the result in the audit log. Remove or restore posts. |
| **Ads** | Approve or reject campaigns, pause, resume or end them, and see spend, views and clicks. |
| **Content** | Remove or restore listings, events and groups. |
| **Coins & Circle** | Circle request queue, and the full coin ledger. |
| **Swap Green** | Compares what has been pledged (one tree per completed swap; meals and a clean-up drive every 10,000 swaps) with what has been delivered. *Admin:* record each delivered planting, meals or clean-up batch with the partner, place, date and a proof link. Only recorded batches count as delivered. |
| **Calls** | Call records: who, when, how long. No audio or video is stored. |
| **Settings** (admin) | Feature switches for sign-ups, auctions, studio, draws, calls, coins, Circle, ads, events and groups. Also: maintenance mode with a message, plan prices, sale fees, coin rules, age and other limits, ad CPMs, and categories. All changes apply immediately. |
| **Audit log** | Everything above, with who did it and when. |

## Rules the server enforces

Every gate in the app is enforced again on the server, so it can't be bypassed.

- **Accounts**
  - Sign-up needs a name, a username and a mobile number verified by a 6-digit code.
  - Email is optional.
  - Members also choose a password, or sign up with Google or Apple instead.
  - Login works by username, mobile or email plus password, a mobile code, Google, or Apple.
  - A Google or Apple account whose verified email matches an existing account is linked to it, not duplicated.
  - Codes expire after 10 minutes, lock after 5 wrong tries, and can be re-sent after 30 seconds.
  - Outside production the code is returned as `devCode`; in production, send it with a DLT-registered SMS provider.
- **Trust and welcome bonus**
  - Starting trust is mobile 20 + email 10 + ID 20 = 50 (`settings.trust`). Swaps and ratings add more later, and money never buys trust.
  - ID can be Aadhaar (through DigiLocker or UIDAI offline e-KYC), a passport, a driving licence or a voter ID. All earn the same points, because Aadhaar must stay optional for a private service.
  - Swap stores only the method, the last 4 digits and a keyed hash of the provider's reference, so one ID can't verify two accounts. A full 12-digit Aadhaar number is rejected.
  - The name and date of birth on the ID must match the account.
  - In production, `POST /api/me/id/verify` needs a KYC provider (`KYC_PROVIDER`); outside production it accepts the result so the flow can be tested.
  - Completing all 9 profile items (name, username, mobile, email, ID, date of birth, area, bio, photo) pays a one-time welcome bonus of 1,000 Swap Coins (`coins.welcomeBonus`).
- **Deactivate and delete** (DPDP Act 2023)
  - Deactivating hides the profile and listings until the next login.
  - Deleting starts a 30-day grace period (`limits.deleteGraceDays`); logging in during it cancels the deletion.
  - When the grace period ends, the account is anonymised: name, contact details, sign-in links, listings, messages and coins are removed. Auction and tax records stay without a name.
  - Neither is allowed while the member has a live auction, an escrow payment or an agreed swap still open.
- **Age**
  - Auctions can be seen from 18 (`limits.adultAge`).
  - Bidding, buying and selling by auction, and verified-bidder checks, start at 23 (`limits.bidAge`).
  - Sign-up is 15+.
  - Members under 18 must give a parent's or guardian's contact.
  - Teens can't post, offer or chat until staff confirm guardian consent (DPDP Act 2023).
  - Auctions, paid plans, draws, the studio and calls are 18+.
  - Teens are never shown ads and can never be called.
- **Plans**
  - Bidding and selling need Pro, and Pro sellers get 3 auctions a month in 3 formats.
  - Pro Plus unlocks all 7 formats, auto-bid, the studio and calls.
  - Fees are 5% (Pro) or 3% (Pro Plus) when an item sells.
- **Auctions**
  - Only verified items, approved by staff, go live.
  - Bids must meet the minimum increment, and sellers can't bid on their own items.
  - Auto-bid works up to a hidden maximum.
  - A bid in the last 2 minutes adds 2 minutes.
  - Reserve amounts and sealed bids are never shown to buyers.
  - Price-drop and Buy Now purchases are handled.
  - Auctions close automatically.
- **Swap Coins**
  - The member who receives a ★★★★★ rating gets 100 coins.
  - If both members are in Women's Circle, they get +50.
  - Coins can be added to offers from 1,000.
  - Every coin movement goes through the ledger.
  - Coins can't be bought or cashed out.
- **Draws**
  - Always free to enter: any price, fee, coin or ticket field is rejected.
  - One entry per person.
  - Winners are picked by a secure random draw and logged.
  - Mystery boxes need a declared minimum value (₹200 or more) and are swapped, never sold.
- **Swap Exclusive**
  - Only a **verified brand** (GSTIN in the right format, trademark or authorisation, reviewed by staff) can list executive auctions. It doesn't need a member plan.
  - Each piece gets a "1 of 1" edition and a certificate number like `SWX-MAL-0001`.
  - Swap-or-bid isn't allowed; executive auctions are cash only.
  - Only members whose ID and PAN check is approved (`kyc_status = verified`) can bid or buy.
  - The brand fee comes from `settings.exclusive.feePct`.
- **Videos**: 2:00 maximum.
- **Swap Green**
  - Every completed swap pledges trees (`settings.impact.treesPerSwap`).
  - Every `milestoneSwaps` completed swaps pledges meals and a clean-up drive, and the milestone is written to the audit log.
  - "Planted" and "funded" figures come only from batches recorded with a proof link and a past date.
  - CO₂e and landfill figures are labelled as estimates.
- **Messages**: scam words are flagged for the sender and for moderators.

## API overview

Send `Authorization: Bearer <token>` with every request after logging in. Errors look like `{ "error": "Readable message", "code": "machine_code" }`.

| Area | Endpoints |
|---|---|
| Health & config | `GET /api/health` · `GET /api/config` (feature switches, prices, coin rules, categories) |
| Account | `POST /api/auth/otp/request` · `POST /api/auth/otp/verify` · `POST /api/auth/oauth/google\|apple` · `GET /api/auth/handle/:handle` · `POST /api/auth/signup` · `POST /api/auth/login` · `GET /api/me/account-status` · `POST /api/me/deactivate` · `POST /api/me/delete` · `GET/PATCH /api/me` · `GET /api/users/:handle` · `GET /api/plans` · `POST /api/me/plan` |
| Swaps | `GET /api/feed` · `POST /api/posts` · `GET/DELETE /api/posts/:id` · `POST /api/offers` · `GET /api/offers` · `POST /api/offers/:id/accept\|decline\|complete\|rate` |
| Coins & Circle | `GET /api/coins` · `POST /api/circle/apply` |
| Auctions | `GET /api/auctions` · `POST /api/auctions` · `GET /api/auctions/:id` · `POST /api/auctions/:id/bids` · `POST /api/auctions/:id/buy` |
| Studio | `GET /api/promos` · `POST /api/promos` · `POST /api/promos/:id/enter` · `POST /api/promos/:id/draw` |
| Community | `GET/POST /api/events` · `POST /api/events/:id/rsvp` · `GET/POST /api/groups` · `POST /api/groups/:id/join` · `GET /api/messages/:userId` · `POST /api/messages` · `POST /api/calls` · `POST /api/calls/:id/end` · `POST /api/reports` |
| Ads | `GET /api/ads/next?placement=feed\|story\|side\|auction` · `POST /api/ads/:id/click` · `GET/POST /api/campaigns` · `PATCH /api/campaigns/:id` |
| Profile & trust | `GET /api/me/profile` (checklist, trust, bonus) · `PATCH /api/me/profile` · `POST /api/me/email/request` · `POST /api/me/email/verify` · `POST /api/me/id/verify` |
| Swap Exclusive | `POST /api/brands` (apply) · `GET /api/brands` · `GET /api/brands/:slug` · `GET /api/me/brand` · `POST /api/me/kyc` · `POST /api/auctions` with `brandId` |
| Swap Green | `GET /api/impact` (public counters, milestone progress, recent batches) · `GET /api/me/impact` |
| Admin | `/api/admin/stats` · `users` · `reports` · `messages/flagged` · `posts` · `promos` · `events` · `groups` · `campaigns` · `auctions` (+ `verify`, `cancel`, `escrow`) · `brands` (+ `PATCH brands/:id`) · `impact` (+ `POST impact/batches`) · `ledger` · `calls` · `audit` · `settings` |

## Before going live

These parts are deliberately stubbed and need real providers:

1. **Payments**
   - Plans: `POST /api/me/plan` currently switches the plan straight away. Replace this with a payment gateway's webhook.
   - SwapSafe escrow must run through an RBI-authorised payment aggregator. Never hold buyers' money yourself.
2. **Calls**: the API records calls and enforces who may call whom. Audio and video need a WebRTC provider with TURN servers.
3. **Uploads**: the API stores media URLs. Add object storage with upload moderation, and re-check video length with `ffprobe` on the server.
4. **Verification**
   - Phone OTP at sign-up.
   - Verifiable guardian consent for 15–17-year-olds.
   - Selfie and ID check for Women's Circle (delete the ID image afterwards).
   - CEIR IMEI checks for auctioned phones.
5. **Scale**
   - SQLite suits one server. For several servers, move to PostgreSQL and a shared rate-limit store such as Redis.
   - Back up `data/swap.db` daily either way.
6. **Hosting**: put HTTPS in front of the server. Set `TOKEN_SECRET`, `CORS_ORIGINS` and `NODE_ENV=production`.

## Project layout

```
backend/
  src/server.js        start the server
  src/app.js           Express app, security headers, CORS, rate limit, maintenance mode
  src/db.js            schema, default settings, coin ledger, audit log
  src/auth.js          scrypt passwords, signed tokens, staff checks
  src/rules.js         age, plan and feature gates, auction maths
  src/routes/          account, market, auctions, studio, community, admin
  src/seed.js          first admin + example data
  admin/index.html     the Control Center
  test/api.test.js     end-to-end tests
```
