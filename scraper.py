#!/usr/bin/env python3
"""Baut einen RSS-Feed mit Tuebinger Veranstaltungen.

Quellen (siehe QUELLEN unten):
  - The-Events-Calendar-Schnittstelle (/wp-json/tribe/events/v1): Kulturnetz
    (Tuebinger Kalender), Epplehaus, Club Voltaire
  - RSS der Universitaet Tuebingen (Veranstaltungskalender, nur Studium Generale
    und "Top Termine")
  - Sudhaus und Zimmertheater: Programmseite (leichtes HTML-Parsen)
  - Stadt Tuebingen: die grossen Termine der Uebersichtsseite (Maerkte, Festivals)

Damit der Feed nicht immer dasselbe zeigt:
  1. Gleiche Veranstaltung aus mehreren Quellen -> eine Meldung (Tag + Titel).
  2. Reihen (ein Stueck an 10 Abenden, woechentliche Treffen) -> EINE Meldung
     mit "auch am ...". Die Adresse der Meldung bleibt dabei stabil
     (serien.json), sonst waere sie fuer Feedfunk jedes Mal "neu".
  3. Pro Ort/Quelle hoechstens ein paar Meldungen, naechste zuerst.
  4. Es kommen nur Termine der naechsten Tage in den Feed; weiter entfernte
     rutschen von selbst nach.

Hoeflich: ein normaler User-Agent, robots.txt wird beachtet (Seiten mit
"Disallow: /" wie das Landestheater bleiben draussen), Pause zwischen Abrufen
derselben Seite, der Lauf kommt nur zweimal am Tag.

Frueher wurde rausgegangen.de abgegriffen. Das geht seit dem 02.09.2026 nicht
mehr: die Seite steht hinter einem Botschutz und antwortet mit HTTP 403.
"""

import hashlib
import json
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser
from zoneinfo import ZoneInfo

FEED_URL = "https://tilian86.github.io/rausgegangen-rss/feed.xml"
SITE_URL = "https://www.tuebinger-kalender.de/"
UA = "Mozilla/5.0 (compatible; TuebingenEventsRSS/3.0; +%s)" % FEED_URL
ZEITZONE = ZoneInfo("Europe/Berlin")
SERIEN_DATEI = Path(__file__).with_name("serien.json")

VORSCHAU_TAGE = 90       # so weit schauen die Quellen voraus (Rohdaten)
FEED_TAGE = 14           # so weit voraus kommen Termine in den Feed
SERIEN_TAGE = 120        # so weit voraus werden weitere Termine einer Reihe genannt
MAX_SEITEN = 10          # Sicherheitsnetz gegen Endlosschleifen
BESCHREIBUNG_MAX = 300   # Zeichen
MAX_PRO_ORT = 4          # Meldungen je Veranstaltungsort (eine Reihe zaehlt als eine)
MAX_PRO_QUELLE = 12      # Meldungen je Quelle (Standard, siehe QUELLEN)
MAX_PRO_TAG = 3          # Meldungen je Quelle und Tag (Uni-Tage mit 10 Vortraegen)
PAUSE = 0.6              # Sekunden zwischen zwei Abrufen derselben Seite
SERIEN_VERGESSEN_TAGE = 90

WOCHENTAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
MONATE = {m: i + 1 for i, m in enumerate(
    ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august",
     "september", "oktober", "november", "dezember"])}

# Bedienelemente aus der Kalender-Seite, die im Beschreibungstext mitkommen
BAUSTEINE = re.compile(
    r"(?i)(Zum Kalender hinzufügen|Google Kalender|iCalendar|Outlook 365|"
    r"Outlook Live|Kalender exportieren|Veranstaltung exportieren|"
    r"Kalender abonnieren|\+ (Google|iCal)\S*)"
)


# --------------------------------------------------------------------------
# Abrufen (hoeflich)
# --------------------------------------------------------------------------

_robots = {}
_letzter_abruf = {}


def darf_abrufen(url):
    """Prueft robots.txt der Seite (einmal je Lauf geholt). Unerreichbar = erlaubt."""
    teile = urlparse(url)
    wurzel = f"{teile.scheme}://{teile.netloc}"
    if wurzel not in _robots:
        rp = RobotFileParser()
        try:
            req = Request(wurzel + "/robots.txt", headers={"User-Agent": UA})
            with urlopen(req, timeout=20) as resp:
                rp.parse(resp.read().decode("utf-8", "replace").splitlines())
        except (HTTPError, URLError, TimeoutError, ValueError):
            rp = None
        _robots[wurzel] = rp
    rp = _robots[wurzel]
    return True if rp is None else rp.can_fetch(UA, url)


def abrufen(url, akzeptiere="*/*"):
    """Holt eine Adresse als Text. Wartet vorher kurz und beachtet robots.txt."""
    if not darf_abrufen(url):
        raise ValueError(f"robots.txt verbietet {url}")
    host = urlparse(url).netloc
    warte = _letzter_abruf.get(host, 0) + PAUSE - time.time()
    if warte > 0:
        time.sleep(warte)
    req = Request(url, headers={"User-Agent": UA, "Accept": akzeptiere})
    try:
        with urlopen(req, timeout=30) as resp:
            roh = resp.read()
    finally:
        _letzter_abruf[host] = time.time()
    return roh.decode("utf-8", "replace")


def fetch_json(url):
    return json.loads(abrufen(url, "application/json"))


# --------------------------------------------------------------------------
# Hilfsfunktionen
# --------------------------------------------------------------------------

def text_aus_html(roh, maximum=BESCHREIBUNG_MAX):
    """Macht aus HTML lesbaren Fliesstext."""
    if not roh:
        return ""
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", roh)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = unescape(text)
    text = BAUSTEINE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.lstrip("–—-|·:,.  ").strip()
    if len(text) > maximum:
        schnitt = text[:maximum].rsplit(" ", 1)[0]
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


def ohne_akzente(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


# Woerter, die fuer den Vergleich von Titeln nichts sagen
FUELLWOERTER = {
    "der", "die", "das", "den", "dem", "des", "und", "mit", "im", "in", "am", "an", "zum", "zur",
    "von", "vom", "the", "of", "and", "a", "live", "tour", "konzert", "feat", "ft", "abgesagt",
    "ausverkauft", "tubingen", "tubinger", "ein", "eine",
}


def tokens(titel):
    t = ohne_akzente(unescape(titel or "").lower()).replace("&", " ")
    return [w for w in re.split(r"[^a-z0-9]+", t) if w and w not in FUELLWOERTER]


def schluessel_text(titel):
    """Titel -> kompakter Vergleichstext (ohne Leer- und Satzzeichen, ohne reine Zahlen)."""
    return "".join(w for w in tokens(titel) if not w.isdigit())


def aehnlich(a, b):
    """Zwei Titel meinen dasselbe? Gleiche Woerter oder einer steckt im anderen."""
    ta, tb = set(tokens(a)), set(tokens(b))
    if not ta or not tb:
        return False
    if schluessel_text(a) == schluessel_text(b):
        return True
    gemeinsam = len(ta & tb)
    if gemeinsam / len(ta | tb) >= 0.6:
        return True
    kleiner = min(len(ta), len(tb))
    return kleiner >= 2 and gemeinsam / kleiner >= 0.85


def kurz_datum(d):
    return f"{WOCHENTAGE[d.weekday()]} {d.day:02d}.{d.month:02d}."


def lang_datum(d):
    return f"{WOCHENTAGE[d.weekday()]}, {d.day:02d}.{d.month:02d}.{d.year}"


def event(quelle, titel, link, start, ort="", text="", bild="", ende=None, zeit_bekannt=True,
          zusatz=""):
    return {
        "quelle": quelle, "title": titel, "link": link, "start": start, "ende": ende,
        "ort": ort, "text": text, "bild": bild, "zeit_bekannt": zeit_bekannt,
        "zusatz": zusatz, "auch_bei": [],
    }


# --------------------------------------------------------------------------
# Quellen
# --------------------------------------------------------------------------

def hole_tribe(name, basis, standort=""):
    """The Events Calendar: alle kommenden Veranstaltungen (REST-Schnittstelle)."""
    heute = datetime.now().strftime("%Y-%m-%d")
    roh, seite = [], 1
    while seite <= MAX_SEITEN:
        url = (f"{basis}/wp-json/tribe/events/v1/events"
               f"?per_page=50&page={seite}&start_date={heute}")
        daten = fetch_json(url)
        stapel = daten.get("events") or []
        if not stapel:
            break
        roh.extend(stapel)
        if seite >= int(daten.get("total_pages") or 1):
            break
        seite += 1
    out = []
    for e in roh:
        start = parse_datum(e.get("start_date"))
        titel = unescape((e.get("title") or "").strip())
        if not (e.get("url") and start and titel):
            continue
        ort = ((e.get("venue") or {}) or {}).get("venue") or standort
        bild = e.get("image")
        out.append(event(
            name, titel, e["url"], start, unescape(str(ort).strip()) if ort else "",
            text_aus_html(e.get("excerpt") or e.get("description")),
            bild.get("url", "") if isinstance(bild, dict) else "",
            ende=parse_datum(e.get("end_date")) if not e.get("all_day") else None,
            zeit_bekannt=not e.get("all_day")))
    return out


def hole_uni(name, url):
    """RSS des Veranstaltungskalenders der Uni: nur Studium Generale und 'Top Termine'."""
    wurzel = ET.fromstring(abrufen(url, "application/rss+xml"))
    ns = {"ut": "http://uni-tuebingen.de/ns/event/", "c": "http://purl.org/rss/1.0/modules/content/"}
    out = []
    for it in wurzel.iter("item"):
        kat = [k.text or "" for k in it.findall("category")]
        if not ({"Studium Generale", "Top Termine Startseite"} & set(kat)):
            continue
        titel = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        try:
            start = datetime.strptime(it.findtext("pubDate").strip(), "%a, %d %b %Y %H:%M:%S %z")
            start = start.astimezone(ZEITZONE).replace(tzinfo=None)
        except (ValueError, AttributeError):
            continue
        if not (titel and link):
            continue
        redner = (it.findtext("ut:speaker", namespaces=ns) or "").strip()
        ort = (it.findtext("ut:location", namespaces=ns) or "").strip()
        text = text_aus_html(it.findtext("c:encoded", namespaces=ns) or it.findtext("description") or "")
        if "Studium Generale" in kat:
            zusatz = "Studium Generale"
        else:
            zusatz = ""
        text = " – ".join(t for t in (redner, text) if t)
        out.append(event(name, titel, link, start, unescape(ort), text[:BESCHREIBUNG_MAX],
                         zusatz=zusatz))
    return out


def hole_sudhaus(name, basis="https://sudhaus-tuebingen.de"):
    """Sudhaus: Programmuebersicht (Datum, Titel, Teaser); Einlass und Saal von der Detailseite
    nur fuer Termine, die ohnehin in den Feed kommen."""
    seite = abrufen(f"{basis}/programm/alle.html")
    grenze = date.today() + timedelta(days=FEED_TAGE)
    out = []
    for block in re.split(r'<section class="ym-grid ym-equalize event__item">', seite)[1:]:
        m = re.search(r'event__info">(\d{2})\.(\d{2})\.(\d{4})</span>\s*<a class="event__link" href="([^"]+)"',
                      block)
        titel = re.search(r'<span class="text">(.*?)</span></a></h3>', block, re.S)
        if not (m and titel):
            continue
        tag = date(int(m[3]), int(m[2]), int(m[1]))
        if tag < date.today():
            continue
        titel = text_aus_html(titel[1], 200)
        if re.match(r"(?i)\s*abgesagt", titel):
            continue
        teaser = re.search(r'<div class="teaser">(.*?)</div>', block, re.S)
        bild = re.search(r'<img src="([^"]+)"', block)
        link = urljoin(basis + "/", m[4])
        ort, zeit, text = "Sudhaus Tübingen", None, text_aus_html(teaser[1]) if teaser else ""
        if tag <= grenze:
            try:
                detail = abrufen(link)
                o = re.search(r'class="event__location"><span class="text select">(.*?)</span>', detail, re.S)
                if o:
                    ort = "Sudhaus Tübingen · " + text_aus_html(o[1], 60)
                z = re.search(r'Einlass ab <span class="text timestamp">(\d{1,2}:\d{2})', detail)
                if z:
                    zeit = z[1]
                genres = [text_aus_html(g, 40) for g in re.findall(r'class="event__genre">(.*?)</span>', detail, re.S)]
                lang = re.search(r'class="event__teaser"><span class="text longtext">(.*?)</span>\s*</div>', detail, re.S)
                if lang:
                    text = " – ".join(t for t in (text, text_aus_html(lang[1], 220)) if t)
                if genres:
                    text = ", ".join(genres) + (": " + text if text else "")
            except (HTTPError, URLError, ValueError, TimeoutError):
                pass
        start = datetime.combine(tag, datetime.strptime(zeit, "%H:%M").time()) if zeit else \
            datetime.combine(tag, datetime.min.time())
        out.append(event(name, titel, link, start, ort, text[:BESCHREIBUNG_MAX],
                         urljoin(basis + "/", bild[1]) if bild else "",
                         zeit_bekannt=bool(zeit), zusatz="Einlass" if zeit else ""))
    return out


# Zusaetze hinter dem eigentlichen Stueck-Titel (Zimmertheater)
ZIMMER_ZUSATZ = re.compile(
    r"\s+[-–]\s+|\s*\*|\s+Nachgespräch|\s+Stückeinführung|\s*;|\s+mit Silvesterbuffet", re.I)


def hole_zimmertheater(name, basis="https://www.zimmertheater-tuebingen.de"):
    """Zimmertheater: Terminliste mit schema.org-Zeitangabe je Vorstellung."""
    seite = abrufen(f"{basis}/event")
    out = []
    for block in re.split(r'<div id="event-\d+" class="', seite)[1:]:
        z = re.search(r'<time datetime="([^"]+)"', block)
        a = re.search(r'<a class="zimt-event-title-wrapper" href="([^"]+)">\s*'
                      r'<h2 class="zimt-event-title"[^>]*>(.*?)</h2>', block, re.S)
        if not (z and a):
            continue
        try:
            start = datetime.fromisoformat(z[1]).astimezone(ZEITZONE).replace(tzinfo=None)
        except ValueError:
            continue
        roh = text_aus_html(a[2], 250)
        if re.search(r"(?i)abgesagt", roh):
            continue
        ort = re.search(r"\d{1,2}:\d{2}\s+([^<]+?)\s*</h2>", block)
        zusaetze = []
        for wort in ("Premiere", "Zum letzten Mal", "Nachgespräch"):
            if re.search(wort, roh, re.I):
                zusaetze.append(wort)
        titel = ZIMMER_ZUSATZ.split(roh, 1)[0].strip(" ,-–")
        out.append(event(name, titel, urljoin(basis + "/", a[1]), start,
                         unescape(ort[1]) if ort else "Zimmertheater Tübingen", "",
                         zusatz=", ".join(zusaetze)))
    return out


def hole_stadt(name, url="https://www.tuebingen.de/veranstaltungen"):
    """Stadt Tuebingen: die grossen Termine (Maerkte, Festivals) der Uebersichtsseite."""
    seite = abrufen(url)
    heute = date.today()
    out = []
    for m in re.finditer(r'<a class="kl"[^>]*href="([^"]+)">([^<]+)</a>', seite):
        text = unescape(m[2]).strip()
        d = re.match(r"(\d{1,2})\.\s*(?:(\w+)\s+)?(?:bis|und)\s+(\d{1,2})\.\s*(\w+)\s+(\d{4}):\s*(.+)$", text)
        if d:
            monat_ende = MONATE.get(d[4].lower())
            monat_start = MONATE.get(d[2].lower()) if d[2] else monat_ende
            jahr = int(d[5])
            titel = d[6]
            if not (monat_ende and monat_start):
                continue
            start = date(jahr, monat_start, int(d[1]))
            ende = date(jahr, monat_ende, int(d[3]))
        else:
            d = re.match(r"(\d{1,2})\.\s*(\w+)\s+(\d{4}):\s*(.+)$", text)
            if not (d and MONATE.get(d[2].lower())):
                continue          # z.B. "Juli 2028: Stadtfest" oder Linklisten
            start = ende = date(int(d[3]), MONATE[d[2].lower()], int(d[1]))
            titel = d[4]
        if ende < heute:
            continue
        beginn = datetime.combine(max(start, heute), datetime.min.time())
        out.append(event(name, titel, urljoin(url, m[1]), beginn, "Tübingen",
                         "Mehrtägig" if ende != start else "",
                         ende=datetime.combine(ende, datetime.min.time()), zeit_bekannt=False))
    return out


# (Anzeigename, Abruffunktion, Tage voraus, Meldungen hoechstens)
# Reihenfolge = Vorrang bei Dubletten. Kulturnetz und Epplehaus stehen vorn: ihre
# Adressen waren schon in Feedfunk; bleiben sie bei Dubletten die Adresse der
# Meldung, taucht nichts "neu" wieder auf.
QUELLEN = [
    ("Kulturnetz Tübingen", lambda n: hole_tribe(n, "https://www.kulturnetz-tuebingen.de"), FEED_TAGE, 12),
    ("Epplehaus", lambda n: hole_tribe(n, "https://www.epplehaus.de", "Epplehaus"), FEED_TAGE, 8),
    ("Club Voltaire", lambda n: hole_tribe(n, "https://club-voltaire.net", "Club Voltaire"), FEED_TAGE, 8),
    ("Sudhaus", hole_sudhaus, FEED_TAGE, 8),
    ("Zimmertheater", hole_zimmertheater, FEED_TAGE, 5),
    ("Uni Tübingen", lambda n: hole_uni(
        n, "https://uni-tuebingen.de/universitaet/campusleben/veranstaltungen/veranstaltungskalender/feed.xml"),
     FEED_TAGE, 8),
    ("Stadt Tübingen", hole_stadt, 45, 5),
]


# --------------------------------------------------------------------------
# Dubletten, Reihen, Auswahl
# --------------------------------------------------------------------------

def entdoppeln(events):
    """Dieselbe Veranstaltung aus mehreren Quellen -> ein Eintrag (Vorrang: Reihenfolge der Quellen)."""
    behalten = []
    nach_tag = {}
    for e in events:
        tag = e["start"].date()
        treffer = next((b for b in nach_tag.get(tag, []) if aehnlich(b["title"], e["title"])), None)
        if treffer is None:
            behalten.append(e)
            nach_tag.setdefault(tag, []).append(e)
            continue
        if e["quelle"] != treffer["quelle"] and e["quelle"] not in treffer["auch_bei"]:
            treffer["auch_bei"].append(e["quelle"])
        # Fehlendes aus der Zweitquelle ergaenzen
        if not treffer["bild"] and e["bild"]:
            treffer["bild"] = e["bild"]
        if not treffer["text"] and e["text"]:
            treffer["text"] = e["text"]
        if not treffer["zeit_bekannt"] and e["zeit_bekannt"]:
            treffer["start"], treffer["zeit_bekannt"] = e["start"], True
    return behalten


def lade_serien():
    try:
        return json.loads(SERIEN_DATEI.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def zu_reihen(events, serien):
    """Gleiche Quelle + gleicher Titel an mehreren Tagen = eine Reihe (eine Meldung).

    Rueckgabe: Liste von Meldungen (naechster Termin vorn, weitere in 'weitere').
    Die Adresse stammt aus serien.json, falls es die Reihe schon gab."""
    gruppen = {}
    for e in events:
        key = hashlib.sha1(f"{e['quelle']}|{schluessel_text(e['title'])}".encode()).hexdigest()[:10]
        gruppen.setdefault(key, []).append(e)
    heute = datetime.now(ZEITZONE).date()
    out = []
    for key, mitglieder in gruppen.items():
        mitglieder.sort(key=lambda e: e["start"])
        kommende = [e for e in mitglieder if (e["ende"] or e["start"]).date() >= heute]
        if not kommende:
            continue
        erster = dict(kommende[0])
        erster["key"] = key
        if not erster["ort"]:                      # Ort aus einem anderen Termin der Reihe
            erster["ort"] = next((m["ort"] for m in mitglieder if m["ort"]), "")
        erster["weitere"] = [e["start"].date() for e in kommende[1:]
                             if e["start"].date() != erster["start"].date()
                             and e["start"].date() <= heute + timedelta(days=SERIEN_TAGE)]
        # gemerkte Adresse hat Vorrang: gleiche Reihe = gleiche Meldung in Feedfunk
        gemerkt = serien.get(key)
        erster["link_neu"] = erster["link"]
        if gemerkt:
            erster["link"] = gemerkt["link"]
        out.append(erster)
    return out


def auswaehlen(reihen, grenzen):
    """Nur Termine der naechsten Tage; je Ort, Quelle und Tag gedeckelt, naechste zuerst.
    grenzen: Quelle -> (Tage voraus, Maximum)."""
    heute = datetime.now(ZEITZONE).date()
    reihen = sorted(reihen, key=lambda e: e["start"])
    pro_ort, pro_quelle, pro_tag, gewaehlt = {}, {}, {}, []
    for e in reihen:
        tage, maximum = grenzen.get(e["quelle"], (FEED_TAGE, MAX_PRO_QUELLE))
        if e["start"].date() > heute + timedelta(days=tage):
            continue
        ort = schluessel_text(e["ort"].split(",")[0]) or e["quelle"]
        tag = (e["quelle"], e["start"].date())
        if (pro_ort.get(ort, 0) >= MAX_PRO_ORT or pro_quelle.get(e["quelle"], 0) >= maximum
                or pro_tag.get(tag, 0) >= MAX_PRO_TAG):
            continue
        pro_ort[ort] = pro_ort.get(ort, 0) + 1
        pro_quelle[e["quelle"]] = pro_quelle.get(e["quelle"], 0) + 1
        pro_tag[tag] = pro_tag.get(tag, 0) + 1
        gewaehlt.append(e)
    return gewaehlt


def beschreibung(e):
    d = e["start"]
    kopf = lang_datum(d)
    if e["ende"] and e["ende"].date() != d.date() and not e["zeit_bekannt"]:
        kopf += f" bis {WOCHENTAGE[e['ende'].weekday()]}, {e['ende'].day:02d}.{e['ende'].month:02d}."
    if e["zeit_bekannt"]:
        kopf += f" | {d.strftime('%H:%M')}"
        if e["zusatz"] == "Einlass":
            kopf += " (Einlass)"
    teile = [kopf]
    if e["ort"]:
        teile.append(e["ort"])
    teile.append(e["quelle"])
    if e["auch_bei"]:
        teile.append("auch bei " + ", ".join(e["auch_bei"]))
    erste = " · ".join(teile)
    if e["zusatz"] and e["zusatz"] != "Einlass":
        erste += f" · {e['zusatz']}"
    if e["weitere"]:
        zeigen = [kurz_datum(x) for x in e["weitere"][:5]]
        mehr = f" … ({len(e['weitere']) + 1} Termine)" if len(e["weitere"]) > 5 else ""
        erste += "\nAuch am " + ", ".join(zeigen) + mehr
    zeile2 = ("\n" if "\nAuch am" not in erste else " – ") + e["text"] if e["text"] else ""
    return erste + zeile2


# --------------------------------------------------------------------------
# Hauptablauf
# --------------------------------------------------------------------------

def sammle_events():
    """Fragt alle Quellen ab. Gibt (events, fehler, statistik) zurueck."""
    fehler, roh, statistik = [], [], {}
    for name, hole, _tage, _max in QUELLEN:
        try:
            liste = hole(name)
        except (HTTPError, URLError, ValueError, TimeoutError, ET.ParseError) as exc:
            fehler.append(f"{name}: {exc}")
            print(f"  {name}: FEHLGESCHLAGEN ({exc})")
            continue
        grenze = datetime.now() + timedelta(days=VORSCHAU_TAGE)
        liste = [e for e in liste if e["start"] <= grenze]
        statistik[name] = {"roh": len(liste)}
        print(f"  {name}: {len(liste)} Veranstaltungen")
        roh.extend(liste)
    return roh, fehler, statistik


def baue_auswahl(roh, serien):
    ohne_doppel = entdoppeln(roh)
    reihen = zu_reihen(ohne_doppel, serien)
    grenzen = {name: (tage, maximum) for name, _h, tage, maximum in QUELLEN}
    return ohne_doppel, reihen, auswaehlen(reihen, grenzen)


def build_rss(events):
    now = datetime.now(timezone.utc)
    rss = ET.Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")
    rss.set("xmlns:media", "http://search.yahoo.com/mrss/")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Veranstaltungen Tübingen"
    ET.SubElement(channel, "link").text = SITE_URL
    ET.SubElement(channel, "description").text = (
        "Veranstaltungen in Tübingen – Tübinger Kalender (Kulturnetz), Epplehaus, "
        "Club Voltaire, Sudhaus, Zimmertheater, Universität und Stadt"
    )
    ET.SubElement(channel, "language").text = "de"
    ET.SubElement(channel, "lastBuildDate").text = now.strftime("%a, %d %b %Y %H:%M:%S +0000")
    atom_link = ET.SubElement(channel, "atom:link")
    atom_link.set("href", FEED_URL)
    atom_link.set("rel", "self")
    atom_link.set("type", "application/rss+xml")

    for e in events:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = e["title"]
        ET.SubElement(item, "link").text = e["link"]
        ET.SubElement(item, "guid").text = e["link"]
        ET.SubElement(item, "description").text = beschreibung(e)
        if e["bild"]:
            typ = "image/png" if e["bild"].lower().split("?")[0].endswith(".png") else "image/jpeg"
            enc = ET.SubElement(item, "enclosure")
            enc.set("url", e["bild"])
            enc.set("type", typ)
            enc.set("length", "0")
            media = ET.SubElement(item, "media:content")
            media.set("url", e["bild"])
            media.set("medium", "image")
            media.set("type", typ)
        pub = e["start"].replace(tzinfo=ZEITZONE)
        ET.SubElement(item, "pubDate").text = pub.strftime("%a, %d %b %Y %H:%M:%S %z")

    tree = ET.ElementTree(rss)
    ET.indent(tree, space="  ")
    return "<?xml version='1.0' encoding='utf-8'?>\n" + ET.tostring(rss, encoding="unicode")


def speichere_serien(serien, gewaehlt):
    """Merkt sich die Adresse jeder ausgelieferten Meldung; vergisst alte nach 90 Tagen."""
    heute = datetime.now(ZEITZONE).date().isoformat()
    neu = {k: v for k, v in serien.items()
           if (date.fromisoformat(heute) - date.fromisoformat(v["zuletzt"])).days <= SERIEN_VERGESSEN_TAGE}
    for e in gewaehlt:
        neu[e["key"]] = {"link": e["link"], "titel": e["title"], "zuletzt": heute}
    text = json.dumps(neu, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    if not SERIEN_DATEI.exists() or SERIEN_DATEI.read_text(encoding="utf-8") != text:
        SERIEN_DATEI.write_text(text, encoding="utf-8")


def main():
    print("Hole Veranstaltungen:")
    roh, fehler, _stat = sammle_events()

    if not roh:
        raise SystemExit(
            "ABBRUCH: keine einzige Veranstaltung gefunden. feed.xml bleibt "
            "unveraendert. Fehler: " + ("; ".join(fehler) or "keine")
        )
    if len(fehler) == len(QUELLEN):
        raise SystemExit("ABBRUCH: alle Quellen fehlgeschlagen: " + "; ".join(fehler))

    serien = lade_serien()
    ohne_doppel, reihen, gewaehlt = baue_auswahl(roh, serien)
    if not gewaehlt:
        raise SystemExit("ABBRUCH: nach dem Aussortieren bleibt nichts uebrig. feed.xml bleibt unveraendert.")

    with open("feed.xml", "w", encoding="utf-8") as f:
        f.write(build_rss(gewaehlt))
    speichere_serien(serien, gewaehlt)

    je_quelle = {}
    for e in gewaehlt:
        je_quelle[e["quelle"]] = je_quelle.get(e["quelle"], 0) + 1
    print(f"Roh {len(roh)} -> ohne Dubletten {len(ohne_doppel)} -> Reihen/Orte {len(reihen)} "
          f"-> im Feed {len(gewaehlt)}")
    print("Im Feed je Quelle: " + ", ".join(f"{k} {v}" for k, v in je_quelle.items()))
    print(f"feed.xml geschrieben: {len(gewaehlt)} Veranstaltungen")

    if fehler:
        # Feed steht trotzdem. Kein harter Fehler, damit nicht bei jedem
        # Wackler eine Mail rausgeht - aber im Lauf sichtbar als Warnung.
        for eintrag in fehler:
            print(f"::warning::Quelle nicht erreichbar - {eintrag}")


if __name__ == "__main__":
    main()
