# Bilder und Bedienung

Die App hat zwei Hauptseiten: **Zählen** und **Statistik**. Über den Sortennamen auf der Zählseite öffnet sich eine Detailansicht mit Bild, Bestand und Stapelgröße. **Daten** öffnet Sicherung, Berichte, Buchungsprotokoll und gegebenenfalls die Admin-Inventur; **Layout** passt die Anordnung lokal auf dem jeweiligen Gerät an.

## Eigene Bilder ergänzen

Das Standardlogo liegt unter `public/images/uphoff-mark.svg`. Eine eigene quadratische SVG-Datei kann diese Datei ersetzen. Alternativ kann `BRAND_IMAGE_URL` in `src/ui/config.ts` auf einen neuen Pfad unter `public/` zeigen.

Die Standardillustration der Paletten liegt unter `public/images/pallet.svg`. Für echte Sortenfotos:

1. Fotos im Querformat als komprimierte WebP-Dateien unter `public/images/pallets/` ablegen, beispielsweise `europaletten.webp`.
2. Bei der gewünschten Sorte in `src/ui/config.ts` `imageUrl: '/images/pallets/europaletten.webp'` ergänzen. Das ist unabhängig von der Stapelgröße und von gespeicherten Buchungen.
3. `npm run build` und den mobilen Browser-Test ausführen. Eine fehlende Fotodatei fällt automatisch auf die Standardillustration zurück.

Für alle sieben Sorten können eigene Bilder verwendet werden. Fotos gehören als statische App-Dateien ins Repository; sie werden nicht mit Buchungen oder Geräte-IDs in Firestore gespeichert. Vor dem Hochladen prüfen, dass keine Kennzeichen, Personen oder vertraulichen Unterlagen im Bild sichtbar sind.

## Sicherung

**JSON sichern** erstellt eine Datei. Die Anzeige **Sicherung aktuell** erscheint erst nach **Sicherung abgelegt**, wenn die Datei tatsächlich an einem zweiten Ort gespeichert wurde. Der Zielort muss noch festgelegt werden. Die Cloud-Synchronisierung ersetzt diesen externen Export nicht.

## Vor dem Einsatz

Die Entwicklungsansicht erlaubt Testbuchungen nur lokal. In Produktion müssen Cloud-Konfiguration, Gerätefreigabe und identische Stapelkonfiguration funktionieren. Die zwei Seiten lassen sich auf einem kleinen iPhone innerhalb der App scrollen; die Navigation bleibt fest unten. Offline-Buchungen werden lokal gehalten und nach Rückkehr der Verbindung abgeglichen.
