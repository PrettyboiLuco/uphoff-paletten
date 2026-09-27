# E6 Betrieb, Selbsttest und Backup – Invarianten

Stand: 2026-09-23

## Ziele
E6 macht Fehler sichtbar, prüft den Datenbestand reproduzierbar und ermöglicht eine getestete Wiederherstellung ohne stilles Überschreiben.

## Invarianten
1. JSON-Backup enthält unveränderte Event-IDs und fachliche Eventdaten.
2. Restore ist idempotent: gleicher Inhalt + gleiche ID wird nicht doppelt angelegt.
3. Restore mit gleicher ID und anderem fachlichen Inhalt bricht ab und überschreibt nichts.
4. Restore läuft atomar für Events + Outbox.
5. REJECTED- und Pending-Zustände bleiben im Backup nachvollziehbar.
6. CSV ist ein menschenlesbarer Audit-Export; JSON ist das Wiederherstellungsformat.
7. Ein Selbsttest vergleicht count + sum je Sorte, nicht nur einen UI-Bestand.
8. Pending/Rejected/Conflict verhindern einen falschen grünen Gesamtstatus.
9. Betriebsfehler werden lokal mit Zeitpunkt, Code, Schwere und Kontext protokolliert.
10. Wöchentliche Sicherung ist bei geschlossener PWA nicht garantierbar. Die App prüft deshalb beim Start/Foreground, ob ein externer Backup-Export fällig ist.
11. Der Download allein bestätigt keinen externen Sicherungsort. Erst die manuelle Bestätigung nach dem Ablegen der Datei aktualisiert die Fälligkeit.
11. Lokales Backup allein ist kein Ersatz für eine zweite Kopie außerhalb des Geräts.
12. Importierte Daten werden vor Commit validiert.

## Gate
- E6.1 JSON Export/Restore + Idempotenz + Konfliktabbruch
- E6.2 CSV Audit-Export
- E6.3 lokaler/remote Prüfcode-Selbsttest
- E6.4 Fehlerprotokoll + Backup-Fälligkeit
- E6.5 WebKit Daten-/Backup-Panel
