/**
 * Google sign-in through Firebase Authentication.
 * Loaded lazily (only when someone taps "Continue with Google") to keep the app fast.
 */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

/** Resolves once Firebase has finished its start-up checks (needed before the popup on Safari/iOS). */
export function authReady(): Promise<void> {
  return auth.authStateReady();
}

/** Opens the Google popup and returns a Firebase ID token for the server to verify. */
export async function getGoogleIdToken(): Promise<string> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return result.user.getIdToken();
}

export async function signOutGoogle(): Promise<void> {
  await signOut(auth).catch(() => {});
}
