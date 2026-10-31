# qrLinkShare — QR-Code Desktop Login & Cross-Device Link/File Vault

**qrLinkShare** enables users to share links, documents, images, files, and notes from their phone to the web app, and then log in on any desktop browser by scanning a desktop login QR code (or using Google Sign-In or a 6-digit PIN) so their newest shared link opens immediately on the desktop alongside their full library of temporary drops and permanently saved items.

### User Review & Critical Decisions

> [!IMPORTANT]
> The following product decisions were confirmed during interactive clarification and govern the architecture of this update:

- **Confirmed Decision 1 — All 3 Desktop Login & Pairing Flows Supported**:
  1. **Scan Desktop Login QR with Phone**: Desktop displays a live authentication QR code (`?qrLogin=<sessionId>`); scanning it on a phone (or approving via the Mobile Authenticator view) immediately authenticates the desktop browser into the user's session.
  2. **Google Sign-In (`signInWithPopup`)**: Sign in with Google on both phone and desktop to sync the personal vault automatically via Firebase Authentication and Cloud Firestore.
  3. **6-Digit Pairing PIN Code**: Enter a 6-digit numeric PIN generated on the phone (or desktop) to link both browsers without requiring a camera.
- **Confirmed Decision 2 — Auto-Open Newest Link + Click-to-Open List**:
  - Upon logging into the desktop browser via QR scan (or when a new link arrives from the phone while an active desktop session is open), the app automatically triggers opening the newest unread link and highlights a one-click **Launch Newest Link** banner (ensuring iframe/popup-blocker resilience), while keeping all other shared links clickable in the stream.
- **Confirmed Decision 3 — Dual Retention Modes (Temporary Drop vs. Saved Vault)**:
  - Every shared link, document, image, or data snippet can be sent as either a **Temporary Link/Drop** (ephemeral handoff that can auto-clear after opening on desktop or expire after 24 hours) or a **Saved Link / Data / Doc** (permanently persisted in the user's cloud vault until explicitly deleted).

---

### 1. Overview & Core Concept

- **What It Does**: Bridges a user's smartphone and desktop browser with zero-friction authentication and instant payload handoff. A user saves or shares a link, file, photo, or document on their phone, walks up to any desktop computer, scans the desktop screen's Login QR code (or enters a 6-digit PIN / signs in with Google), and immediately accesses their shared items with the newest link automatically launched for desktop viewing.
- **Target Audience / Persona**: Engineers, researchers, designers, and everyday users moving between mobile browsing and desktop workstations who need to open mobile links, documents, and attachments on a larger screen without emailing themselves.
- **Key Value**: Eliminates typing long URLs on a desktop or logging into personal email on shared workstations—combining WhatsApp-Web-style QR login with two distinct storage tiers (**Temporary Drops** for quick handoffs and **Saved Vault** for permanent links, data, and documents).

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Desktop QR Login Gate & Multi-Auth Switcher**:
     - When opening the desktop site in an unauthenticated state (or clicking **Lock / Switch Session**), the user sees a dedicated **Desktop Login Gate** featuring three clean authentication methods:
       - **Scan QR to Log In**: A high-contrast dynamic QR code representing a unique login challenge session. When the user scans this QR code on their phone and taps **Approve Desktop Login**, the desktop screen transitions into the authenticated workspace automatically.
       - **Enter 6-Digit PIN**: A 6-digit tabular numeric code input (`tabular-nums`) that links the desktop to the phone session.
       - **Continue with Google**: One-click Firebase Google Sign-In (`signInWithPopup`) that loads the user's cloud-synced vault on both live servers and static GitHub Pages deployments.
  2. **Phone Sender & QR Scanner / Approver Experience**:
     - On a smartphone (or in the **Phone Companion** perspective), the user can:
       - Share a **Link / URL**, **Document / File / Photo**, or **Text / Data Snippet** and choose its retention mode: **Temporary Drop** (ephemeral) or **Saved Link / Data / Doc** (permanent vault).
       - Approve a Desktop QR Login session or generate a 6-digit PIN to authorize a desktop browser.
  3. **Auto-Open Newest Link on Desktop Login**:
     - The moment the desktop browser authenticates via QR scan or PIN (or receives a new link from the phone while **Auto-Open Incoming Links** is enabled), the newest unread link is marked as ready, triggers a new-tab open action, and surfaces a prominent **Newest Link Ready** launch bar at the top of the stream so it is never blocked by browser popup restrictions.
  4. **Segmented Retention Views (Temporary Drops vs. Saved Vault)**:
     - The desktop stream is organized into clear retention tabs: **All Shared**, **Temporary Links & Drops**, and **Saved Links / Data / Docs**, alongside category filters (`Links`, `Images`, `Docs`, `Files`, `Text`) and live search. Users can promote any temporary drop into the **Saved Vault** with a single click.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-craft SaaS utility studio with crisp 1px structural borders, zero static pill clutter, and high-contrast scannable QR surfaces.
  - *Color Palette & Mood*:
    - **60% Dominant Neutral Canvas**: Crisp cool alabaster (`#F8FAFC`) in Light Mode and deep obsidian slate (`#020617`) in Dark Mode.
    - **30% Structural Surfaces**: Pure white (`#FFFFFF`) / slate-900 (`#0F172A`) cards with `1px solid` hairline dividers (`border-slate-200 dark:border-slate-800`).
    - **10% Accent Budget**: Royal Indigo (`#4F46E5`) for primary CTAs and active states; Emerald (`#16A34A`) for authenticated session and auto-open confirmation states; Amber (`#D97706`) for ephemeral temporary drop indicators.
  - *Typography & Hierarchy*:
    - **Display / Headings**: `Plus Jakarta Sans` (SemiBold/Bold 600–700) with `text-wrap: balance`.
    - **Body & Controls**: `Public Sans` (Regular/Medium 400–500) for dense scannability.
    - **Data, PINs, Room Codes & Timestamps**: `JetBrains Mono` with `font-variant-numeric: tabular-nums` so 6-digit PINs, byte sizes, and countdowns align vertically.
  - *Component Styling & Layout*:
    - **Top Bar Contract**: Strict 1-row, 3-zone header (`qrLinkShare` wordmark — 4 single-line navigation links — 1 primary CTA button) separated by `gap-8`.
    - **Desktop Viewport Presence**: Full `1440px` (`max-w-7xl`) 12-column workspace split (`5 columns` for the Auth / QR Login / Instant Beam Composer panel; `7 columns` for the Auto-Open Newest Link banner + Temporary & Saved Vault Stream).
    - **Mobile Ergonomics**: Touch hitboxes $\ge 44 \times 44\text{px}$ (`min-h-[44px]`), zero horizontal overflow at `390px`, and aggregate sticky height strictly under 15%.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Unified 3-Way Authentication (QR Challenge + 6-Digit PIN + Google Auth)**
  - *Chosen Approach*: Combine a real-time QR Login Challenge & 6-Digit PIN handshake (stored in Cloud Firestore and mirrored over WebSockets/local state) with Firebase Google Sign-In (`signInWithPopup`).
  - *Why*: Scanning a QR code or typing a 6-digit PIN lets users log into a desktop browser without typing their Google password on a secondary computer, while Google Sign-In provides permanent cross-session cloud identity.
  - *Alternatives Considered*: Google Sign-In alone requires typing credentials on the desktop browser; QR room codes alone lacked an explicit "Desktop Login Gate + Auto-Open Newest Link on Login" workflow.
- **Decision 2: Popup-Resilient Auto-Open Newest Link Mechanism**
  - *Chosen Approach*: When desktop login completes (or a new link is beamed from the phone), the app invokes `window.open(url, '_blank', 'noopener,noreferrer')` when permitted by user gesture AND simultaneously pins a high-visibility **Newest Shared Link Auto-Launcher** card at the top of the desktop workspace with a single-click **Open in Desktop Browser** button and an **Auto-Open Toggle**.
  - *Why*: Modern desktop browsers and sandboxed iframes sometimes block programmatic `window.open` calls triggered by asynchronous network events. Pairing automatic launch with a prominent top launch bar guarantees 100% reliability in both standalone GitHub Pages tabs and preview iframes.
- **Decision 3: Dual Storage Tiers (Temporary Link vs. Saved Links/Data/Doc)**
  - *Chosen Approach*: Every item carries a `retentionMode: 'temporary' | 'saved'` attribute and `openedOnDesktop: boolean` flag. Users can filter by **Temporary Drops** or **Saved Vault**, promote a temporary item to **Saved** with one click, or set temporary links to clear automatically once opened on desktop.
  - *Why*: Directly fulfills the requirement to keep two distinct options—quick disposable link handoffs and a permanent repository for saved links, data snippets, and documents.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        qrLinkShare Top Navigation Bar                      │
│  [qrLinkShare]      [QR Login · Share · Saved Vault · GitHub Pages]  [CTA] │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │
         ┌─────────────────────────────┴─────────────────────────────┐
         ▼                                                           ▼
┌─────────────────────────────────────────┐ ┌────────────────────────────────┐
│   Auth & Phone-to-Desktop Bridge Panel  │ │   Desktop Vault & Link Stream  │
│  ┌───────────────────────────────────┐  │ │  ┌──────────────────────────┐  │
│  │ 3-Way Desktop Login & Pairing Hub │  │ │  │ Auto-Open Newest Link    │  │
│  │ • Scan Desktop Login QR           │  │ │  │ Banner & Auto-Open Toggle│  │
│  │ • 6-Digit Pairing PIN Input/Gen   │  │ │  └──────────────────────────┘  │
│  │ • Google Sign-In (Firebase Auth)  │  │ │  ┌──────────────────────────┐  │
│  └───────────────────────────────────┘  │ │  │ Retention Tier Switcher  │  │
│  ┌───────────────────────────────────┐  │ │  │ • All Items              │  │
│  │ Instant Beam Composer             │  │ │  │ • Temporary Links/Drops  │  │
│  │ • Retention: [Temporary] [Saved]  │  │ │  │ • Saved Links/Data/Docs  │  │
│  │ • Payload: Link | File/Doc | Text │  │ │  └──────────────────────────┘  │
│  └───────────────────────────────────┘  │ │  ┌──────────────────────────┐  │
└────────────────────┬────────────────────┘ │  │ Interactive Item Rows    │  │
                     │                      │  │ • Open on Desktop / Copy │  │
                     │                      │  │ • Promote Temp → Saved   │  │
                     │                      │  │ • Individual Item QR     │  │
                     ▼                      │  └──────────────────────────┘  │
┌─────────────────────────────────────────┐ └───────────────▲────────────────┘
│       Unified Sync & Storage Layer      │                 │
│  • Cloud Firestore (vaultItems,         │─────────────────┘
│    authSessions, pinCodes)              │
│  • Real-Time WebSocket + Local Fallback │
└─────────────────────────────────────────┘
```

- **Data Model & Firestore Security Architecture**:
  - **User Vault Items (`/vaults/{vaultId}/items/{itemId}`)**:
    - Stores `id`, `vaultId` (linked to authenticated user UID or paired 6-digit/QR session ID), `category` (`link | image | document | file | text`), `retentionMode` (`temporary | saved`), `title`, `content`, `fileName`, `mimeType`, `sizeBytes`, `openedOnDesktop` (`boolean`), `senderDevice` (`mobile | desktop`), `senderName`, `pinned`, and `createdAt`.
  - **QR Login & PIN Challenge Sessions (`/loginChallenges/{challengeId}`)**:
    - Stores `challengeId`, `pinCode` (6-digit string), `status` (`pending | approved`), `approvedVaultId`, `approvedByName`, and `createdAt` so when a phone scans the desktop's QR code (`?qrLogin=<challengeId>`) or submits the 6-digit PIN, the desktop listener (`onSnapshot` / WebSocket) immediately transitions `status` to `approved`, logs the desktop into `approvedVaultId`, and triggers the **Auto-Open Newest Link** handler.
  - **Hardened Firestore Rules**:
    - Enforces schema validation, string length bounds, ID format checks, and strict ownership/session verification on all reads and writes.

- **Interactive Component & State Mapping**:
  - **Desktop Login Gate (`DesktopLoginModal` / Gate Card)**: Displays the live QR Login code, 6-digit PIN generator/verifier, and Firebase Google Sign-In button, plus a one-click **"Simulate Phone QR Scan Login"** button so the QR login + auto-open link flow can also be tested immediately on a single device.
  - **Instant Beam Composer**: Adds a prominent **Retention Mode Selector** (`Temporary Link/Drop` vs. `Saved Link/Data/Doc`) alongside strict input validation.
  - **Auto-Open Controller & Stream**: Watches for login completion and newly added unread `link` items; opens the newest link when **Auto-Open** is enabled, marks it as opened (or auto-cleans if configured as one-time temporary), and provides one-click **Save to Vault** promotion for any temporary item.
