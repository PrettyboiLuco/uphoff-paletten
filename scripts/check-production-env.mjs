import { loadEnv } from 'vite';

const env = loadEnv('production', process.cwd(), 'VITE_');
const required = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_RECAPTCHA_ENTERPRISE_SITE_KEY',
];
const missing = required.filter((name) => !env[name]?.trim());

if (missing.length > 0) {
  console.error(`Deployment abgebrochen: Firebase-Konfiguration fehlt (${missing.join(', ')}).`);
  console.error('Die Werte müssen vor dem Build in .env.production.local oder als Umgebungsvariablen vorliegen.');
  process.exit(1);
}
if (env.VITE_FIREBASE_PROJECT_ID !== 'uphoff-paletten') {
  console.error('Deployment abgebrochen: falsches Firebase-Projekt.');
  process.exit(1);
}
if (env.VITE_ALLOW_LOCAL_ONLY === 'true') {
  console.error('Deployment abgebrochen: lokale Testbuchungen sind in Produktion nicht erlaubt.');
  process.exit(1);
}

console.log('Firebase-Produktionskonfiguration vollständig; Schlüsselwerte werden nicht ausgegeben.');
