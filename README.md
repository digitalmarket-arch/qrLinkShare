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

Real-time sharing needs the Node server running somewhere. **GitHub Pages alone is not enough**, because it can only host static pages and cannot pass files between devices.

**Easiest: Render (free tier).** This repo has a `render.yaml`:

1. Go to [render.com](https://render.com) → **New → Blueprint** → pick this repository.
2. It builds and starts automatically, in the Singapore region (closest to India), with a random `SERVER_SECRET`.
3. Open the `.onrender.com` URL. Done.

Caveat: Render's free plan sleeps after 15 minutes without visitors, so the first visit takes about 30 seconds. Because files are kept in memory, a sleep or restart also clears shared items. A paid plan (about $7/month) avoids this. Any Node host that supports WebSockets works the same way (Railway, Fly.io, a VPS).

**Optional: frontend on GitHub Pages + server on Render.** Set the repository variable `VITE_SERVER_URL` (Settings → Secrets and variables → Actions → Variables) to your server URL, e.g. `https://qrlinkshare.onrender.com`. The included workflow then publishes the page on every push to `main`.

### Google sign-in setup

Google login uses Firebase Authentication (project settings in `firebase-applet-config.json`). In the [Firebase console](https://console.firebase.google.com):

1. **Authentication → Sign-in method** → enable **Google**.
2. **Authentication → Settings → Authorized domains** → add your live domain (e.g. `qrlinkshare.onrender.com`).

To use your own Firebase project, replace the values in `firebase-applet-config.json`. The Firebase web config is meant to be public. The server checks every Google token itself.

### Wallet sign-in

There's nothing to set up. It uses the standard browser wallet API (EIP-1193 / EIP-6963) and "Sign-In with Ethereum" (EIP-4361) messages. Signing is free (no gas) and gives the site no access to funds. On phones without a wallet extension, the app offers links that open the site inside MetaMask, Coinbase Wallet or Trust Wallet.

## Environment variables

See `.env.example`. The important one is **`SERVER_SECRET`**. Without it, a random secret is used and every device has to pair again after a restart.

## Privacy & security, in plain words

- Each room is private. A device can only join with a fresh one-time QR/PIN (valid 3 minutes), or by signing in to the same account. PIN guessing is rate-limited.
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
