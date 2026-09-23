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
  | 'ACTIVE';

export interface FirebaseRuntime {
  status: FirebaseRuntimeStatus;
  uid?: string;
  db?: Firestore;
  remote?: FirestoreRemoteEventStore;
  appCheckEnabled: boolean;
  reason?: string;
}

let runtimePromise: Promise<FirebaseRuntime> | null = null;

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
  if (appCheckKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);

  const credential = auth.currentUser
    ? { user: auth.currentUser }
    : await signInAnonymously(auth);

  const uid = credential.user.uid;
  const db = firestoreForApp(app);

  try {
    const device = await getDoc(doc(db, 'devices', uid));
    if (!device.exists() || device.data().enabled !== true) {
      return {
        status: 'AWAITING_APPROVAL',
        uid,
        db,
        appCheckEnabled: Boolean(appCheckKey),
        reason: 'device-not-enabled',
      };
    }
  } catch {
    return {
      status: 'AWAITING_APPROVAL',
      uid,
      db,
      appCheckEnabled: Boolean(appCheckKey),
      reason: 'device-access-denied',
    };
  }

  return {
    status: 'ACTIVE',
    uid,
    db,
    remote: new FirestoreRemoteEventStore(db),
    appCheckEnabled: Boolean(appCheckKey),
  };
}

export function getFirebaseRuntime(): Promise<FirebaseRuntime> {
  if (!runtimePromise) runtimePromise = initializeRuntime();
  return runtimePromise;
}

export function resetFirebaseRuntimeForRetry(): void {
  runtimePromise = null;
}
