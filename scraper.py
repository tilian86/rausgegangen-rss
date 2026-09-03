#!/usr/bin/env python3
"""Baut einen RSS-Feed mit Tuebinger Veranstaltungen.

Quellen sind die offiziellen REST-Schnittstellen der Veranstalter
(WordPress-Plugin "The Events Calendar", Endpunkt /wp-json/tribe/events/v1).
Der Tuebinger Kalender des Kulturnetzes ist der Kalender, auf den die Stadt
Tuebingen selbst als externen Veranstaltungskalender verlinkt.

Frueher wurde rausgegangen.de abgegriffen. Das geht seit dem 02.09.2026 nicht
mehr: die Seite steht hinter einem Botschutz und antwortet mit HTTP 403.
"""

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from html import unescape
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# (Anzeigename, Basis-URL) - jede Quelle liefert /wp-json/tribe/events/v1/events
SOURCES = [
    ("Kulturnetz Tübingen", "https://www.kulturnetz-tuebingen.de"),
    ("Epplehaus", "https://www.epplehaus.de"),
]

FEED_URL = "https://tilian86.github.io/rausgegangen-rss/feed.xml"
SITE_URL = "https://www.tuebinger-kalender.de/"
UA = "Mozilla/5.0 (compatible; TuebingenEventsRSS/2.0; +%s)" % FEED_URL

VORSCHAU_TAGE = 90      # wie weit in die Zukunft
MAX_SEITEN = 10         # Sicherheitsnetz gegen Endlosschleifen
BESCHREIBUNG_MAX = 300  # Zeichen

# Bedienelemente aus der Kalender-Seite, die im Beschreibungstext mitkommen
BAUSTEINE = re.compile(
    r"(?i)(Zum Kalender hinzufügen|Google Kalender|iCalendar|Outlook 365|"
    r"Outlook Live|Kalender exportieren|Veranstaltung exportieren|"
    r"Kalender abonnieren|\+ (Google|iCal)\S*)"
)


def fetch_json(url):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def text_aus_html(roh):
    """Macht aus dem HTML-Beschreibungsfeld lesbaren Fliesstext."""
    if not roh:
        return ""
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", roh)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = unescape(text)
    text = BAUSTEINE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.lstrip("–—-|·:,. \u00a0").strip()
    if len(text) > BESCHREIBUNG_MAX:
        schnitt = text[:BESCHREIBUNG_MAX].rsplit(" ", 1)[0]
        text = schnitt + " …"
    return text


def parse_datum(roh):
    """'2026-09-06 16:30:00' -> datetime, sonst None."""
    if not roh:
        return None
    try:
        return datetime.strptime(roh[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def bild_url(event):
    bild = event.get("image")
    if isinstance(bild, dict):
        return bild.get("url") or ""
    return ""


def hole_quelle(name, basis, ab_datum):
    """Holt alle kommenden Veranstaltungen einer Quelle."""
    events = []
    seite = 1
    while seite <= MAX_SEITEN:
        url = (
            f"{basis}/wp-json/tribe/events/v1/events"
            f"?per_page=50&page={seite}&start_date={ab_datum}"
        )
        daten = fetch_json(url)
        stapel = daten.get("events") or []
        if not stapel:
            break
        events.extend(stapel)
        if seite >= int(daten.get("total_pages") or 1):
            break
        seite += 1
    print(f"  {name}: {len(events)} Veranstaltungen")
    return events


def sammle_events():
    """Fragt alle Quellen ab. Gibt (events, fehler) zurueck."""
    heute = datetime.now().strftime("%Y-%m-%d")
    grenze = datetime.now() + timedelta(days=VORSCHAU_TAGE)
    events = []
    gesehen = set()
    fehler = []

    for name, basis in SOURCES:
        try:
            roh = hole_quelle(name, basis, heute)
        except (HTTPError, URLError, ValueError, TimeoutError) as exc:
            fehler.append(f"{name}: {exc}")
            print(f"  {name}: FEHLGESCHLAGEN ({exc})")
            continue

        for event in roh:
            link = event.get("url") or ""
            if not link or link in gesehen:
                continue
            start = parse_datum(event.get("start_date"))
            if start and start > grenze:
                continue
            gesehen.add(link)

            titel = unescape((event.get("title") or "").strip())
            if not titel:
                continue
            ort = ((event.get("venue") or {}) or {}).get("venue") or ""
            ort = unescape(str(ort).strip()) if ort else ""

            teile = []
            if start:
                teile.append(start.strftime("%a, %d.%m.%Y | %H:%M"))
            if ort:
                teile.append(ort)
            teile.append(name)
            kopf = " · ".join(teile)

            rumpf = text_aus_html(event.get("excerpt") or event.get("description"))
            beschreibung = f"{kopf}\n{rumpf}" if rumpf else kopf

            events.append({
                "title": titel,
                "link": link,
                "description": beschreibung,
                "date": start,
                "image": bild_url(event),
            })

    events.sort(key=lambda e: e["date"] or datetime.max)
    return events, fehler


def build_rss(events):
    now = datetime.now(timezone.utc)
    rss = ET.Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")
    rss.set("xmlns:media", "http://search.yahoo.com/mrss/")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Veranstaltungen Tübingen"
    ET.SubElement(channel, "link").text = SITE_URL
    ET.SubElement(channel, "description").text = (
        "Veranstaltungen in Tübingen – Tübinger Kalender "
        "(Kulturnetz) und Epplehaus"
    )
    ET.SubElement(channel, "language").text = "de"
    ET.SubElement(channel, "lastBuildDate").text = now.strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )
    atom_link = ET.SubElement(channel, "atom:link")
    atom_link.set("href", FEED_URL)
    atom_link.set("rel", "self")
    atom_link.set("type", "application/rss+xml")

    for event in events:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = event["title"]
        ET.SubElement(item, "link").text = event["link"]
        ET.SubElement(item, "guid").text = event["link"]
        ET.SubElement(item, "description").text = event["description"]
        if event["image"]:
            enc = ET.SubElement(item, "enclosure")
            enc.set("url", event["image"])
            enc.set("type", "image/jpeg")
            enc.set("length", "0")
            media = ET.SubElement(item, "media:content")
            media.set("url", event["image"])
            media.set("medium", "image")
            media.set("type", "image/jpeg")
        if event["date"]:
            cet = timezone(timedelta(hours=2))
            pub = event["date"].replace(tzinfo=cet)
            ET.SubElement(item, "pubDate").text = pub.strftime(
                "%a, %d %b %Y %H:%M:%S %z"
            )

    tree = ET.ElementTree(rss)
    ET.indent(tree, space="  ")
    return "<?xml version='1.0' encoding='utf-8'?>\n" + ET.tostring(
        rss, encoding="unicode"
    )


def main():
    print("Hole Veranstaltungen:")
    events, fehler = sammle_events()

    if not events:
        raise SystemExit(
            "ABBRUCH: keine einzige Veranstaltung gefunden. feed.xml bleibt "
            "unveraendert. Fehler: " + ("; ".join(fehler) or "keine")
        )
    if len(fehler) == len(SOURCES):
        raise SystemExit("ABBRUCH: alle Quellen fehlgeschlagen: " + "; ".join(fehler))

    with open("feed.xml", "w", encoding="utf-8") as f:
        f.write(build_rss(events))
    print(f"feed.xml geschrieben: {len(events)} Veranstaltungen")

    if fehler:
        # Feed steht trotzdem. Kein harter Fehler, damit nicht bei jedem
        # Wackler eine Mail rausgeht - aber im Lauf sichtbar als Warnung.
        for eintrag in fehler:
            print(f"::warning::Quelle nicht erreichbar - {eintrag}")


if __name__ == "__main__":
    main()
