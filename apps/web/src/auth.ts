import { initializeApp } from 'firebase/app';
import {
  getRedirectResult,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

export const isProductionFirebase = import.meta.env.PROD;
export const firebaseApp = isProductionFirebase
  ? initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    })
  : undefined;

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : undefined;
let signInPromise: Promise<User> | undefined;

async function ensureUser() {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  // Firebase restores a persisted Google session asynchronously. Waiting here
  // prevents an eager API request from creating an anonymous user first and
  // replacing the restored account.
  await firebaseAuth.authStateReady();
  if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
  if (!signInPromise) {
    signInPromise = signInAnonymously(firebaseAuth)
      .then(({ user }) => user)
      .finally(() => { signInPromise = undefined; });
  }
  return signInPromise;
}

export async function getApiToken() {
  if (!isProductionFirebase) {
    return localStorage.getItem('vl_token') || 'demo-user';
  }
  return (await ensureUser()).getIdToken();
}

export async function signInWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    // Start the popup directly inside the click handler. Waiting for anonymous
    // auth first loses the browser's user gesture and triggers popup blockers.
    return (await signInWithPopup(firebaseAuth, provider)).user;
  } catch (error) {
    if ((error as { code?: string }).code === 'auth/popup-blocked') {
      await signInWithRedirect(firebaseAuth, provider);
      return;
    }
    throw error;
  }
}

export async function completeGoogleRedirectSignIn() {
  if (!firebaseAuth) return;
  const result = await getRedirectResult(firebaseAuth);
  return result?.user;
}

export function getFriendlyAuthError(error: unknown) {
  const code = (error as { code?: string }).code;
  if (code === 'auth/unauthorized-domain') {
    return 'Google sign-in is not authorised for this domain. Please contact Video Lab support.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Google sign-in could not connect. Check your connection and try again.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'An account already exists with this email using another sign-in method.';
  }
  return error instanceof Error ? error.message : 'Google sign-in failed. Please try again.';
}

export async function signOutUser() {
  if (!firebaseAuth) {
    localStorage.removeItem('vl_token');
    return;
  }
  await signOut(firebaseAuth);
  await ensureUser();
}

export function observeAuth(callback: (user: User | null) => void) {
  if (!firebaseAuth) {
    callback(null);
    return () => undefined;
  }
  return onAuthStateChanged(firebaseAuth, callback);
}

export async function getFirebaseUser() {
  return ensureUser();
}

export async function loadRegistrationProfile() {
  if (!firebaseApp) {
    try { return JSON.parse(localStorage.getItem('vl_registration') ?? '{}') as Record<string, unknown>; }
    catch { return {}; }
  }
  const user = await ensureUser();
  const snapshot = await getDoc(doc(getFirestore(firebaseApp), 'users', user.uid));
  return (snapshot.data()?.registration ?? {}) as Record<string, unknown>;
}

export async function saveRegistrationProfile(registration: Record<string, unknown>) {
  localStorage.setItem('vl_registration', JSON.stringify(registration));
  if (!firebaseApp) return;
  const user = await ensureUser();
  await setDoc(doc(getFirestore(firebaseApp), 'users', user.uid), {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
    registration,
    registrationUpdatedAt: new Date().toISOString(),
  }, { merge: true });
}
