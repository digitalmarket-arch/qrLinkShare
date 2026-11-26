/**
 * Google sign-in through Firebase Authentication (Google's sign-in service).
 * Only used to recognise "my own devices": no data is stored in Firebase.
 * Loaded lazily, so people who never use Google sign-in don't download it.
 */
import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  GoogleAuthProvider,
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;

/** Resolves once Firebase has finished its start-up checks (needed before the popup on Safari/iOS). */
export function authReady(): Promise<void> {
  return auth.authStateReady();
}

/** In "keep nothing on this computer" mode the Google session isn't saved either. */
export function setRemember(remember: boolean): Promise<void> {
  return setPersistence(auth, remember ? browserLocalPersistence : inMemoryPersistence);
}

/** Opens the Google popup. Call straight from a tap so the browser allows the popup. */
export async function signInWithGoogle(): Promise<{ uid: string; email: string }> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return { uid: result.user.uid, email: result.user.email || 'Google account' };
}

/** A fresh ID token for the signed-in user, or null if signed out. */
export async function currentIdToken(expectedUid: string): Promise<string | null> {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || user.uid !== expectedUid) return null;
  return user.getIdToken();
}

export async function signOutGoogle(): Promise<void> {
  await signOut(auth).catch(() => {});
}
