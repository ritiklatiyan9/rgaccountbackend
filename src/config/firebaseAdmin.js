import fs from 'fs';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * Firebase Admin — verifies Google Sign-In ID tokens minted by the frontend's
 * Firebase popup (project `defencegardenbooking`, SAME project as the booking app,
 * so one Google account works across both ERPs).
 *
 * The service-account key lives OUTSIDE version control at
 * `secrets/firebase-service-account.json` (override with FIREBASE_SERVICE_ACCOUNT).
 * When the file is absent the app still boots — /auth/google then reports 503.
 */
// Render mounts secret files at /etc/secrets/<name> and at the service root,
// so try those too when the env var isn't set.
const candidates = [
  process.env.FIREBASE_SERVICE_ACCOUNT,
  'secrets/firebase-service-account.json',
  '/etc/secrets/firebase-service-account.json',
  'firebase-service-account.json',
]
  .filter(Boolean)
  .map((p) => path.resolve(process.cwd(), p));

const keyPath = candidates.find((p) => fs.existsSync(p));

let app = null;
if (keyPath) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    app = initializeApp({ credential: cert(serviceAccount) }, 'rgaccount-google-auth');
    console.log(`[rgaccount-api] Firebase Admin ready (project ${serviceAccount.project_id})`);
  } catch (err) {
    console.error('[rgaccount-api] Firebase Admin init failed:', err.message);
  }
} else {
  console.warn('[rgaccount-api] Firebase service-account key not found; tried:', candidates.join(', '));
}

export const firebaseEnabled = () => !!app;

/** Verify a Firebase ID token → decoded payload (throws on invalid/expired). */
export const verifyFirebaseIdToken = (idToken) => getAuth(app).verifyIdToken(idToken);
