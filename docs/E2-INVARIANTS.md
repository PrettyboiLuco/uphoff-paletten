# E2 Sync & Persistenz – Invarianten und Testmatrix

Stand: 2026-09-23

## Ziel

E2 beweist, dass eine Buchung lokal dauerhaft erhalten bleibt, sich idempotent synchronisieren lässt und unter Mehrgeräte-/Fehlerbedingungen niemals still verloren, doppelt gezählt oder einem falschen Tag zugeordnet wird.

## Unverletzliche Invarianten

1. **Persist-before-display:** Eine Buchung darf erst in der sichtbaren Projektion erscheinen, nachdem der lokale IndexedDB-Commit erfolgreich war.
2. **Stabile Identität:** Die Event-ID wird beim Tap einmal erzeugt und bei jedem Retry wiederverwendet.
3. **Idempotenz:** Dieselbe Event-ID mit identischem fachlichem Inhalt zählt höchstens einmal.
4. **Konfliktquarantäne:** Dieselbe Event-ID mit abweichendem fachlichem Inhalt wird nicht gezählt, sondern als Konflikt markiert.
5. **Append-only fachlich:** Fachliche Events werden nie überschrieben oder gelöscht. Lokale Sync-Metadaten sind separat veränderbar.
6. **Buchungszeit bleibt fachlich:** Statistiken verwenden `buchungszeit`, nie `serverzeit`.
7. **Keine falsche Grün-Anzeige:** "Synchron" ist nur erlaubt, wenn keine lokalen unbestätigten/rejected Events existieren und der letzte Serverabgleich erfolgreich war.
8. **Retry ohne Duplikat:** Verlorene Serverbestätigung darf keinen zweiten fachlichen Event erzeugen.
9. **Rejected sichtbar:** Endgültig abgelehnte Events bleiben lokal nachvollziehbar, werden aber nicht in die bestätigte Projektion eingerechnet.
10. **Offline korrekt:** Ohne Netz muss weiter gebucht werden können. Andere Geräte dürfen dabei nicht fälschlich als aktuell dargestellt werden.
11. **App-Kill sicher:** Nach erfolgreichem lokalem Commit muss ein Neustart exakt dieselben fachlichen Events rekonstruieren.
12. **Crash vor Commit:** Ein Abbruch vor lokalem Commit darf keinen sichtbaren oder später synchronisierten Event hinterlassen.
13. **Konfiguration versioniert:** Bereits lokal gebuchte Events behalten ihre `konfigVersion`.
14. **Admin-Regeln serverseitig:** INVENTUR, ANFANGSBESTAND und UMBUCHUNG sind serverseitig nicht nur durch UI geschützt.
15. **Keine stille Reparatur:** Unauflösbare Abweichungen werden markiert; niemals wird heimlich ein Bestand "zurechtgesetzt".

## Gate-Struktur

### E2.1 – Lokales Journal
- IndexedDB/Dexie öffnen/schließen/neu öffnen
- atomarer Event-Commit
- Event bleibt nach DB-Neuöffnung vorhanden
- Projektion nach Neustart identisch
- fehlgeschlagener Commit erzeugt keine sichtbare Buchung
- gleiche ID + gleicher Inhalt idempotent
- gleiche ID + anderer Inhalt Konflikt

### E2.2 – Outbox & Retry
- LOCAL_ONLY → PENDING → CONFIRMED
- Netzwerkfehler lässt Event in Outbox
- Retry verwendet dieselbe ID
- verlorene Bestätigung + Serverdokument identisch → CONFIRMED
- Serverdokument abweichend → Konflikt/REJECTED, kein Überschreiben
- exponentieller Retry mit Obergrenze und manueller Sofortprüfung

### E2.3 – Firestore & Security Rules
- create gültig
- update/delete abgelehnt
- fremde UID abgelehnt
- Nicht-ADMIN darf keine Inventur/Anfangsbestand/Umbuchung
- ungültige Deltas abgelehnt
- KORREKTUR nur bei vorhandenem Original mit exakt negiertem Delta
- doppelte Korrektur abgelehnt
- alte gültige `konfigVersion` akzeptiert
- neue unbekannte `konfigVersion` abgelehnt

### E2.4 – 3 Clients & Fault Injection
- drei getrennte lokale Datenbanken/Geräte
- simultane Buchungen
- 50 Offline-Buchungen
- App-Kill/Neustart
- beliebige Empfangsreihenfolge
- verlorene Bestätigung
- offline über Mitternacht
- absichtlich falsche Geräteuhr
- Auth abgelaufen
- Server nicht erreichbar
- Quota-/Permission-Fehler
- identische Prüfcodes nach vollständiger Konvergenz

## Abnahme

E2 ist erst abgeschlossen, wenn E2.1 bis E2.4 jeweils unabhängig grün sind. UI, Statistik und Layout-Editor dürfen die Persistenz-/Sync-Domain danach nur konsumieren, nicht umgehen.
