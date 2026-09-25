# Produktions-Setup – UPHOFF Paletten PWA

Stand: 2026-09-23

## 1. Firebase-Projekt
1. Firebase-Projekt anlegen.
2. Web-App registrieren.
3. Firestore-Datenbank aktivieren.
4. Authentication -> Sign-in method -> **Anonymous** aktivieren. Für diese gerätegebundenen IDs **keine automatische Bereinigung alter anonymer Konten aktivieren**, solange diese IDs als dauerhafte Gerätefreigabe verwendet werden.
5. Firestore Security Rules aus `firestore.rules` deployen.
6. Web-App-Konfiguration in die fünf `VITE_...` Variablen der Hosting-Umgebung eintragen.
7. `VITE_ALLOW_LOCAL_ONLY` in Produktion **nicht** auf `true` setzen. Ohne Cloud-Konfiguration sperrt die Produktions-App neue Buchungen bewusst, damit kein einzelnes Gerät zur einzigen Datenkopie wird.

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
    "typ-4": 18,
    "typ-5": 25,
    "typ-6": 17,
    "typ-7": 17
  }
}
```

Die Namen und alle sieben Stapelgrößen wurden von Luc bestätigt: Europaletten 15, Euroersatzpaletten 15, CP 15, Einweg 18, Schachtelt 25, Nutra 17 und 1200x1000 17. Die beiden Freigabeschalter für die Sortenkonfiguration stehen deshalb auf `true`. Für echte Buchungen braucht die App weiterhin ein eingerichtetes Firebase-Projekt, das passende Dokument `configs/v1` und ein freigegebenes Gerät. Anfangsbestände und Praxistest vor Ort folgen später.

## 5. Lokale Persistenz
Die App verwendet zwei Ebenen:
- eigener append-only Eventstore + Outbox in IndexedDB/Dexie;
- zusätzlich Firestore persistent local cache.

Beim Start wird außerdem die Storage Persistence API angefragt, sofern der Browser sie anbietet. Ein fehlendes Persistenz-Versprechen ist kein Datenverlustsignal, sondern ein Grund, Cloud-Sync und externe Backups zwingend beizubehalten.

## 6. Hosting / Installation
- Im Firebase-Projekt Firebase Hosting aktivieren. `firebase.json` liefert `dist/` aus, leitet App-Routen an `index.html` weiter und hält `index.html` sowie `sw.js` aktualisierbar.
- Die Produktionswerte der `VITE_...` Variablen nur in der lokalen Build-Umgebung setzen, nicht ins öffentliche Repository committen. Die Firebase-Web-Konfiguration wird im Browser-Bundle sichtbar; die Zugriffskontrolle muss über Auth, Security Rules und App Check funktionieren.
- Vor dem Deploy `npm ci && npm run typecheck && npm run build` ausführen. Dann gezielt `npx firebase deploy --only firestore:rules,hosting --project <PROJECT_ID>` ausführen. Die Projekt-ID durch das eigene Firebase-Projekt ersetzen; niemals versehentlich das Testprojekt `uphoff-paletten-test` verwenden.
- HTTPS-Hosting verwenden. Ein grüner CI-Lauf veröffentlicht die App nicht automatisch.
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
