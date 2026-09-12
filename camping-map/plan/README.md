# Standardplan

Was hier liegt, lädt die App beim ersten Start automatisch – ohne dass jemand
etwas auswählen muss. Sie sucht in dieser Reihenfolge:

1. `camping-solaris-map.webp`
2. `camping-solaris-map.pdf`

Also: die Plandatei hier ablegen und exakt so benennen. Beides geht, WebP ist
schneller (kein PDF-Rendern beim Start, kleinere Datei, offline sofort da).

**Per GitHub im Browser:** Repo öffnen → `camping-map/plan/` → *Add file* →
*Upload files* → Datei hineinziehen → *Commit*. Fertig, nach ein bis zwei
Minuten liefert GitHub Pages sie aus.

**PDF in WebP wandeln** (falls zur Hand):

    pdftoppm -r 200 -png camping-solaris-map.pdf plan
    cwebp -q 88 plan-1.png -o camping-solaris-map.webp

Ohne Datei hier startet die App mit dem Willkommensbildschirm: Plan auswählen
(PDF oder Bild) oder von einer Adresse laden. Beides landet nur im Browser des
jeweiligen Geräts, nicht im Repo.

Hinweis: Was hier liegt, ist über GitHub Pages öffentlich abrufbar. Lagepläne
gehören dem Platzbetreiber.
