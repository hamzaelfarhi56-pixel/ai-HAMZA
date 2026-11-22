/**
 * Security Rules TDD Specification Runner
 * Verifies all Dirty Dozen adversarial payloads are rejected with PERMISSION_DENIED.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  authUid: string | null;
  emailVerified: boolean;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Project Read',
    operation: 'get',
    path: '/projects/proj_1',
    authUid: null,
    emailVerified: false,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-User PII Leak',
    operation: 'get',
    path: '/users/uid_a',
    authUid: 'uid_b',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Credit Minting Spoof on Profile Create',
    operation: 'create',
    path: '/users/uid_a',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { uid: 'uid_a', credits: 999999, totalGenerated: 0 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow Field Injection',
    operation: 'create',
    path: '/projects/proj_1',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { id: 'proj_1', ownerId: 'uid_a', title: 'Noir', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Identity Spoofing on Project Create',
    operation: 'create',
    path: '/projects/proj_2',
    authUid: 'uid_b',
    emailVerified: true,
    payload: { id: 'proj_2', ownerId: 'uid_a', title: 'Hijack' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'ID Poisoning with Path Traversal Characters',
    operation: 'create',
    path: '/projects/..%2Fbad_id',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { id: '../bad_id', ownerId: 'uid_a', title: 'Bad' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Orphan Subcollection Write',
    operation: 'create',
    path: '/projects/nonexistent_proj/scenes/scene_1',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { id: 'scene_1', projectId: 'nonexistent_proj', ownerId: 'uid_a' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Cross-Tenant Subcollection Hijack',
    operation: 'create',
    path: '/projects/proj_a/characters/char_1',
    authUid: 'uid_b',
    emailVerified: true,
    payload: { id: 'char_1', projectId: 'proj_a', ownerId: 'uid_b' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Client Timestamp Forgery',
    operation: 'create',
    path: '/projects/proj_1',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { id: 'proj_1', ownerId: 'uid_a', createdAt: '1999-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Immortal Owner Mutation',
    operation: 'update',
    path: '/projects/proj_1',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { ownerId: 'uid_b' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Unbounded Array Flood',
    operation: 'create',
    path: '/projects/proj_a/scenes/scene_2',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { id: 'scene_2', projectId: 'proj_a', ownerId: 'uid_a', characterIds: [123, 456] },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Terminal Asset State Tampering',
    operation: 'update',
    path: '/projects/proj_a/assets/asset_completed',
    authUid: 'uid_a',
    emailVerified: true,
    payload: { status: 'Generating', creditCost: 0 },
    expected: 'PERMISSION_DENIED',
  },
];
