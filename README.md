# Swaapo

**Don't Buy. Don't Sell. Just Exchange.** India's first exchange marketplace from God's Own Country. A HPY initiative, made in Kochi.

This repository holds the member app, the public website, the backend API with its staff Control Center, and the playbooks.

## What's here

| Path | What it is |
|---|---|
| `social.html` | The member app. One self-contained HTML/CSS/JS file (`EDITION="app"`). Open it in a browser to run it. |
| `index.html` | The website. Generated from `social.html` with `EDITION="web"`, which adds the web-only pages (About, Advertise, Ads Manager). |
| `backend/` | Node.js API (`/api`) and the staff Control Center (`/admin`). See [`backend/README.md`](backend/README.md). |
| `assets/` | Brand files: `swaapo-logo.svg` (purple wordmark, light backgrounds), `swaapo-logo-white.svg` (dark backgrounds), `swaapo-mark.svg` (the mark on its own). |
| `Swap_Playbook_v4.pdf`, `Swap_Playbook_v5.pdf` | Website and app playbooks (written before the rename to Swaapo). |
| `stage1-plan.html` | The stage 1 plan. |

## Run it

**App and website:** open `social.html` or `index.html` in a browser. No build step and no server needed. The preview runs on example data kept in the browser; choose "Explore with the demo account" or sign up (codes are shown on screen in the preview).

**Backend and Control Center** (Node.js 22.5 or later):

```sh
cd backend
npm install
npm run seed    # optional: example members, posts and auctions
npm start       # API on http://localhost:8080/api, Control Center on http://localhost:8080/admin
npm test        # end-to-end tests
```

Environment variables, roles, the full API list and the launch checklist are in [`backend/README.md`](backend/README.md).

## Keeping the app and website in sync

Edit `social.html` only, then regenerate the website:

```sh
python3 - <<'EOF'
s = open('social.html').read()
open('index.html', 'w').write(
    s.replace('<title>Swaapo</title>', '<title>Swaapo Web</title>', 1)
     .replace('const EDITION="app";', 'const EDITION="web";', 1))
EOF
```

## Features

- **Swapping:** has/wants posts, swap offers, ask-for-it requests, Swipe to match, Discover pins and boards, reels.
- **Auctions:** live, sealed, price-drop, reserve, Buy Now and swap-or-bid formats with SwaapoSafe escrow. Seen from 18, bid on from 23.
- **Swaapo Exclusive:** one-of-one pieces from verified brands, with certificates and verified bidders.
- **Medical & Care:** swap used wheelchairs, walkers, hospital beds and other care items. They must be cleaned and disinfected; medicines and needles are blocked.
- **Swaapo Donate:** give clothes, care items, books and more for free, choose who gets them, and see what NGOs near you need.
- **Swaapo Gatherings:** find people to go to an event with and split the ticket.
- **Swaapo Offers:** brand offers near you (example data until partnerships are signed).
- **Accounts and trust:** mobile, Google and Apple sign-in; optional Aadhaar or other ID checks (trust 50); 1,000-coin welcome bonus; privacy controls; pages with admin roles; deactivate or delete.
- **Community:** events, groups, Women's Circle, draws and giveaways (always free to enter), Swaapo Coins, Swaapo Green (a tree per swap), creator studio, calls.

## Before launch

Real providers are needed for SMS codes (TRAI DLT), email, Google and Apple sign-in, ID checks (DigiLocker or a licensed e-KYC partner), payments and escrow (an RBI-authorised aggregator), and hosting. Brand offers, NGO partners and drop-off points shown in the app are examples until agreements are signed. Run a trademark search on the name "Swaapo". The full checklist is in [`backend/README.md`](backend/README.md).
