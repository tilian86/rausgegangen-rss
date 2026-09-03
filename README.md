# rausgegangen-rss

RSS-Feed für Tübinger Veranstaltungen von rausgegangen.de

Feed-URL: `https://tilian86.github.io/rausgegangen-rss/feed.xml`

## Status: pausiert (Stand 03.09.2026)

Der automatische Lauf ist **abgeschaltet**. Zwei Dinge sind passiert:

1. **Seit 01.06.2026 leer:** rausgegangen.de hat sein HTML geändert. Der
   Scraper lief zwar grün durch, fand aber 0 Veranstaltungen und schrieb
   einen leeren Feed. Das ist niemandem aufgefallen, weil kein Fehler kam.
2. **Seit 02.09.2026 gesperrt:** Die Seite steht hinter Bunny Shield
   (Botschutz mit JavaScript-Rätsel) und antwortet auf einfache Abrufe nur
   noch mit `HTTP 403`. Auch ein normaler Browser-User-Agent kommt nicht
   mehr durch.

Punkt 2 lässt sich nicht sauber umgehen — der Schutz ist bewusst gesetzt.
Wieder einschalten lohnt sich erst, wenn es eine offizielle Quelle gibt
(Feed, API oder Partner-Zugang von rausgegangen.de).

Geprüft und **nicht** vorhanden: `tuebingen.de` bietet nur Presse-, News- und
Bekanntmachungs-Feeds, keinen Veranstaltungsfeed; `tuebingen-info.de` und
`kreis-tuebingen.de` bieten gar keinen.

Der Scraper bricht jetzt mit Fehler ab, wenn er 0 Veranstaltungen findet,
statt stillschweigend einen leeren Feed zu schreiben.

Manuell starten: Actions → „Scrape Rausgegangen Tübingen" → Run workflow.
