# Produktions-Setup – UPHOFF Paletten PWA

Stand: 2026-09-23

## 1. Firebase-Projekt
1. Firebase-Projekt anlegen.
2. Web-App registrieren.
3. Firestore-Datenbank aktivieren.
4. Authentication -> Sign-in method -> **Anonymous** aktivieren. Für diese gerätegebundenen IDs **keine automatische Bereinigung alter anonymer Konten aktivieren**, solange diese IDs als dauerhafte Gerätefreigabe verwendet werden.
5. Firestore Security Rules aus `firestore.rules` deployen.
6. Web-App-Konfiguration in die fünf `VITE_...` Variablen der Hosting-Umgebung eintragen.

## 2. App Check
Für Produktion wird App Check mit **reCAPTCHA Enterprise** verwendet.
- Web-Key für die echte Produktionsdomain erstellen.
- App in Firebase App Check registrieren.
- `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` setzen.
- Erst Metriken beobachten, dann Enforcement für Firestore aktivieren.
- Produktions-Key nicht für localhost verwenden.

## 3. Gerätefreigabe
Die PWA meldet jedes neue Gerät anonym bei Firebase Auth an. Die resultierende UID ist die Geräte-ID.

Erster Start:
- Im Header erscheint **Gerät freigeben**.
- Die UID wird im gelben Hinweis angezeigt.
- In Firestore unter `devices/<UID>` ein Dokument anlegen:
  - `enabled: true`
  - `role: "ADMIN"` für das festgelegte Admin-Gerät, sonst `"USER"`
  - optional `name`

Danach App neu öffnen. Erst ein freigegebenes Gerät kann Events lesen/schreiben.

## 4. Konfiguration
Mindestens `configs/v1` muss existieren, bevor Produktionsbuchungen synchronisiert werden.

Beispiel:
```json
{
  "stapel": {
    "typ-1": 15,
    "typ-2": 15,
    "typ-3": 15,
    "typ-4": 15,
    "typ-5": 17,
    "typ-6": 17,
    "typ-7": 17
  }
}
```

Die echten sieben Sortennamen und Stapelgrößen müssen vor Rollout in `src/ui/config.ts` und in der serverseitigen Konfiguration übereinstimmen.

## 5. Lokale Persistenz
Die App verwendet zwei Ebenen:
- eigener append-only Eventstore + Outbox in IndexedDB/Dexie;
- zusätzlich Firestore persistent local cache.

Beim Start wird außerdem die Storage Persistence API angefragt, sofern der Browser sie anbietet. Ein fehlendes Persistenz-Versprechen ist kein Datenverlustsignal, sondern ein Grund, Cloud-Sync und externe Backups zwingend beizubehalten.

## 6. Hosting / Installation
- Produktionsbuild mit `npm run build`.
- HTTPS-Hosting verwenden.
- Auf iPhone/iPad über Safari öffnen und zum Home-Bildschirm hinzufügen.
- Für den Hofbetrieb ausschließlich die installierte Home-Screen-PWA verwenden.
- Nach jeder neuen Version zuerst auf einem Testgerät prüfen, dann produktive Geräte aktualisieren.

## 7. Freigabe vor Produktivbetrieb
Produktivbetrieb erst nach:
- echten sieben Sortennamen + Stapelgrößen;
- Firebase-Konfiguration;
- App Check;
- mindestens einem ADMIN-Gerät;
- iPhone/iPad-Gerätetest;
- Offline -> App schließen -> Neustart -> Online-Sync;
- Parallelbetrieb mit bisherigem Zählverfahren;
- JSON-Backup und Test-Restore;
- identischen Prüfcodes nach vollständiger Synchronisierung.
