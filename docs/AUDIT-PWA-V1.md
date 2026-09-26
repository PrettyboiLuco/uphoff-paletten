# UPHOFF Paletten – V3 → PWA Audit v1

Stand: 2026-09-23

## Status-Legende
- **BEKANNT** = im verbundenen Repo gesehen oder durch offizielle Dokumentation verifiziert.
- **WAHRSCHEINLICH** = technisch plausibel, aber noch nicht auf den realen Zielgeräten abgenommen.
- **UNSICHER** = hängt von Lucs Geräten, Netz oder noch offenen Entscheidungen ab.

## 1. Stack-Befund

- **BEKANNT:** Ziel wird als installierbare PWA/Web-App umgesetzt, nicht als SwiftUI-App.
- **BEKANNT:** Das neue Repo `uphoff-paletten` enthält aktuell nur README; es existiert noch kein Altcode, also kein Migrationsrisiko.
- **BEKANNT:** Das Design-Referenzrepo `lusa-industrial-web` ist verbunden. Dort sind u. a. dunkle Void-/Silver-Paletten, Inter Tight/JetBrains Mono, Glasflächen, reduzierte Signalakzente und Motion-Prinzipien vorhanden.
- **BEKANNT:** Firestore-Web-Offlinepersistenz ist möglich; WebKit unterstützt IndexedDB und Persistent Storage API.
- **BEKANNT:** Home-Screen-Web-Apps sind von WebKits 7-Tage-ITP-Löschung der First-Party-Domain ausgenommen.
- **BEKANNT:** Browser-/Web-App-Speicher kann unter Speicher-/Quota-Druck trotzdem ausfallen oder evicted werden; daher darf kein einzelnes Gerät die einzige Datenkopie sein.

### Empfohlener Stack
- React + TypeScript + Vite
- PWA/Service Worker
- Dexie auf IndexedDB als eigener lokaler append-only Eventstore + Outbox
- Firebase Auth + Firestore + App Check
- Firebase Hosting
- Motion für UI-Bewegung
- Recharts oder uPlot/visx für Charts nach UI-Prototyp-Test
- Vitest für Domainlogik, Playwright für UI-/E2E-Tests

**Entscheidung:** Firestore ist für 1 iPad + 2–3 iPhones aktuell der bevorzugte Backend-Kandidat, weil Offline-Client, Realtime-Listener, Security Rules und geringe Betriebsgröße gut zusammenpassen. Supabase bleibt technisch möglich, verlangt aber für robuste Offline-First-Synchronisierung deutlich mehr eigene Logik. CloudKit JS scheidet für diese PWA-Richtung praktisch aus, weil der Setup-Pfad Apple-CloudKit-App-/Container-Infrastruktur voraussetzt. Nah-Sync wird nicht als Primärquelle verwendet.

## 2. Korrektheitsaudit des aktuellen Repos

Da das Repo noch keinen Produktivcode enthält:
- Gesamtzahl gespeichert oder berechnet: **OK / noch nicht implementiert**
- Gleichzeitige Buchungen: **OK / noch nicht implementiert**
- Offline-Buchung + App-Kill: **RISIKO / muss durch persist-before-display gelöst werden**
- Retry + Duplikate: **RISIKO / muss idempotent implementiert werden**
- Verschluckte Taps: **RISIKO / muss durch 1 Tap = 1 lokal persistiertes Event getestet werden**
- Bestand unter 0: **RISIKO / Warnung, kein Block**
- Uhrzeitabweichung: **RISIKO / Auditmarker**
- Reset/Inventur: **RISIKO / nur Differenz-Events**
- Sync-Status: **RISIKO / lokaler Persistenzstatus und Serverbestätigung trennen**
- Prüfcode: **RISIKO / noch nicht implementiert**
- Protokoll/Storno: **RISIKO / noch nicht implementiert**
- Datenmigration: **OK / Greenfield**
- Rules: **RISIKO / noch nicht implementiert**
- Backup: **RISIKO / noch nicht implementiert**

## 3. Zentrale Architekturentscheidung

### Persist-before-display
Ein Tap gilt lokal erst dann als gebucht, wenn das Event erfolgreich in IndexedDB geschrieben wurde.

Ablauf:
1. UUID erzeugen.
2. Event vollständig mit `buchungszeit`, `geraetId`, `sorte`, `art`, `delta`, `konfigVersion` erzeugen.
3. Event in lokaler IndexedDB-Transaktion persistieren.
4. Lokale Projektion neu berechnen.
5. UI animieren / Bestandsänderung anzeigen.
6. Event in Outbox markieren.
7. Firestore-Create mit derselben Dokument-ID versuchen.
8. Serverbestätigung speichern.
9. Bei verlorener Bestätigung per Existenz+Inhaltsvergleich bestätigen statt zweites Event zu erzeugen.

**BEKANNT:** Dadurch ist ein App-Kill nach Schritt 3 nicht gleich Datenverlust.
**BEKANNT:** Ein App-Kill vor Schritt 3 darf keine sichtbare Buchung erzeugen.

### Quelle der Wahrheit
- Lokaler aktueller Stand = Projektion aus lokal bekannten gültigen Events.
- Global bestätigter Stand = Projektion aus serverbestätigten + erfolgreich empfangenen Events.
- UI muss bei Pending Events sichtbar machen, dass andere Geräte noch einen älteren Stand haben können.

## 4. Eventmodell

Pflicht:
- `id`
- `geraetId`
- `person?`
- `sorte`
- `art`
- `delta`
- `buchungszeit`
- `serverzeit`
- `konfigVersion`
- `vorgangId?`
- `korrigiertId?`
- `umbuchungId?`
- lokaler `syncState`: LOCAL_ONLY | PENDING | CONFIRMED | REJECTED
- `clockSkewFlag?`
- `createdLocalAt`

### Vorgang-Zuordnung
**Vorschlag:** ±1-Korrekturen gehören zum letzten Stapel-Event derselben Sorte und desselben Modus, solange
- seit dem Stapel höchstens 12 Sekunden vergangen sind,
- keine andere Sorte gebucht wurde,
- kein Moduswechsel erfolgt ist,
- kein neuer Stapel-Button gedrückt wurde.

Begründung: 12 s ist lang genug für typische 13/14/18-Korrekturen, aber kurz genug, um getrennte Zählvorgänge nicht ungewollt zu verschmelzen.

## 5. Korrekturen
- Normale Events: UUID-Dokument-ID.
- KORREKTUR: `korr_<originalId>`.
- Doppelkorrektur muss serverseitig scheitern.
- REJECTED bleibt sichtbar und zählt lokal nicht in die bestätigte Projektion.
- Vorgangs-Undo erzeugt je Originalevent ein KORREKTUR-Event.

## 6. Aggregates

Empfehlung für Phase 1:
- **Keine gleichzeitig schreibenden Client-Aggregate.**
- Rohdaten bleiben autoritativ.
- Lokale Statistik wird aus lokalem Eventcache berechnet.
- Später: deterministische serverseitige Aggregate via Cloud Functions, falls Blaze akzeptiert wird.

Warum nicht iPad als Aggregator: Das iPad kann offline/geschlossen sein und würde zum Single-Writer-Betriebsrisiko.

## 7. Firestore-Kontingent grob

Beispielannahme: 500 Buchungsevents/Tag gesamt, 4 Geräte.

Writes:
- 500 Events
- ca. 4 Geräte × 96 Heartbeats/Tag bei 15-min-Takt = 384
- Geräte-/Status-/sonstige Writes grob < 500
=> grob < 1.500 Writes/Tag, klar unter 20.000 Free-Tier-Writes.

Reads:
- Realtime-Listener erzeugen Reads pro empfangenem Dokument.
- Bei 500 Events und 4 Geräten grob bis zu ~2.000 Event-Reads plus Listener-Neustarts/Rules/Meta.
=> mit Reserve sehr deutlich unter 50.000/Tag.

**UNSICHER:** Exakte Reads hängen von Listener-Strategie, App-Öffnungszeiten und Heartbeat-Design ab. Deshalb Usage-Monitoring + Alarmzustand vor Produktion.

## 8. Security Rules – Ziel
- Nur create für Events.
- update/delete immer deny.
- UID muss freigegebenes Gerät sein.
- Adminrechte separat.
- Eventart-spezifische Delta-Prüfung gegen versionierte Konfiguration.
- KORREKTUR liest Original via `get()`.
- UMBUCHUNG als atomarer Batch mit gemeinsamer `umbuchungId`, Summe 0, nur ADMIN.
- `buchungszeit` darf nicht beliebig in der Zukunft liegen; Offline-Altfälle dürfen nicht durch starre Vergangenheitssperren zerstört werden.
- Alte `konfigVersion` bleibt gültig.

## 9. Offline- und Speicherstrategie
- Dexie/IndexedDB = eigenes lokales Journal.
- Firestore-Persistence zusätzlich, aber nicht alleinige Sicherheitsbasis.
- `navigator.storage.persist()` beim Onboarding anfragen.
- `navigator.storage.persisted()` und `navigator.storage.estimate()` überwachen.
- Warnzustand bei nicht-persistentem Speicher oder sehr wenig freiem Quota.
- Produktionsbetrieb nur als installierte Home-Screen-PWA empfehlen.
- Wöchentlicher Export + manueller Export.
- Cloud bleibt zweite Kopie.

## 10. UI/Design
Designrichtung aus Referenzrepo:
- dunkler Void-Hintergrund
- klare Weiß-/Silber-Typografie
- Monospace für technische Statuszeilen
- keine lila Verläufe
- keine Standard-KI-Karten
- Akzentfarben funktional reserviert
- Bewegung nur auf Zustandsänderung
- reduzierter, langsamer Hintergrund bei erlaubter Motion

Für die Zählseite wird Funktion vor Show priorisiert:
- Gesamtbestand größte Zahl
- Eingang/Ausgang extrem klar unterscheidbar
- 7 Sorten ohne Scrollen
- Touchziele mindestens 60 px CSS
- letzter Vorgang als kompakter Undo-Chip

## 11. PWA-spezifische Abweichungen zu V3
Entfallen/ersetzen:
- SwiftUI, sensoryFeedback, Swift Charts, MeshGradient, chartXSelection
- native iOS Distribution / Developer Program

Ersatz:
- CSS/Web Animations/Motion
- Pointer Events
- Web Audio optional für iPad-Klick
- CSS `orientation`/Manifest + Layout-Fallback; harte iPad-Portrait-Sperre ist im Web nicht garantiert
- Charts mit Web-Library
- Service Worker + Web App Manifest

## 12. Noch offen / nicht raten
1. 7 Sortennamen + Stapelgröße 15/17
2. reale iPhone-/iPad-Modelle + OS-Versionen
3. kleinstes iPhone
4. WLAN/Mobilfunk-Situation auf Hof/Halle
5. Umbuchungen ja/nein
6. Inventurdifferenz sichtbar ja/nein
7. Auto-Rücksprung Eingang ja/nein + Minuten
8. ADMIN-Gerät
9. Gerät oder Person anzeigen
10. Layout pro Gerät oder synchron
11. Statistik überall oder nur iPad
12. Backup-Ziel
13. Blaze bei späteren serverseitigen Aggregaten ja/nein

## 13. Garantieaussage
Garantierbar durch Design + Tests:
- idempotente Event-IDs
- kein LWW-Gesamtzähler
- lokale Persistenz vor sichtbarer Buchung
- reproduzierbare Projektion
- deterministische Korrektur-ID
- keine stillen REJECTED-Events
- nachvollziehbarer Auditpfad

Nicht absolut garantierbar:
- sofortige Zustellung ohne Netz
- dass Browser-/OS-Speicher niemals durch Nutzer/System gelöscht wird
- dass ein Gerät ohne Strom/Netz andere Geräte aktuell hält
- dass externe Dienste niemals ausfallen

Dafür existieren lokale Persistenz, Cloud-Kopie, Statusanzeige, Retry und Backup als getrennte Schutzschichten.
