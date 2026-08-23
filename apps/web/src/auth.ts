import { initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
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

function browserSessionStorage() {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function browserLocalStorage() {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readJsonStorage<T>(key: string, fallback: T, preferSession = true): T {
  const stores = preferSession
    ? [browserSessionStorage(), browserLocalStorage()]
    : [browserLocalStorage(), browserSessionStorage()];
  for (const store of stores) {
    if (!store) continue;
    try {
      const raw = store.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as T;
      return parsed;
    } catch {
      continue;
    }
  }
  return fallback;
}

function writeJsonStorage(key: string, value: unknown, preferSession = true) {
  const serialized = JSON.stringify(value);
  const stores = preferSession
    ? [browserSessionStorage(), browserLocalStorage()]
    : [browserLocalStorage(), browserSessionStorage()];
  for (const store of stores) {
    if (!store) continue;
    try {
      store.setItem(key, serialized);
      return;
    } catch {
      continue;
    }
  }
}

function removeStoredValue(key: string) {
  browserSessionStorage()?.removeItem(key);
  browserLocalStorage()?.removeItem(key);
}

async function ensureUser() {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  // Firebase restores a persisted Google session asynchronously. Waiting here
  // prevents API requests from racing ahead of the restored account.
  await firebaseAuth.authStateReady();
  if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
  throw new Error('Sign in to continue.');
}

export async function ensureAnonymousUser() {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
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
    return (
      browserSessionStorage()?.getItem("vl_token") ??
      browserLocalStorage()?.getItem("vl_token") ??
      "demo-user"
    );
  }
  return (await ensureUser()).getIdToken();
}

export async function signInWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return (await signInWithPopup(firebaseAuth, provider)).user;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(firebaseAuth, provider);
      return undefined;
    }
    throw error;
  }
}

export async function registerWithEmail(name: string, email: string, password: string) {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  const credential = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
  await updateProfile(credential.user, { displayName: name.trim() });
  await sendEmailVerification(credential.user).catch(() => undefined);
  return credential.user;
}

export async function signInWithEmail(email: string, password: string) {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  return (await signInWithEmailAndPassword(firebaseAuth, email.trim(), password)).user;
}

export async function requestPasswordReset(email: string) {
  if (!firebaseAuth) throw new Error('Firebase Auth is not configured');
  await sendPasswordResetEmail(firebaseAuth, email.trim());
}

export async function completeGoogleRedirectSignIn() {
  if (!firebaseAuth) return;
  const result = await getRedirectResult(firebaseAuth);
  return result?.user;
}

export function getFriendlyAuthError(error: unknown) {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : "";
  const customData =
    error && typeof error === "object" && "customData" in error
      ? JSON.stringify((error as { customData?: unknown }).customData)
      : "";
  if (code === 'auth/unauthorized-domain') {
    return 'Google sign-in is not authorised for this domain. Please contact Video Lab support.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Sign-in could not connect. Check your connection and try again.';
  }
  if (code === 'auth/internal-error') {
    return `Firebase sign-in failed internally${message ? `: ${message}` : ""}${customData ? ` ${customData}` : ""}`;
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'An account already exists with this email using another sign-in method.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'An account already exists with this email. Log in instead or reset your password.';
  }
  if (code === 'auth/invalid-email') {
    return 'Enter a valid email address.';
  }
  if (code === 'auth/weak-password') {
    return 'Choose a stronger password with at least 8 characters.';
  }
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(code ?? '')) {
    return 'The email or password is incorrect.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Please wait a moment or reset your password.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Email and password sign-in is not enabled yet. Please use Google or contact Video Lab support.';
  }
  return error instanceof Error ? error.message : 'Sign-in failed. Please try again.';
}

export async function signOutUser() {
  if (!firebaseAuth) {
    removeStoredValue("vl_token");
    return;
  }
  await signOut(firebaseAuth);
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
    return readJsonStorage<Record<string, unknown>>("vl_registration", {}, true);
  }
  const user = await ensureUser();
  const snapshot = await getDoc(doc(getFirestore(firebaseApp), 'users', user.uid));
  return (snapshot.data()?.registration ?? {}) as Record<string, unknown>;
}

export async function saveRegistrationProfile(registration: Record<string, unknown>) {
  writeJsonStorage("vl_registration", registration, true);
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
