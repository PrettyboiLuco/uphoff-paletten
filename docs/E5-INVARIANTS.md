# E5 Layout-Editor – Invarianten und Testmatrix

Stand: 2026-09-23

## Entscheidung
- Layouts werden zunächst **lokal pro Gerät und Geräteklasse** gespeichert.
- Es gibt getrennte Profile für **PHONE_PORTRAIT** und **IPAD_PORTRAIT**.
- Kritische Buchungslogik, Eventdaten und Bestände sind vollständig unabhängig vom Layout.
- Ein defektes oder ungültiges Layout darf niemals eine Buchung verändern oder löschen.
- Für Phase 1 wird ein eigener kleiner Layout-Engine verwendet statt einer Drag/Resize-Library. Grund: wenige Elemente, klar testbare Regeln, keine zusätzliche Gesture-Abhängigkeit im kritischen Zählbildschirm.

## Invarianten
1. Grid-Snap ist deterministisch.
2. Kein gespeichertes Element darf außerhalb der Layout-Fläche liegen.
3. Elemente dürfen sich nicht überlappen.
4. Mindestgröße wird erzwungen.
5. Gesperrte Elemente können weder verschoben noch skaliert werden.
6. Bearbeitung arbeitet auf einem Draft; **Abbrechen** verändert das gespeicherte Layout nicht.
7. **Speichern** schreibt erst nach vollständiger Validierung.
8. **Standard wiederherstellen** erzeugt exakt das versionierte Default-Layout.
9. PHONE_PORTRAIT und IPAD_PORTRAIT werden separat gespeichert.
10. Layoutdaten sind lokale Darstellungsdaten und niemals Teil eines Paletten-Events.
11. Ungültige gespeicherte Daten fallen auf Default zurück und werden nicht blind angewendet.
12. Touch-/Pointer-Abbruch darf keinen halben Persistenzzustand erzeugen.

## Gate
- E5.1 Engine: Snap, Bounds, Minimum, Overlap, Locked
- E5.2 Persistenz: Save/Load/Cancel/Restore, Profile getrennt
- E5.3 UI: Edit-Mode Bestätigung, Drag, Resize, Save, Cancel, Reset
- E5.4 Browser: WebKit Phone + iPad
