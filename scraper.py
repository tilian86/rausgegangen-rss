#!/usr/bin/env python3
"""Scrape rausgegangen.de/tubingen and generate an RSS feed with images."""

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from html import unescape
from urllib.request import Request, urlopen

URL = (
    "https://rausgegangen.de/tubingen/"
    "?lat=48.5236164&lng=9.0535531&city=tubingen&geospatial_query_type=CITY"
)
FEED_URL = "https://tilian86.github.io/rausgegangen-rss/feed.xml"
SITE_URL = "https://rausgegangen.de/tubingen/"
UA = "Mozilla/5.0 (compatible; RausggegangenRSS/1.0)"

MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mär": 3, "Apr": 4, "Mai": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Okt": 10, "Nov": 11, "Dez": 12,
}


def fetch_html():
    req = Request(URL, headers={"User-Agent": UA})
    return urlopen(req, timeout=30).read().decode("utf-8")


def parse_german_date(raw):
    raw = raw.strip()
    m = re.match(
        r"(?:Heute|Morgen|Mo|Di|Mi|Do|Fr|Sa|So),?\s*"
        r"(\d{1,2})\.\s*(\w{3})\s*\|\s*(\d{1,2}):(\d{2})",
        raw,
    )
    if not m:
        return None
    day = int(m.group(1))
    month = MONTH_MAP.get(m.group(2))
    hour = int(m.group(3))
    minute = int(m.group(4))
    if not month:
        return None
    now = datetime.now()
    year = now.year
    candidate = datetime(year, month, day, hour, minute)
    if candidate < now - timedelta(days=180):
        candidate = datetime(year + 1, month, day, hour, minute)
    return candidate


def scrape_events(html):
    events = []
    seen = set()

    # First pass: collect image URLs per event link
    images = {}
    for m in re.finditer(r'class="event-tile[^"]*"[^>]*href="(/events/[^"]+)"', html):
        link = m.group(1)
        if link in images:
            continue
        ctx = html[m.start():m.start()+2000]
        img_m = re.search(r'<img src="(https://imageflow\.rausgegangen\.de/[^"]+)"', ctx)
        if img_m:
            images[link] = img_m.group(1).replace("&amp;", "&")

    # Second pass: extract full event data from desktop text blocks
    blocks = re.findall(
        r'href="(/events/[^"]+)".*?'
        r'<span class="text-sm">([^<]+)</span>.*?'
        r'<h4[^>]*>([^<]+)</h4>.*?'
        r'opacity-70 truncate">([^<]+)<',
        html,
        re.DOTALL,
    )
    for link, date_raw, title, location in blocks:
        if link in seen:
            continue
        seen.add(link)
        title = unescape(title.strip())
        location = unescape(location.strip())
        date_raw = date_raw.strip()
        parsed_date = parse_german_date(date_raw)
        full_link = "https://rausgegangen.de" + link
        desc_parts = [date_raw]
        if location:
            desc_parts.append(location)
        description = " \u00b7 ".join(desc_parts)
        events.append({
            "title": title, "link": full_link,
            "description": description, "date": parsed_date,
            "image": images.get(link, ""),
        })
    return events


def build_rss(events):
    now = datetime.now(timezone.utc)
    rss = ET.Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")
    rss.set("xmlns:media", "http://search.yahoo.com/mrss/")
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Rausgegangen T\u00fcbingen"
    ET.SubElement(channel, "link").text = SITE_URL
    ET.SubElement(channel, "description").text = (
        "Veranstaltungen in T\u00fcbingen via rausgegangen.de"
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
            cet = timezone(timedelta(hours=1))
            pub = event["date"].replace(tzinfo=cet)
            ET.SubElement(item, "pubDate").text = pub.strftime(
                "%a, %d %b %Y %H:%M:%S %z"
            )
    tree = ET.ElementTree(rss)
    ET.indent(tree, space="  ")
    xml_decl = "<?xml version='1.0' encoding='utf-8'?>\n"
    return xml_decl + ET.tostring(rss, encoding="unicode")


def main():
    html = fetch_html()
    events = scrape_events(html)
    rss_xml = build_rss(events)
    with open("feed.xml", "w", encoding="utf-8") as f:
        f.write(rss_xml)
    print(f"Generated feed.xml with {len(events)} events")


if __name__ == "__main__":
    main()
