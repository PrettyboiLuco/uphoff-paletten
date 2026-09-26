# Produktions-Setup – UPHOFF Paletten PWA

Stand: 2026-09-26

## Aktueller Einrichtungsstand
- Projekt `uphoff-paletten` auf dem kostenlosen Spark-Tarif angelegt; Web-App „Uphoff Paletten PWA“ registriert.
- Firestore `(default)` in `europe-west3` (Frankfurt) im Produktionsmodus angelegt. Die getesteten Regeln aus `firestore.rules` sind veröffentlicht.
- Authentication: anonyme Anmeldung aktiviert, automatische Bereinigung deaktiviert.
- `configs/v1` enthält alle sieben bestätigten Stapelgrößen.
- Die App ist unter `https://uphoff-paletten.web.app` veröffentlicht. Nach einer fehlerhaften Bereitstellung wurde am 26.09.2026 die funktionierende Hosting-Version vom 26.09., 11:50 Uhr, wiederhergestellt.
- Zwei Geräte sind als `ADMIN` freigegeben. Die aktuelleren Heartbeat-Daten zeigten 128 bestätigte Ereignisse, 0 ausstehende und 0 abgelehnte Buchungen; das zweite Gerät meldete sich zuletzt Stunden früher mit 117 Ereignissen. Ein Heartbeat ist nur ein vom Gerät gemeldeter Stand, kein unabhängiger Bestandsnachweis.
- **Der serverseitige Schutz vor negativem Bestand ist noch nicht live.** Die neuen Regeln, `stocks/*` und `system/stockControl` dürfen nur im unten beschriebenen Wartungsfenster aktiviert werden.
- Offen: geräteübergreifenden Abgleich vor Ort prüfen, Backup und Restore testen, App Check Enforcement anhand der Metriken beurteilen.

## 1. Firebase-Projekt
1. Firebase-Projekt anlegen.
2. Web-App registrieren.
3. Firestore-Datenbank aktivieren.
4. Authentication -> Sign-in method -> **Anonymous** aktivieren. Für diese gerätegebundenen IDs **keine automatische Bereinigung alter anonymer Konten aktivieren**, solange diese IDs als dauerhafte Gerätefreigabe verwendet werden.
5. Firestore Security Rules aus `firestore.rules` deployen.
6. Web-App-Konfiguration in die vier `VITE_FIREBASE_...` Variablen der lokalen Produktions-Build-Umgebung eintragen.
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
- Vor dem Deploy `npm ci && npm run typecheck && npm run test:release-unit && npm run build:deploy` ausführen. Hosting und Firestore-Regeln beim Bestandsumbau **nicht mit einem einzigen Befehl** deployen: siehe Wartungsablauf unten. Niemals versehentlich das Testprojekt `uphoff-paletten-test` verwenden.
- HTTPS-Hosting verwenden. Ein grüner CI-Lauf veröffentlicht die App nicht automatisch.
- Auf iPhone/iPad über Safari öffnen und zum Home-Bildschirm hinzufügen.
- Für den Hofbetrieb ausschließlich die installierte Home-Screen-PWA verwenden.
- Nach jeder neuen Version zuerst auf einem Testgerät prüfen, dann produktive Geräte aktualisieren.

## 7. Serverseitigen Mindestbestand aktivieren (geplante Wartung)

Dieser Schritt ist **noch nicht erfolgt**. Bis zur Aktivierung kann eine gleichzeitige Entnahme auf zwei Geräten den gemeinsamen Bestand rechnerisch unter 0 bringen. Die bereits vorbereiteten Firestore-Regeln verweigern sämtliche neuen Ereignisse, solange `system/stockControl` nicht `ACTIVE` ist. Ein Regeln-Deploy ohne unmittelbar folgende Migration unterbricht daher Buchungen. Alte App-Versionen schreiben ohne atomische Bestandsaktualisierung und werden nach Aktivierung vom Server abgewiesen.

1. Mitarbeiter über das kurze Wartungsfenster informieren und Buchungen anhalten. Beide freigegebenen Geräte öffnen; in **DATEN** prüfen, dass `pendingCount = 0`, `rejectedCount = 0`, Ereigniszahl und Prüfcodes übereinstimmen. Von beiden Geräten ein JSON-Backup erstellen und einen Restore in einer getrennten Testumgebung prüfen. Diskrepanzen vorher klären.
2. Die neue App-Version zunächst nur auf Hosting veröffentlichen: `npx firebase deploy --only hosting --project uphoff-paletten`. Der Hosting-Predeploy erzwingt einen Build mit vollständiger Firebase-Konfiguration. Auf beiden Geräten App schließen und neu öffnen, danach in Firestore `heartbeats/*` die neue Build-Kennung (z. B. `0.1.0+abc12345`) sowie `SYNCHRON`, identische Prüfcodes und 0 ausstehende/abgelehnte Buchungen kontrollieren. Keine Gerätebuchungen während der nachfolgenden Umschaltung.
3. Auf einem **separaten, authentifizierten** Terminal mit Berechtigung für Firebase Admin SDK `node scripts/activate-stock-floor.mjs uphoff-paletten --dry-run` ausführen und Summen mit den gesicherten Daten abgleichen. Die Ausgabe `readiness` muss leer sein. Das Skript prüft bei jedem freigegebenen Gerät einen höchstens fünf Minuten alten Heartbeat, die aktuelle Build-Kennung, `SYNCHRON`, null ausstehende/abgelehnte Buchungen und denselben Prüfcode wie die Server-Ereignisse. Abweichungen zuerst klären. Das Skript prüft dieselben Bedingungen erneut innerhalb der Aktivierungstransaktion und bricht bei Abweichungen ohne Datenänderung ab.
4. Regeln gezielt veröffentlichen: `npx firebase deploy --only firestore:rules --project uphoff-paletten`. **Sofort danach** `node scripts/activate-stock-floor.mjs uphoff-paletten --activate` ausführen. Die Migration liest die bestätigten Ereignisse und legt alle sieben Zähler zusammen mit der Freigabe atomar an. Bricht sie ab, ist das Wartungsfenster weiterhin aktiv; keine Buchungen freigeben, bevor Ursache und Datenbestand geprüft wurden.
5. Firestore `stocks/*` mit den Ereignissummen vergleichen, auf beiden Geräten neu synchronisieren und einen kleinen Probevorgang buchen und wieder rückgängig machen. Auf beiden Geräten die gleiche Summe, Prüfcodes sowie 0 ausstehende/abgelehnte Buchungen bestätigen. Erst dann Betrieb freigeben. Bei einem Fehler keine lokalen Browserdaten oder Firestore-Ereignisse löschen.

Die Version im Geräte-Heartbeat enthält die Git-Commit-Kennung. Damit lässt sich prüfen, ob jedes Gerät tatsächlich den neuen Client geladen hat; `0.1.0` allein reicht dafür nicht aus.

## 8. Freigabe vor Produktivbetrieb
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
