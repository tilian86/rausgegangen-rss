# Veranstaltungen Tübingen (RSS)

RSS-Feed mit Tübinger Veranstaltungen.

Feed-URL: `https://tilian86.github.io/rausgegangen-rss/feed.xml`

## Quellen

Nur Quellen ohne Anmeldung und Captcha; `robots.txt` wird je Abruf beachtet,
zwischen zwei Abrufen am selben Host liegt eine Pause.

| Quelle | Weg |
| --- | --- |
| [Kulturnetz Tübingen](https://www.tuebinger-kalender.de) | The-Events-Calendar-Schnittstelle (`/wp-json/tribe/events/v1`) |
| [Epplehaus](https://www.epplehaus.de) | wie oben |
| [Club Voltaire](https://club-voltaire.net) | wie oben (Jazzclub, Lesungen, Disco) |
| [Sudhaus](https://sudhaus-tuebingen.de) | Programmseite + Detailseiten (leichtes HTML-Parsen) |
| [Zimmertheater](https://www.zimmertheater-tuebingen.de) | Spielplan-Seite (leichtes HTML-Parsen) |
| [Universität Tübingen](https://uni-tuebingen.de/universitaet/campusleben/veranstaltungen/) | RSS-Feed, nur „Studium Generale" und „Top Termine" |
| [Stadt Tübingen](https://www.tuebingen.de/veranstaltungen) | Großveranstaltungen (Märkte, Festivals), 45 Tage voraus |

Nicht dabei: Landestheater (`robots.txt` sperrt alles), rausgegangen.de
(Botschutz, siehe unten).

## Abwechslung statt Dauerbrenner

- **Dubletten** über mehrere Quellen (gleicher Titel + Tag + Uhrzeit) werden
  zu einer Meldung; die Quelle mit Vorrang (Reihenfolge in `QUELLEN`) gewinnt,
  die andere erscheint als „auch bei …".
- **Reihen** (Stück an 10 Abenden, Stammtisch jeden Monat) werden zu EINER
  Meldung mit „Auch am …"; die Adresse der Meldung bleibt stabil
  (`serien.json` merkt sie sich), damit Feedfunk sie nicht erneut als neu zeigt.
- **Deckel**: je Ort höchstens 4, je Quelle ein eigenes Maximum, je Quelle und
  Tag höchstens 3, und nur die nächsten 14 Tage (Stadt: 45).

## Warum nicht mehr rausgegangen.de?

Bis Juni 2026 wurde `rausgegangen.de/tubingen` abgegriffen. Das ging schief:

1. **Ab 01.06.2026** hatte die Seite ihr HTML geändert. Der Scraper lief grün
   durch, fand aber 0 Veranstaltungen und schrieb einen leeren Feed – drei
   Monate lang, ohne Warnung.
2. **Ab 02.09.2026** steht die Seite hinter Botschutz (Bunny Shield mit
   JavaScript-Rätsel) und antwortet auf Abrufe mit `HTTP 403`.

Punkt 2 ist bewusst gesetzt und wird nicht umgangen. Stattdessen liefern
jetzt Quellen die Daten, die sie ausdrücklich zum Abruf anbieten.

## Absicherung

- Findet der Lauf **0 Veranstaltungen**, bricht er ab und lässt `feed.xml`
  unangetastet. Ein leerer Feed kann nicht mehr unbemerkt entstehen.
- Fällt **eine** Quelle aus, wird der Feed trotzdem gebaut; der Ausfall
  erscheint als Warnung im Lauf, ohne Fehlermail.
- Fallen **alle** Quellen aus, schlägt der Lauf fehl.

Läuft täglich um 4 und 16 Uhr UTC. Manuell: Actions → „Veranstaltungen Tübingen"
→ Run workflow.

## Nebenbei im Repo

`camping-map/` – eigenständige Web-App: offizieller Campingplatz-Lageplan mit
live GPS-Position darauf, offline nutzbar. Siehe
[camping-map/README.md](camping-map/README.md).
