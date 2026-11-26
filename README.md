# qrLinkShare

**Send links, photos, PDFs, documents and notes between your phone and computer, directly from one device to the other.** No app to install, no cable, no emailing yourself, and **nothing you share is stored on any server**.

Live site: **https://digitalmarket-arch.github.io/qrLinkShare/**

## How it works

1. Open the site on your computer. It shows a **QR code** and a **6-digit PIN**.
2. On your phone, scan the QR code with the camera app, **or** open the site and type the PIN (the computer asks you to approve).
3. The two devices are now paired. Anything you send from one appears on the other, both ways.
4. Next time, just open the site on both. Paired devices find each other automatically.

**Adding more devices:** pair the new device with *any* of your devices (scan or type the code shown on either one). All of them end up in one group, and nobody is disconnected.

Other ways to connect:

| Method | How | Best for |
| --- | --- | --- |
| **QR code** | Scan the code on the other screen | Phone ↔ computer, fastest |
| **6-digit PIN** | Type the PIN shown on the other screen, then approve | No camera, or the screen is far away |
| **Scan in-app** | "Scan" tab uses this device's camera | Computer with a webcam scanning a phone |
| **Google** | Sign in with the same Google account on both devices | Your own devices, no codes |
| **Web3 wallet** | Connect the same wallet (MetaMask, Trust, Rabby, Coinbase Wallet…) on both | Crypto users, no email needed |

Codes change every 3 minutes and each one works once. A code that has expired is refused, even if the screen showing it was left open in the background.

## Two sections: Temporary and Saved

When you send something, choose:

- **Temporary**: for quick hand-offs. It is deleted **24 hours** after it was sent. (On a device where qrLinkShare is closed, that happens the next time it's opened there. On shared computers, use *Keep nothing on this computer*.)
- **Save**: for things you want to keep. It stays on your devices **until you delete it**.

You can move any temporary item to Saved with the bookmark button.

## Where is my data?

- **Only on your devices**, in the browser's own storage (IndexedDB). The site itself is a static page on GitHub Pages and stores nothing.
- Devices connect **directly** (WebRTC, encrypted end to end). Links, notes and files never pass through a server.
- To find each other, devices send a tiny **encrypted** "here I am" message through free public relays (the Nostr network, via the open-source [Trystero](https://github.com/dmotz/trystero) library). The relays can't read it, don't keep it, and never see what you share.
- To connect across different networks (say, phone on mobile data, computer on Wi-Fi), each device asks a public address service (Cloudflare's STUN server) for its own internet address. It sees the device's IP address, never what is sent.
- **Delivery receipts:** an item counts as delivered only when the other device confirms it has saved it. If a device drops off half-way, the item stays *Waiting to send* and goes out automatically when that device is back.
- **Android share menu:** when you share a link into the installed app, it stays on the phone; it is not sent to the website.
- **"Keep nothing on this computer"** (in *Your data*): for shared or office PCs. Nothing is saved, not even the pairing: closing, reopening or reloading the tab starts from scratch.
- **Backup / Restore** (in *Your data*): because there's no server copy, your Saved items exist only on your devices. Download a backup now and then. It's a standard `.tar` archive (most archive tools open it), and it isn't encrypted, so keep it safe.

### Good to know

- **Both devices must be online with the page open** to exchange things. If you send while the other device is away, the item waits on your device and is delivered when it comes back.
- **Same Wi-Fi works best.** Across different networks it usually works too, but some strict networks (some office firewalls and mobile data providers) block direct connections. If two devices see each other but nothing arrives, put them on the same Wi-Fi.
- **iPhone / iPad:** Safari deletes a website's data (Saved items and pairing) if you don't open it for 7 days. Add qrLinkShare to your Home Screen (Share → *Add to Home Screen*) **before** you start saving things, and always open it from there. The Home Screen app has its own storage: it starts empty and unpaired, and pairing it again does not copy old items. Already have Saved items in Safari? First tap *Your data → Backup* in Safari, then add the app to the Home Screen, open it, tap *Your data → Restore*, choose the backup file, and pair it again (use *Enter PIN* or the in-app *Scan* tab; scanning with the Camera app pairs Safari, not the Home Screen app).
- **Android:** install it (browser menu → *Install app*) and qrLinkShare appears in the **Share** menu of other apps, so you can share a link from any app straight to your computer.
- Max file size: **200 MB**. Works in current Chrome, Edge, Firefox and Safari (iPhone/iPad: iOS 15.4 or newer).

## Security, in plain words

- Each group of paired devices shares a long random secret. QR codes and PINs are **one-time invitations** valid for 3 minutes; the secret itself is handed over only inside the encrypted device-to-device connection.
- A PIN needs the other device to tap **Allow**, so a guessed PIN isn't enough. If the device that typed the PIN gives up, the question disappears by itself.
- **Unpair** tells your other devices, so they forget this one.
- **Wallet sign-in**: your wallet signs one fixed message (free, no transaction). Only your wallet can make that signature, and it's the same on all your devices, so they meet in a private room nobody else can find, even someone who knows your wallet address. (Use a regular wallet; smart-contract wallets aren't supported.)
- **Google sign-in** is the convenient option, with one trade-off to know about:
  - Your devices meet in a room based on your Google account's internal id, and each device checks the other's Google sign-in token (on the device, against Google's public keys).
  - A device that is already set up shows its token only to devices it knows, or to a device that has shown a valid token first. If two of your set-up devices have never met, one of them asks you once: *Is this your device?*
  - Like any Google sign-in, Firebase (Google's sign-in service used here) keeps a sign-in record: your account id, email, name and sign-in times. Nothing you share is stored there.
  - The trade-off: someone who can sign in to your Google account, or who controls the site's Firebase project, could join your devices' room. For the strongest privacy, pair with QR/PIN or use a wallet.
- Nothing you share is ever uploaded anywhere.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev        # serves on http://localhost:3000 (from a phone on the same Wi-Fi: http://<computer-IP>:3000)
npm test           # unit tests
npm run lint       # type-check
npm run build      # production files in dist/
```

## Deploy

Every push to `main` publishes the site to GitHub Pages automatically (`.github/workflows/deploy.yml`). There is no server to run.

**Google sign-in** needs one setting in the [Firebase console](https://console.firebase.google.com) (project in `firebase-applet-config.json`): **Authentication → Settings → Authorized domains → add `digitalmarket-arch.github.io`**, and make sure **Sign-in method → Google** is enabled.

Optional build settings (own relays, other STUN servers, a TURN server for very strict networks) are described in `.env.example`.

## Project layout

```
src/
  App.tsx              the screen: pairing, sending, sections, settings
  hooks/useP2P.ts      storage + delivery (per-device outbox with receipts, catch-up)
  hooks/usePairing.ts  rotating QR invitation + PIN
  lib/mesh.ts          peer-to-peer engine (rooms, hello/verification, receipts, group moves)
  lib/pairing.ts       secrets, invitations, room derivation
  lib/db.ts            on-device storage (IndexedDB, or memory in "keep nothing" mode)
  lib/verify.ts        Google sign-in check (on the device)
  lib/wallet.ts        wallet connection and private room key
  lib/backup.ts        backup / restore of Saved items (.tar)
  lib/shareTarget.ts   text shared in from other apps (Android)
  lib/linkify.ts       clickable links inside notes
  polyfills.ts         small stand-ins so older iPhones work
  components/          UI pieces (Composer, Feed, ItemCard, ConnectPanel, …)
sw/sw.js               offline service worker (the build adds the file list and version)
public/                icons, web-app manifest
```
