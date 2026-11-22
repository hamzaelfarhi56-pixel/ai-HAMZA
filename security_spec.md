# KinoFrame Studio Firestore Security Specification

## 1. Data Invariants
1. **User Isolation & PII Protection**: Only the authenticated user whose `uid` matches `{userId}` and has `email_verified == true` may read, create, or update `/users/{userId}`. No user can list other user profiles or mint unbounded credits.
2. **Project Ownership**: Every `/projects/{projectId}` document must have `ownerId == request.auth.uid`, immutable after creation, with server-enforced `createdAt == request.time` and `updatedAt == request.time`.
3. **Master Gate Subcollections**: Characters, Media Assets, Storyboard Scenes, and Timeline Clips under `/projects/{projectId}/*` must verify parent project ownership via `get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId == request.auth.uid` on document reads and mutations, and enforce `resource.data.ownerId == request.auth.uid` on `list` queries without `get()`.
4. **Strict Field Allowlisting & Size Bounds**: Every string field enforces `.size()` limits, every ID matches `^[a-zA-Z0-9_\-]+$`, and arrays (`tags`, `characterIds`) are strictly bounded (`<= 6`) with first-element type validation.
5. **Terminal State Locking**: Once a `MediaAsset` reaches `'Completed'` or `'Failed'`, its `status` and `url` cannot be altered by client updates.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return `PERMISSION_DENIED`)
1. **Unauthenticated Project Read**: `GET /projects/proj_1` with `auth == null`.
2. **Cross-User PII Leak**: User B (`uid_b`) attempts `GET /users/uid_a` or `LIST /users`.
3. **Credit Minting Spoof**: User A creates `/users/uid_a` with `credits: 999999` instead of `250`.
4. **Shadow Field Injection**: User A creates `/projects/proj_1` with extra ghost field `isAdmin: true`.
5. **Identity Spoofing**: User B creates `/projects/proj_2` with `ownerId: "uid_a"`.
6. **ID Poisoning**: User A writes `/projects/` with a 500-character or `../etc/passwd` document ID.
7. **Orphan Subcollection Write**: User A creates `/projects/nonexistent/scenes/scene_1`.
8. **Cross-Tenant Subcollection Hijack**: User B writes `/projects/proj_a/characters/char_1` even if setting `ownerId: "uid_b"`.
9. **Client Timestamp Forgery**: User A creates `/projects/proj_1` with `createdAt: Timestamp(1999-01-01)`.
10. **Immortal Owner Mutation**: User A updates `/projects/proj_1` to reassign `ownerId: "uid_b"`.
11. **Unbounded Array Flood**: User A writes `characterIds` with 50 items or `[123]` instead of strings.
12. **Terminal Asset State Tampering**: User A updates a `'Completed'` `MediaAsset` status back to `'Generating'` or alters `creditCost`.
