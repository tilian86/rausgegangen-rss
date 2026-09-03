# Veranstaltungen Tübingen (RSS)

RSS-Feed mit Tübinger Veranstaltungen.

Feed-URL: `https://tilian86.github.io/rausgegangen-rss/feed.xml`

## Quellen

Der Feed wird aus den **offiziellen Schnittstellen** der Veranstalter gebaut
(WordPress-Plugin „The Events Calendar", Endpunkt `/wp-json/tribe/events/v1`):

| Quelle | Was |
| --- | --- |
| [Tübinger Kalender / Kulturnetz Tübingen](https://www.tuebinger-kalender.de) | Kultur, Vorträge, Kurse – der Kalender, auf den die Stadt Tübingen selbst verlinkt |
| [Epplehaus](https://www.epplehaus.de) | Konzerte, Workshops, Kneipe |

Weitere Quellen lassen sich in `scraper.py` unter `SOURCES` eintragen –
alles, was die gleiche Schnittstelle anbietet, läuft ohne weitere Anpassung
mit.

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

Läuft täglich um 6 und 18 Uhr. Manuell: Actions → „Veranstaltungen Tübingen"
→ Run workflow.
