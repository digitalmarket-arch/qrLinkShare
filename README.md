# qrLinkShare — Instant Phone-to-Desktop QR File, Link, Image & Doc Sharing

**qrLinkShare** is a real-time and static-ready phone-to-desktop sharing studio. Scan a room QR code or an individual item QR code to beam links, photos, documents (PDF, Markdown, CSV), files, and clipboard notes across devices.

## Features

- **Phone-to-Desktop QR Bridge**: Generates scannable SVG/PNG QR codes for any transfer room (e.g. `SYNC-42`) with configurable Reed-Solomon error correction (`L`, `M`, `Q`, `H`).
- **Instant Beam Composer**: Drag-and-drop or browse local photos, PDFs, documents, archives, links, or text snippets.
- **Dual-Runtime Architecture (Full-Stack Server + Static GitHub Pages Mode)**:
  - **Node.js / WebSocket Mode**: Uses Express + `/ws` WebSockets on port 3000 for live multi-device room synchronization.
  - **GitHub Pages Static Mode**: Automatically persists items in `localStorage`, syncs across tabs via `BroadcastChannel`, serves file/image/doc downloads directly via client-side `Blob` / `dataUrl` streams, and supports serverless `#share=<base64url>` QR payload beaming.
- **Multi-QR Printable Sheet**: Print or export a grid of QR codes for all items in a room.

## Publishing to GitHub Pages

This repository is pre-configured for **GitHub Pages** using relative asset paths (`base: './'` in `vite.config.ts`), `.nojekyll`, SPA `404.html` fallback, and an automated GitHub Actions workflow (`.github/workflows/deploy.yml`).

### Option 1: Automatic GitHub Actions Deployment (Recommended)
1. Push or export this project to your GitHub repository (`qrLinkShare` on the `main` branch).
2. In your GitHub repository, open **Settings → Pages**.
3. Under **Build and deployment → Source**, select **GitHub Actions**.
4. The workflow in `.github/workflows/deploy.yml` will automatically build `./dist` and publish your site to:
   `https://<your-github-username>.github.io/qrLinkShare/`

### Option 2: Manual CLI Deployment
```bash
npm install
npm run build
npx gh-pages -d dist
```

## Local Development

```bash
npm install
npm run dev
```