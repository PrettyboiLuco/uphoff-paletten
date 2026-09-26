# E3 Statistik – Invarianten und Testmatrix

Stand: 2026-09-23

## Ziel
E3 beweist, dass Statistik und Bestandsverlauf ausschließlich aus dem append-only Eventlog abgeleitet werden und bei Zeitzonen-, DST-, Jahreswechsel- und Korrektur-Fällen exakt bleiben.

## Unverletzliche Regeln
1. Fachliche Zeit ist immer `buchungszeit` in Europe/Berlin.
2. `serverzeit` dient nur Audit/Reihenfolge, nie der Statistik.
3. Dazugekommen = Summe der ZUGANG-deltas im Zeitraum.
4. Weggekommen = -Summe der ABGANG-deltas im Zeitraum.
5. KORREKTUR wird der Art und dem Zeitraum des Originals zugerechnet, nicht dem Tag der Stornierung.
6. ANFANGSBESTAND und UMBUCHUNG zählen nicht als Zugang/Abgang.
7. INVENTUR zählt nur als Inventurdifferenz.
8. Bestand ist eine Projektion über alle fachlich wirksamen Events bis zu einem Zeitpunkt.
9. HEUTE folgt dem Kalendertag Europe/Berlin.
10. 4 WOCHEN, 6 MONATE und 1 JAHR werden als kalenderbasierte, halb-offene Intervalle [start, end) berechnet, nicht als feste Millisekunden.
11. ISO-Wochen beginnen Montag; Jahreswechsel und KW 53 müssen korrekt sein.
12. Sommer-/Winterzeit darf weder Events verlieren noch doppelt zählen.
13. Gleiche Event-ID zählt höchstens einmal.
14. REJECTED zählt nicht.
15. Späte Korrektur eines abgeschlossenen Aggregatzeitraums erzeugt eine neue Revision statt eine alte Revision still zu überschreiben.
16. Jede Aggregate-Revision trägt einen Prüfcode aus count + sum je Sorte und kann gegen Rohdaten rekonstruiert werden.

## E3-Gates
- E3.1 Zeitfenster Europe/Berlin
- E3.2 Kennzahlen + Vorperiodenvergleich
- E3.3 Bestandsverlauf und Sorten-Balken
- E3.4 Monats-/Tagesaggregate mit Revisionen
- E3.5 Rohdaten-vs-Aggregat-Konsistenz

## Abnahme
E3 ist nur grün, wenn feste Sollwerte für DST, Jahreswechsel, ISO-Woche, späte Korrektur und Aggregate vollständig reproduzierbar sind.
