import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { SharedItem } from '../types/share';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();

export async function signInWithGooglePopup() {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutFirebaseUser() {
  await firebaseSignOut(auth);
}

/**
 * Saves a SharedItem to Firestore /vaultItems/{itemId} when user is signed in with verified email.
 * Enforces firebase-blueprint.json maxLength and schema constraints before writing.
 */
export async function saveVaultItemToFirestore(item: SharedItem): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const cleanId = item.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  const cleanRoom = (item.roomId || 'SYNC-42')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 32);

  // Respect Firestore 50KB content limit from blueprint (large base64 binaries stay in room/local storage)
  const safeContent = (item.content || item.title || 'Shared Item').slice(
    0,
    48000
  );

  const payload: Record<string, unknown> = {
    id: cleanId,
    ownerUid: user.uid,
    roomId: cleanRoom,
    category: item.category,
    retentionMode: item.retentionMode,
    title: (item.title || 'Shared Item').slice(0, 200),
    content: safeContent,
    sizeBytes: Math.min(Math.max(0, item.sizeBytes || 0), 26214400),
    senderDevice: item.senderDevice === 'mobile' ? 'mobile' : 'desktop',
    senderName: (item.senderName || 'Device').slice(0, 100),
    pinned: Boolean(item.pinned),
    openedOnDesktop: Boolean(item.openedOnDesktop),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (item.fileName) {
    payload.fileName = item.fileName.slice(0, 256);
  }
  if (item.mimeType) {
    payload.mimeType = item.mimeType.slice(0, 128);
  }

  const path = `vaultItems/${cleanId}`;
  try {
    await setDoc(doc(db, 'vaultItems', cleanId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateVaultItemInFirestore(
  itemId: string,
  changes: Partial<Pick<SharedItem, 'pinned' | 'retentionMode' | 'openedOnDesktop' | 'title'>>
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const cleanId = itemId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  const path = `vaultItems/${cleanId}`;
  try {
    await updateDoc(doc(db, 'vaultItems', cleanId), {
      ...changes,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteVaultItemFromFirestore(
  itemId: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const cleanId = itemId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
  const path = `vaultItems/${cleanId}`;
  try {
    await deleteDoc(doc(db, 'vaultItems', cleanId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToUserVaultItems(
  ownerUid: string,
  onUpdate: (items: SharedItem[]) => void
): () => void {
  const q = query(
    collection(db, 'vaultItems'),
    where('ownerUid', '==', ownerUid)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const result: SharedItem[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        const createdIso =
          d.createdAt instanceof Timestamp
            ? d.createdAt.toDate().toISOString()
            : new Date().toISOString();
        return {
          id: d.id,
          roomId: d.roomId || 'SYNC-42',
          category: d.category || 'link',
          retentionMode: d.retentionMode === 'temporary' ? 'temporary' : 'saved',
          title: d.title || 'Shared Item',
          content: d.content || '',
          fileName: d.fileName,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes || 0,
          senderDevice: d.senderDevice === 'mobile' ? 'mobile' : 'desktop',
          senderName: d.senderName || 'Cloud Sync',
          createdAt: createdIso,
          pinned: Boolean(d.pinned),
          openedOnDesktop: Boolean(d.openedOnDesktop),
        };
      });
      onUpdate(result);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'vaultItems');
    }
  );
}
