# Security Specification — qrLinkShare Firestore Rules

## 1. Data Invariants
1. **Identity Integrity (`VaultItem`)**: A `VaultItem` in `/vaultItems/{itemId}` can only be created, read, updated, or deleted by its authenticated `ownerUid` (`request.auth.uid == resource.data.ownerUid` and `request.auth.token.email_verified == true`).
2. **Strict Schema & Volumetric Bounds**: All string fields enforce explicit `minLength`/`maxLength` and regex patterns matching `firebase-blueprint.json`. No shadow/undeclared keys are permitted (`hasOnly`).
3. **Immutable Ownership & Creation Timestamps**: `id`, `ownerUid`, and `createdAt` (`request.time`) cannot be mutated after creation.
4. **Terminal State Locking (`LoginChallenge`)**: Once a `LoginChallenge` reaches `status == 'completed'`, no subsequent updates are allowed.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Shadow Field Injection**: `VaultItem` create with extra field `{"isAdmin": true}` -> Rejected by `hasOnly()`.
2. **Owner Spoofing**: `VaultItem` create where `ownerUid != request.auth.uid` -> Rejected by `data.ownerUid == request.auth.uid`.
3. **Unverified Email Spoof**: Authenticated user with `email_verified == false` attempting write -> Rejected by `isVerifiedUser()`.
4. **Oversized Content DoS**: `content` string > 50,000 chars -> Rejected by `data.content.size() <= 50000`.
5. **ID Poisoning**: Document ID `{itemId}` containing special characters or > 128 chars -> Rejected by `isValidId(itemId)`.
6. **Invalid Retention Enum**: `retentionMode: "forever"` -> Rejected by `data.retentionMode in ['temporary', 'saved']`.
7. **Invalid Category Enum**: `category: "executable"` -> Rejected by `data.category in ['link', 'image', 'document', 'file', 'text']`.
8. **Client Timestamp Forgery**: `createdAt` not equal to `request.time` -> Rejected by `incoming().createdAt == request.time`.
9. **Ownership Mutation on Update**: Updating `ownerUid` to another user -> Rejected by `incoming().ownerUid == existing().ownerUid` and `affectedKeys().hasOnly(...)`.
10. **Blanket List Scraping**: Listing `/vaultItems` without filtering by `resource.data.ownerUid == request.auth.uid` -> Rejected by `allow list` rule check.
11. **Terminal Challenge Re-opening**: Updating a `LoginChallenge` after `existing().status == 'completed'` -> Rejected by terminal state lock.
12. **Invalid PIN Format**: Creating a `LoginChallenge` with `pinCode: "12AB"` -> Rejected by `data.pinCode.matches('^[0-9]{6}$')`.
