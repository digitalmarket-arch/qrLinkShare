# qrLinkShare

**Send links, photos, PDFs, documents and notes between your phone and computer, directly from one device to the other.** No app to install, no cable, no emailing yourself, and **nothing is stored on any server**.

Live site: **https://digitalmarket-arch.github.io/qrLinkShare/**

## How it works

1. Open the site on your computer. It shows a **QR code** and a **6-digit PIN**.
2. On your phone, scan the QR code with the camera app, **or** open the site and type the PIN (the computer asks you to approve).
3. The two devices are now paired. Anything you send from one appears on the other, both ways.
4. Next time, just open the site on both. Paired devices find each other automatically.

Other ways to connect:

| Method | How | Best for |
| --- | --- | --- |
| **QR code** | Scan the code on the other screen | Phone ↔ computer, fastest |
| **6-digit PIN** | Type the PIN shown on the other screen, then approve | No camera, or the screen is far away |
| **Scan in-app** | "Scan" tab uses this device's camera | Computer with a webcam scanning a phone |
| **Google** | Sign in with the same Google account on both devices | Your own devices, no codes |
| **Web3 wallet** | Connect the same wallet (MetaMask, Trust, Rabby, Coinbase Wallet…) on both | Crypto users, no email needed |

## Two sections: Temporary and Saved

When you send something, choose:

- **Temporary**: for quick hand-offs. It deletes itself on every device **24 hours** after it was sent.
- **Save**: for things you want to keep. It stays on your devices **until you delete it**.

You can move any temporary item to Saved with the bookmark button.

## Where is my data?

- **Only on your devices**, in the browser's own storage (IndexedDB). The site itself is a static page on GitHub Pages and stores nothing.
- Devices connect **directly** (WebRTC, encrypted end to end). Files never pass through a server.
- To find each other, devices send a tiny **encrypted** "here I am" message through free public relays (the Nostr network, via the open-source [Trystero](https://github.com/dmotz/trystero) library). The relays can't read it, don't keep it, and never see your links or files.
- **"Keep nothing on this computer"** (in *Your data*): for shared or office PCs. Nothing is saved; everything disappears when the tab closes.
- **Backup / Restore** (in *Your data*): because there's no server copy, your Saved items exist only on your devices. Download a backup file now and then. (It isn't encrypted, so keep it safe.)

### Good to know

- **Both devices must be online with the page open** to exchange things. If you send while the other device is away, the item waits on your device and is delivered automatically when it comes back.
- **Same Wi-Fi works best.** Across different networks it usually works too, but some strict networks (some office firewalls and mobile data providers) block direct connections. If two devices see each other but nothing arrives, put them on the same Wi-Fi.
- **iPhone:** Safari may clear website data after about 7 days of not visiting. For Saved items to last, tap **Share → Add to Home Screen** and use the app from there (or keep backups).
- **Android:** install it (browser menu → *Install app*) and qrLinkShare appears in the **Share** menu of other apps, so you can share a link from any app straight to your computer.
- Max file size: **200 MB**.

## Security, in plain words

- Each group of paired devices shares a long random secret. QR codes and PINs are **one-time invitations** valid for 3 minutes; the secret itself is handed over only inside the encrypted device-to-device connection.
- A PIN needs the other device to tap **Allow**, so a guessed PIN isn't enough.
- **Google sign-in** puts your devices in a room only your account can find; each device also checks the other's Google sign-in token.
- **Wallet sign-in**: your wallet signs one fixed message (free, no transaction). Only your wallet can make that signature, and it's the same on all your devices, so they meet in a private room nobody else can find, even someone who knows your wallet address. (Use a regular wallet; smart-contract wallets aren't supported.)
- Nothing you share is ever uploaded anywhere.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # opens http://localhost:5173
npm test           # unit tests
npm run lint       # type-check
npm run build      # production files in dist/
```

## Deploy

Every push to `main` publishes the site to GitHub Pages automatically (`.github/workflows/deploy.yml`). There is no server to run.

**Google sign-in** needs one setting in the [Firebase console](https://console.firebase.google.com) (project in `firebase-applet-config.json`): **Authentication → Settings → Authorized domains → add `digitalmarket-arch.github.io`**, and make sure **Sign-in method → Google** is enabled. Firebase is only used to recognise your account; no data is stored there.

Optional build settings (own relays, TURN server for very strict networks) are described in `.env.example`.

## Project layout

```
src/
  App.tsx              the screen: pairing, sending, sections, settings
  hooks/useP2P.ts      storage + peer-to-peer engine + delivery/catch-up
  hooks/usePairing.ts  rotating QR invitation + PIN
  lib/mesh.ts          peer-to-peer engine (rooms, hello/verification, items, files)
  lib/pairing.ts       secrets, invitations, room derivation
  lib/db.ts            on-device storage (IndexedDB, or memory in "keep nothing" mode)
  lib/verify.ts        Google sign-in check (on the device)
  lib/wallet.ts        wallet connection and private room key
  lib/backup.ts        backup / restore of Saved items
  components/          UI pieces (Composer, Feed, ItemCard, ConnectPanel, …)
public/                icons, web-app manifest, offline service worker
```
