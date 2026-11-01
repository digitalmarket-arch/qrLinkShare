# qrLinkShare

**Send links, photos, PDFs, documents and notes between your phone and computer, in real time, in both directions.** No app, no cable, no emailing yourself.

## How it works

1. Open the site on your computer. It shows a **QR code** and a **6-digit PIN**.
2. On your phone, scan the QR code with the normal camera app, **or** open the site and type the PIN.
3. Both devices are now in the same private "room". Anything you send from one appears on the other instantly.

Other ways to connect:

| Method | How | Best for |
| --- | --- | --- |
| **QR code** | Scan the code on the other screen | Phone ↔ computer, fastest |
| **6-digit PIN** | Type the PIN shown on the other screen | No camera, or the computer is far away |
| **Scan in-app** | "Scan" tab uses this device's camera | Computer with webcam scanning a phone's code |
| **Google** | Sign in with the same Google account on both devices | Your own devices, no codes every time |
| **Web3 wallet** | Connect the same wallet (MetaMask, Coinbase, Trust, Rabby…) on both | Crypto users; no email needed |

Signing in with Google or a wallet puts every device on that account in one shared room automatically.

## Features

- Real-time sync over WebSockets, so items appear in under a second
- Any file type up to 25 MB, with upload progress. Drag-and-drop, or paste screenshots with Ctrl/Cmd+V
- Links are detected automatically and can **auto-open** on the computer
- Every item has its own QR code, so a phone that isn't paired can still grab it
- Image thumbnails, PDF preview, copy and share buttons, delete for everyone
- Light and dark mode, works on phones, tablets and desktops
- Items **auto-delete after 24 hours**

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev          # opens on http://localhost:3000
```

To test with your phone, both devices must be on the same Wi-Fi. Open `http://<your-computer's-IP>:3000` on the computer (not `localhost`) so the QR code contains an address your phone can reach. Note: the in-app camera scanner and copy buttons need **https**, but the phone's normal camera app works fine over plain http.

Other commands:

```bash
npm run lint         # type-check
npm test             # unit tests
npm run build && npm start          # production mode
BASE=http://localhost:3000 npm run check:api   # API & security checks against a running server
```

## Deploy (put it on the internet)

The site has two parts:

- **The page** (what people see) lives on **GitHub Pages**: `https://digitalmarket-arch.github.io/qrLinkShare/`
- **The live server** (what passes files between devices in real time) lives on **Render**, free plan. GitHub Pages can only host static pages, so it can't do this part.

### One-time setup (about 15 minutes)

**Step 1: Start the server on Render**
1. Go to [render.com](https://render.com) and sign up with your GitHub account.
2. Click **New → Blueprint**, pick **digitalmarket-arch/qrLinkShare**, then **Apply**. `render.yaml` already has every setting (Singapore region, closest to India; a random secret; permission for the GitHub Pages address).
3. Wait 3-5 minutes until it says **Live**. Its address should be `https://qrlinkshare-digitalmarket.onrender.com`. That's the address the GitHub Pages site already uses.

**Step 2: The page on GitHub Pages**
It publishes automatically on every push to `main` (Actions tab → "Deploy qrLinkShare to GitHub Pages"), at `https://digitalmarket-arch.github.io/qrLinkShare/`. GitHub Pages must use **Settings → Pages → Source: GitHub Actions**.

If Render gave your server a different address, set the repository variable `VITE_SERVER_URL` to it (Settings → Secrets and variables → Actions → Variables), then re-run the workflow.

**Step 3: Allow Google sign-in on the new address.** See "Google sign-in setup" below. Add `digitalmarket-arch.github.io`.

### Free plan caveats
- The server sleeps after 15 minutes without visitors. The next visitor sees "Waking up the server…" for up to a minute. Because files are kept in memory, a sleep or restart also clears shared items.
- It has 512 MB of RAM, so `render.yaml` caps stored items at 150 MB in total (`MAX_STORE_MB`) and 60 MB per person (`MAX_USER_MB`). When the server is full, new uploads are politely refused until old items expire.
- A paid Render plan (about $7/month) removes both limits. You can then raise `MAX_STORE_MB`.

The Render address also works on its own as a complete copy of the site. Any Node host that supports WebSockets works the same way (Railway, Fly.io, a VPS). On those hosts, also set `PUBLIC_ORIGIN` to your site's address, otherwise wallet sign-in is switched off for safety. If you use a different GitHub Pages address (another account or a custom domain), add it to `ALLOWED_ORIGINS` on the server, e.g. `*,https://yourname.github.io`.

### Google sign-in setup

Google login uses Firebase Authentication (project settings in `firebase-applet-config.json`). In the [Firebase console](https://console.firebase.google.com):

1. **Authentication → Sign-in method** → enable **Google**.
2. **Authentication → Settings → Authorized domains** → add `digitalmarket-arch.github.io` and your Render domain (`qrlinkshare-digitalmarket.onrender.com`).

To use your own Firebase project, replace the values in `firebase-applet-config.json`. The Firebase web config is meant to be public. The server checks every Google token itself.

### Wallet sign-in

There's nothing to set up. It uses the standard browser wallet API (EIP-1193 / EIP-6963) and "Sign-In with Ethereum" (EIP-4361) messages. Signing is free (no gas) and gives the site no access to funds. On phones without a wallet extension, the app offers links that open the site inside MetaMask, Coinbase Wallet or Trust Wallet.

## Environment variables

See `.env.example`. The important ones:

- **`SERVER_SECRET`**: without it, a random secret is used and every device has to pair again after a restart.
- **`PUBLIC_ORIGIN`**: your site's address, e.g. `https://share.example.com`. Wallet sign-in messages only ever name this address. It's **required for wallet sign-in** on a VPS, Railway, Fly or behind nginx. It's not needed on Render (detected automatically) or when testing on localhost / your home Wi-Fi.
- **`MAX_STORE_MB`** / **`MAX_ROOM_MB`** / **`MAX_USER_MB`** / **`UPLOAD_MB_PER_HOUR`**: memory limits for shared items. Note that "per user" is really "per IP address". On mobile data in India, many people can share one IP (carrier-grade NAT), so don't set `MAX_USER_MB` too low.

## Privacy & security, in plain words

- Each room is private. A device can only join with a fresh one-time QR/PIN (valid 3 minutes), or by signing in to the same account. PIN guessing is rate-limited.
- Wallet sign-in messages always name this website, and the server only accepts the exact message it issued. A different website can't reuse them to get into your wallet's room.
- Files and notes are stored **on the server, in memory, for 24 hours** and are then deleted. They are encrypted in transit (https) but **not end-to-end encrypted**: whoever runs the server could technically read them. Don't use it for passwords or highly sensitive documents.
- File download links contain a long random key. Anyone who has the link (or scans an item's QR code) can download that file until it expires.
- Uploaded files can never run code on the site: risky types (HTML, SVG…) are always downloaded, never displayed.

## Project layout

```
server.ts            Express API + WebSocket hub + serves the app
server/
  tokens.ts          signed room-access tokens, random ids & PINs
  auth.ts            Google token + wallet signature verification
  store.ts           in-memory rooms, items, files, pairing codes (auto-expiry)
src/
  App.tsx            app shell & all user actions
  hooks/useRoom.ts   live WebSocket connection to the room
  hooks/usePairing.ts  auto-refreshing QR/PIN
  components/        UI (ConnectPanel, Composer, Feed, ItemCard, …)
  lib/api.ts         talks to the server
  lib/wallet.ts      Web3 wallet sign-in
  lib/firebase.ts    Google sign-in
  lib/shared.ts      helpers shared by server and browser (+ tests)
scripts/api-check.ts end-to-end API & security checks
```
