# Platzkarte – Lageplan mit GPS

Zeigt den **offiziellen Übersichtsplan eines Campingplatzes** und deine
**Live-GPS-Position darauf**. Eine HTML-Seite, keine Abhängigkeiten, offline
nutzbar, alles bleibt auf dem Gerät.

Gebaut, weil es das so nicht gibt: Karten-Apps (Google Maps, Organic Maps,
OsmAnd) zeigen die Position, aber nicht den Plan mit den Parzellennummern;
Resort-Apps zeigen den Plan, aber meist ohne Live-Ortung. Hier läuft beides
übereinander.

## Aufrufen

Nach dem Merge nach `main` über GitHub Pages dieses Repos:

    https://tilian86.github.io/rausgegangen-rss/camping-map/

Auf dem Handy einmal öffnen, dann **zum Home-Bildschirm hinzufügen**
(iOS: Teilen → „Zum Home-Bildschirm“; Android: Menü → „App installieren“).
Danach startet sie wie eine App und läuft ohne Netz.

Lokal ausprobieren (GPS braucht HTTPS oder localhost):

    python3 -m http.server 8765 --directory camping-map
    # http://localhost:8765

## Plan hinterlegen

Liegt in [`plan/`](plan/) eine Datei namens `camping-solaris-map.webp` oder
`camping-solaris-map.pdf`, lädt die App sie **beim ersten Start automatisch** –
niemand muss etwas auswählen. Hochladen geht direkt über GitHub im Browser,
Details in [`plan/README.md`](plan/README.md).

Ohne hinterlegte Datei fragt die App beim ersten Start nach dem Plan:

- **Lageplan auswählen** – PDF oder Bild vom Gerät. PDFs werden im Browser
  gerendert (pdf.js liegt unter `vendor/`, kein CDN, kein Upload).
- **Von einer Adresse laden** – direkter Link auf PDF oder Bild. Klappt nur,
  wenn der fremde Server CORS erlaubt; sonst Datei herunterladen und auswählen.

## Benutzen

1. **Plan laden** – PDF, Foto oder Screenshot des Übersichtsplans (siehe oben).
2. **Kalibrieren** – an einer auf dem Plan erkennbaren Stelle stehen,
   „Kalibrieren“ tippen, die Stelle auf dem Plan antippen. Das Ganze an einer
   zweiten, **möglichst weit entfernten** Stelle wiederholen. Fertig.
   Alternativ ohne vor Ort zu sein: Punkt antippen und die Koordinaten aus
   Google Maps eingeben (`45.2938, 13.5897` oder `45°17'37.7"N 13°35'22.9"E`).
3. **Marker** – Stellplatz, Auto, Strandbar setzen; ein Marker lässt sich als
   Ziel wählen, dann zeigen Entfernung und Pfeil dorthin.

Weitere Kalibrierpunkte machen es genauer: Ab dem dritten Punkt wird auch eine
Verzerrung des Plans ausgeglichen (unterschiedliche Maßstäbe, leichte Scherung),
wie sie gezeichnete Pläne fast immer haben.

## Wie genau ist das?

Die Kalibrierung ist eine affine Abbildung zwischen GPS und Planbild:

- **2 Punkte** → Drehung, Maßstab, Verschiebung. Reicht für saubere,
  maßstäbliche Pläne.
- **ab 3 Punkten** → volle affine Anpassung, Ausgleich per kleinster Quadrate.

Als Gütemaß zeigt die App ab drei Punkten einen **Kontrollfehler**: jeder Punkt
wird einmal weggelassen, aus den übrigen berechnet und mit seiner echten Lage
verglichen. Das ist ehrlicher als der Restfehler, der bei genau drei Punkten
rechnerisch immer null ist und deshalb nichts aussagt. Ein hoher Kontrollfehler
heißt „hier stimmt etwas nicht“ – er zeigt aber nicht zuverlässig, *welcher*
Punkt schuld ist, weil sich ein Fehler über die ganze Lösung verteilt.

Grenzen: Illustrierte Pläne sind oft nicht exakt maßstabsgetreu (verschobene
Gebäude, gestauchte Ränder). Eine affine Abbildung kann das nicht vollständig
korrigieren – rechne im Zweifel mit ein paar Metern Versatz in den Randbereichen.
Dazu kommt die GPS-Genauigkeit selbst (Handy: typisch 5–15 m, unter Bäumen
schlechter); sie steht oben in der Statusleiste.

## Datenschutz und Rechte

Kein Server, keine Konten, kein Tracking. Planbild, Kalibrierung und Marker
liegen in IndexedDB bzw. localStorage des Browsers. Die Position wird nur im
Gerät verarbeitet. „Karte exportieren“ schreibt alles in eine JSON-Datei –
als Backup oder zum Weitergeben an Mitreisende.

Der Lageplan gehört dem Platzbetreiber. Wer ihn in `plan/` ablegt, stellt ihn
über GitHub Pages öffentlich ins Netz – das ist eine bewusste Entscheidung.
Wer das nicht will, lädt den Plan einfach in der App: er bleibt dann im Browser
des Geräts. Auch die exportierte JSON-Datei enthält das Bild.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | Aufbau der Oberfläche |
| `app.css` | Darstellung |
| `app.js` | Kalibrier-Mathematik, Karte, GPS, Speicherung |
| `sw.js` | Service Worker für den Offline-Betrieb |
| `manifest.webmanifest` | Installierbarkeit als App |
| `plan/` | Ablage für den Standardplan, der automatisch geladen wird |
| `vendor/` | pdf.js (Apache-2.0), damit PDFs ohne CDN gelesen werden |
| `test/math.test.mjs` | Tests für Projektion, Kalibrierung, Koordinaten-Parser |
| `test/browser.test.mjs` | End-to-End-Test mit echtem Browser und gemocktem GPS |
| `test/demo-plan.png` | erfundener Plan zum Ausprobieren |

## Tests

    node --test camping-map/test/math.test.mjs

    npm i playwright
    python3 -m http.server 8765 --directory camping-map &
    node camping-map/test/browser.test.mjs
