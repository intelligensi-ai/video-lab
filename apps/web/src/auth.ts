import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
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
  const current = await ensureUser();
  try {
    const result = current.isAnonymous
      ? await linkWithPopup(current, provider)
      : await signInWithPopup(firebaseAuth, provider);
    return result.user;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
      return (await signInWithPopup(firebaseAuth, provider)).user;
    }
    throw error;
  }
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
