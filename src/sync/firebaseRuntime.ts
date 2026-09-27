import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  signInAnonymously,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { FirestoreRemoteEventStore } from './firestoreRemoteStore';

export type FirebaseRuntimeStatus =
  | 'NOT_CONFIGURED'
  | 'AWAITING_APPROVAL'
  | 'DISABLED'
  | 'ACTIVE';

export interface FirebaseRuntime {
  status: FirebaseRuntimeStatus;
  uid?: string;
  db?: Firestore;
  remote?: FirestoreRemoteEventStore;
  appCheckEnabled: boolean;
  role?: 'ADMIN' | 'USER';
  reason?: string;
}

let runtimePromise: Promise<FirebaseRuntime> | null = null;
let appCheckInitialized = false;
const RUNTIME_TIMEOUT_MS = 8_000;

async function withRuntimeTimeout<T>(
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = globalThis.setTimeout(() => {
          reject(new Error('firebase-runtime-timeout'));
        }, RUNTIME_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}


function env(name: string): string | undefined {
  const value = import.meta.env[name] as string | undefined;
  return value?.trim() || undefined;
}

function createApp(): FirebaseApp | null {
  const apiKey = env('VITE_FIREBASE_API_KEY');
  const authDomain = env('VITE_FIREBASE_AUTH_DOMAIN');
  const projectId = env('VITE_FIREBASE_PROJECT_ID');
  const appId = env('VITE_FIREBASE_APP_ID');

  if (!apiKey || !authDomain || !projectId || !appId) return null;

  const existing = getApps()[0];
  if (existing) return existing;

  return initializeApp({
    apiKey,
    authDomain,
    projectId,
    appId,
  });
}

function firestoreForApp(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    return getFirestore(app);
  }
}

async function initializeRuntime(): Promise<FirebaseRuntime> {
  const app = createApp();
  if (!app) {
    return {
      status: 'NOT_CONFIGURED',
      appCheckEnabled: false,
      reason: 'firebase-env-missing',
    };
  }

  const appCheckKey = env('VITE_RECAPTCHA_ENTERPRISE_SITE_KEY');
  if (appCheckKey && !appCheckInitialized) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckKey),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckInitialized = true;
  }

  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);
  await auth.authStateReady();

  const credential = auth.currentUser
    ? { user: auth.currentUser }
    : await withRuntimeTimeout(signInAnonymously(auth));

  const uid = credential.user.uid;
  const db = firestoreForApp(app);

  try {
    const device = await withRuntimeTimeout(
      getDoc(doc(db, 'devices', uid)),
    );
    if (!device.exists()) {
      return {
        status: 'AWAITING_APPROVAL',
        uid,
        db,
        appCheckEnabled: Boolean(appCheckKey),
        reason: 'device-not-enrolled',
      };
    }

    if (device.data().enabled !== true) {
      return {
        status: 'DISABLED',
        uid,
        db,
        appCheckEnabled: Boolean(appCheckKey),
        reason: 'device-disabled',
      };
    }

    const role = device.data().role;
    if (role !== 'ADMIN' && role !== 'USER') {
      return {
        status: 'DISABLED',
        uid,
        db,
        appCheckEnabled: Boolean(appCheckKey),
        reason: 'device-role-invalid',
      };
    }

    return {
      status: 'ACTIVE',
      uid,
      db,
      remote: new FirestoreRemoteEventStore(db),
      appCheckEnabled: Boolean(appCheckKey),
      role,
    };
  } catch {
    return {
      status: 'AWAITING_APPROVAL',
      uid,
      db,
      appCheckEnabled: Boolean(appCheckKey),
      reason: 'device-access-denied',
    };
  }

}

export function getFirebaseRuntime(): Promise<FirebaseRuntime> {
  if (!runtimePromise) runtimePromise = initializeRuntime();
  return runtimePromise;
}

export function resetFirebaseRuntimeForRetry(): void {
  runtimePromise = null;
}


export type DeviceEnrollmentState =
  | 'ACTIVE'
  | 'DISABLED'
  | 'MISSING'
  | 'UNKNOWN';

export async function checkCurrentDeviceEnrollment(): Promise<DeviceEnrollmentState> {
  const app = createApp();
  if (!app) return 'UNKNOWN';

  const auth = getAuth(app);
  await auth.authStateReady();
  const uid = auth.currentUser?.uid;
  if (!uid) return 'UNKNOWN';

  const db = firestoreForApp(app);

  try {
    const device = await withRuntimeTimeout(
      getDoc(doc(db, 'devices', uid)),
    );
    if (!device.exists()) return 'MISSING';
    return device.data().enabled === true ? 'ACTIVE' : 'DISABLED';
  } catch {
    return 'UNKNOWN';
  }
}
