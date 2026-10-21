#!/usr/bin/env python3
"""Earthwire news builder (v2).

Combines two GDELT 2.0 feeds for a rolling window (default 24 h):

* Event exports  - who did what to whom, with the event's geocoded location.
                   Gives the event type (conflict, protest, diplomacy ...) and
                   the countries involved (used for cross-border links).
* Global Knowledge Graph (GKG) - every article GDELT reads, with its themes,
                   the places it mentions, its page title and source language.
                   Gives topics (economy, health, technology ...), real
                   headlines, and news that involves no political "event".

Both are merged into one story per article URL. Outputs:
  site/data/news.json     stories, places, cross-border links, stats
  site/data/history.json  daily counts per country (grows over time)

Standard library only. Environment variables:
  EW_HOURS          rolling window in hours                      (24)
  EW_MAX_STORIES    stories kept in news.json                    (8000)
  EW_PER_PLACE      max stories kept per place                   (40)
  EW_TRANSLINGUAL   include GDELT Translingual feeds             (1)
  EW_GKG            include the Global Knowledge Graph           (1)
  EW_TITLE_FETCH    max article titles fetched from publishers   (200)
  EW_HISTORY_DAYS   days of daily history kept                   (120)
  EW_PREV_URL       base URL of the live site, to continue history
  EW_CACHE          cache directory                              (.cache)
  EW_OUT_DIR        output directory                             (site/data)
  EW_GDELT_BASE     GDELT v2 feed base URL
"""
from __future__ import annotations

import csv
import gzip
import html
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cameo import CATEGORY_IDS, ROOT_TO_CATEGORY, describe  # noqa: E402
from topics import OTHER, TOPIC_IDS, classify  # noqa: E402

csv.field_size_limit(sys.maxsize)

HOURS = float(os.environ.get("EW_HOURS", 24))
MAX_STORIES = int(os.environ.get("EW_MAX_STORIES", 8000))
PER_PLACE = int(os.environ.get("EW_PER_PLACE", 40))
TRANSLINGUAL = os.environ.get("EW_TRANSLINGUAL", "1") == "1"
USE_GKG = os.environ.get("EW_GKG", "1") == "1"
TITLE_FETCH = int(os.environ.get("EW_TITLE_FETCH", 200))
HISTORY_DAYS = int(os.environ.get("EW_HISTORY_DAYS", 120))
PREV_URL = os.environ.get("EW_PREV_URL", "").rstrip("/")
CACHE = Path(os.environ.get("EW_CACHE", ".cache"))
OUT_DIR = Path(os.environ.get("EW_OUT_DIR", "site/data"))
BASE = os.environ.get("EW_GDELT_BASE", "http://data.gdeltproject.org/gdeltv2/")
UA = "Earthwire/2.0 (static news globe; https://github.com)"

TYPES = CATEGORY_IDS + ["general"]          # 6 = article with no coded event
GENERAL = 6
NTYPE, NTOPIC = len(TYPES), len(TOPIC_IDS)

# GDELT 2.0 event export columns
C_A1NAME, C_A1CC, C_A2NAME, C_A2CC = 6, 7, 16, 17
C_ROOTEVENT, C_CODE, C_BASE, C_ROOT = 25, 26, 27, 28
C_GOLD, C_MENTIONS, C_SOURCES, C_ARTICLES, C_TONE = 30, 31, 32, 33, 34
C_GTYPE, C_GNAME, C_GCC, C_GLAT, C_GLON, C_GFEAT = 51, 52, 53, 56, 57, 58
C_ADDED, C_URL = 59, 60
EVENT_COLS = (C_A1NAME, C_A1CC, C_A2NAME, C_A2CC, C_ROOTEVENT, C_CODE, C_BASE, C_ROOT, C_GOLD,
              C_MENTIONS, C_SOURCES, C_ARTICLES, C_TONE, C_GTYPE, C_GNAME, C_GCC, C_GLAT, C_GLON,
              C_GFEAT, C_ADDED, C_URL)

# GKG 2.1 columns
G_DATE, G_COLLECTION, G_URL, G_THEMES, G_THEMES2 = 1, 2, 4, 7, 8
G_LOC1, G_LOC2, G_TONE, G_TRANSLATION, G_EXTRAS = 9, 10, 15, 25, 26

PRECISION = {"1": 1, "2": 2, "5": 2, "3": 3, "4": 3}
LANGS = {"fra": "French", "spa": "Spanish", "deu": "German", "ita": "Italian", "por": "Portuguese",
         "rus": "Russian", "ukr": "Ukrainian", "ara": "Arabic", "zho": "Chinese", "jpn": "Japanese",
         "kor": "Korean", "tur": "Turkish", "fas": "Persian", "hin": "Hindi", "urd": "Urdu",
         "ind": "Indonesian", "vie": "Vietnamese", "tha": "Thai", "pol": "Polish", "nld": "Dutch",
         "swe": "Swedish", "heb": "Hebrew", "ell": "Greek", "ron": "Romanian", "hun": "Hungarian",
         "ces": "Czech", "ben": "Bengali", "tam": "Tamil", "msa": "Malay", "srp": "Serbian",
         "hrv": "Croatian", "bul": "Bulgarian", "fin": "Finnish", "dan": "Danish", "nor": "Norwegian",
         "slk": "Slovak", "slv": "Slovenian", "lit": "Lithuanian", "lav": "Latvian", "est": "Estonian",
         "cat": "Catalan", "aze": "Azerbaijani", "kaz": "Kazakh", "uzb": "Uzbek", "swa": "Swahili",
         "amh": "Amharic", "som": "Somali", "hau": "Hausa", "tgl": "Tagalog", "mar": "Marathi",
         "tel": "Telugu", "guj": "Gujarati", "pan": "Punjabi", "mal": "Malayalam", "kan": "Kannada",
         "sin": "Sinhala", "nep": "Nepali", "mya": "Burmese", "khm": "Khmer", "mon": "Mongolian",
         "kat": "Georgian", "hye": "Armenian", "sqi": "Albanian", "mkd": "Macedonian", "bos": "Bosnian",
         "afr": "Afrikaans", "isl": "Icelandic", "glg": "Galician", "eus": "Basque", "bel": "Belarusian"}


def log(*a):
    print(*a, flush=True)


def ts_of(stamp: str) -> int:
    return int(datetime.strptime(stamp[:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())


# --------------------------------------------------------------------------- download
def http_get(url: str, timeout: int = 60, limit: int | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit) if limit else r.read()


def latest_stamp() -> str:
    text = http_get(BASE + "lastupdate.txt", timeout=30).decode()
    m = re.search(r"(\d{14})\.export\.CSV\.zip", text)
    if not m:
        raise RuntimeError("Could not read GDELT lastupdate.txt")
    return m.group(1)


def zip_lines(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for member in z.namelist():
            with z.open(member) as fh:
                for raw in io.TextIOWrapper(fh, encoding="utf-8", errors="replace", newline="\n"):
                    yield raw.rstrip("\r\n").split("\t")


def reduce_events(data: bytes) -> list[list[str]]:
    out = []
    for row in zip_lines(data):
        if len(row) < 61 or row[C_GTYPE] not in PRECISION:
            continue
        out.append([row[c] for c in EVENT_COLS])
    return out


_TITLE = re.compile(r"<PAGE_TITLE>(.*?)</PAGE_TITLE>", re.S)
_LANG = re.compile(r"srclc:([a-z]{3})")


def primary_location(loc2: str, loc1: str):
    """Pick where a GKG article is 'about': a city mentioned at least twice or
    first, else the most-mentioned country. Returns (type, name, cc, lat, lon, feat)."""
    counts: Counter = Counter()
    info, first = {}, None
    if loc2:
        for i, entry in enumerate(loc2.split(";")):
            f = entry.split("#")
            if len(f) < 8 or f[0] not in PRECISION:
                continue
            key = f[7] or f"{f[5]},{f[6]}"
            counts[key] += 1
            info.setdefault(key, (f[0], f[1], f[2], f[5], f[6], f[7]))
            if first is None:
                first = key
    elif loc1:
        for entry in loc1.split(";"):
            f = entry.split("#")
            if len(f) < 7 or f[0] not in PRECISION:
                continue
            key = f[6] or f"{f[4]},{f[5]}"
            counts[key] += 1
            info.setdefault(key, (f[0], f[1], f[2], f[4], f[5], f[6]))
            if first is None:
                first = key
    if not counts:
        return None
    local = [(k, n) for k, n in counts.items() if PRECISION[info[k][0]] > 1 and (n >= 2 or k == first)]
    if local:
        key = max(local, key=lambda kn: (kn[1] + (0.5 if kn[0] == first else 0), PRECISION[info[kn[0]][0]]))[0]
        return info[key]
    country = Counter()
    for k, n in counts.items():
        if info[k][2]:
            country[info[k][2]] += n
    if not country:
        return None
    cc = country.most_common(1)[0][0]
    for k in counts:
        if info[k][2] == cc and info[k][0] == "1":
            return info[k]
    return None  # no country-level coordinates available


def reduce_gkg(data: bytes) -> list[list[str]]:
    out = []
    for row in zip_lines(data):
        if len(row) < 27 or not row[G_URL].startswith(("http://", "https://")):
            continue
        loc = primary_location(row[G_LOC2], row[G_LOC1])
        if not loc:
            continue
        themes = row[G_THEMES].split(";") if row[G_THEMES] else [t.split(",")[0] for t in row[G_THEMES2].split(";")]
        topics = classify(themes)
        m = _TITLE.search(row[G_EXTRAS])
        title = html.unescape(m.group(1)).strip().replace("\t", " ")[:300] if m else ""
        lm = _LANG.search(row[G_TRANSLATION])
        tone = row[G_TONE].split(",")[0]
        out.append([row[G_URL], row[G_DATE], title, lm.group(1) if lm else "", tone,
                    ",".join(map(str, topics)), *loc])
    return out


def fetch_file(name: str, kind: str) -> Path | None:
    path = CACHE / "gdelt" / (name + ".v2.tsv.gz")
    if path.exists() and path.stat().st_size > 0:
        return path
    for attempt in range(3):
        try:
            data = http_get(BASE + name, timeout=180)
            rows = reduce_events(data) if kind == "events" else reduce_gkg(data)
            tmp = path.with_suffix(".tmp")
            with gzip.open(tmp, "wt", encoding="utf-8") as fh:
                for r in rows:
                    fh.write("\t".join(x.replace("\t", " ").replace("\n", " ") for x in r) + "\n")
            tmp.replace(path)
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except zipfile.BadZipFile:
            return None
        except Exception as e:  # network hiccup: retry
            log(f"  retry {name}: {e}")
        time.sleep(3 * (attempt + 1))
    return None


def download_window(stamps: list[str]):
    (CACHE / "gdelt").mkdir(parents=True, exist_ok=True)
    jobs = []
    for s in stamps:
        jobs.append((f"{s}.export.CSV.zip", "events", False))
        if TRANSLINGUAL:
            jobs.append((f"{s}.translation.export.CSV.zip", "events", True))
        if USE_GKG:
            jobs.append((f"{s}.gkg.csv.zip", "gkg", False))
            if TRANSLINGUAL:
                jobs.append((f"{s}.translation.gkg.csv.zip", "gkg", True))
    cached = sum((CACHE / "gdelt" / (n + ".v2.tsv.gz")).exists() for n, _, _ in jobs)
    log(f"{len(jobs)} files in window, {cached} cached, downloading the rest")
    with ThreadPoolExecutor(6) as pool:
        paths = list(pool.map(lambda j: fetch_file(j[0], j[1]), jobs))
    keep = {n + ".v2.tsv.gz" for n, _, _ in jobs}
    for f in (CACHE / "gdelt").iterdir():
        if f.name not in keep:
            f.unlink(missing_ok=True)
    got = [(p, kind, tl) for p, (_, kind, tl) in zip(paths, jobs) if p]
    log(f"files available: {len(got)} of {len(jobs)}")
    return got, len(jobs)


def read_rows(path: Path):
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            yield line.rstrip("\n").split("\t")


# --------------------------------------------------------------------------- text helpers
def nice_actor(name: str) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    small = {"of", "and", "the", "for", "in", "on", "de", "la", "al"}
    s = " ".join(w if (i and w in small) else w.capitalize() for i, w in enumerate(name.lower().split()))
    for ac in ("Us", "Uk", "Un", "Eu", "Nato", "Fbi", "Cia", "Imf", "Who", "Uae"):
        s = re.sub(rf"\b{ac}\b", ac.upper(), s)
    return s


def domain_of(url: str) -> str:
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def short_place(full: str, prec: int) -> str:
    parts = [p.strip() for p in full.split(",") if p.strip()]
    if len(parts) <= 1:
        return full
    if prec == 2:
        return f"{parts[0]} (region), {parts[-1]}"
    return parts[0] if parts[0] == parts[-1] else f"{parts[0]}, {parts[-1]}"


_ID = re.compile(r"^(?:\d+|[0-9a-f]{8,}|[a-z]?\d{5,}[a-z]?|amp|html?|php|aspx?|index|story|article|news)$", re.I)


def headline_from_slug(url: str) -> str:
    try:
        segs = [urllib.parse.unquote(s) for s in urllib.parse.urlsplit(url).path.split("/") if s]
    except ValueError:
        return ""
    for seg in reversed(segs):
        seg = re.sub(r"\.(s?html?|php|aspx?|cms|ece)$", "", seg, flags=re.I)
        tokens = [t for t in re.split(r"[-_+\s]+", seg) if t and not _ID.match(t)]
        alpha = [t for t in tokens if re.search(r"[^\W\d_]", t)]
        if len(alpha) >= 3 and len(" ".join(tokens)) >= 15:
            text = " ".join(tokens)[:160]
            return text[0].upper() + text[1:]
    return ""


def clean_title(raw: str) -> str:
    t = html.unescape(re.sub(r"\s+", " ", raw)).strip()
    m = re.match(r"^(.{25,}?)\s+[|\-–—:]\s+[^|\-–—]{2,40}$", t)
    return (m.group(1) if m else t)[:220]


BAD_TITLES = ("access denied", "just a moment", "attention required", "403", "404", "page not found",
              "subscribe to read", "are you a robot", "captcha", "error")
_TITLE_RE = [
    re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]*content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']og:title', re.I),
    re.compile(r"<title[^>]*>([^<]{5,400})</title>", re.I),
]


def good_title(t: str) -> bool:
    return bool(t) and len(t) >= 12 and not any(b in t.lower() for b in BAD_TITLES)


def fetch_title(url: str) -> str:
    try:
        data = http_get(url, timeout=7, limit=180_000)
    except Exception:
        return ""
    m = re.search(rb'charset=["\']?([A-Za-z0-9_\-]+)', data[:4000])
    try:
        text = data.decode(m.group(1).decode() if m else "utf-8", errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    for rx in _TITLE_RE:
        mt = rx.search(text)
        if mt:
            t = clean_title(mt.group(1))
            if good_title(t):
                return t
    return ""


def window_counts(age: int) -> tuple[bool, bool]:
    return age <= 3600, age <= 6 * 3600


# --------------------------------------------------------------------------- history
def load_history() -> dict:
    candidates = []
    try:
        candidates.append(json.loads((CACHE / "history.json").read_text()))
    except (OSError, ValueError):
        pass
    if PREV_URL:
        try:
            candidates.append(json.loads(http_get(f"{PREV_URL}/data/history.json?t={int(time.time())}", 30)))
        except Exception as e:
            log(f"no previous history online ({e})")
    candidates = [c for c in candidates if isinstance(c, dict) and c.get("v") == 1]
    if not candidates:
        return {"v": 1, "hours": {}, "days": {}}
    return max(candidates, key=lambda c: (len(c.get("days", {})), c.get("updated", "")))


def update_history(hist: dict, stories: dict, end_ts: int) -> dict:
    """Hours inside the current window are recomputed from scratch; days are the
    sum of their hours while hours are kept (72 h), then frozen."""
    fresh: dict[str, dict[str, list[int]]] = defaultdict(dict)
    start = end_ts - int(HOURS * 3600)
    for st in stories.values():
        if st["ts"] < start:
            continue
        hk = str(st["ts"] // 3600)
        cc = st["cc"] or "??"
        row = fresh[hk].setdefault(cc, [0] * (NTYPE + NTOPIC))
        row[st["type"]] += 1
        for t in st["topics"]:
            row[NTYPE + t] += 1
    hours = hist.get("hours", {})
    for hk in list(hours):
        if int(hk) * 3600 >= start:
            del hours[hk]
    hours.update(fresh)
    cutoff = (end_ts - 72 * 3600) // 3600
    days = hist.get("days", {})
    by_day: dict[str, dict[str, list[int]]] = defaultdict(dict)
    for hk, ccs in hours.items():
        day = datetime.fromtimestamp(int(hk) * 3600, timezone.utc).strftime("%Y-%m-%d")
        for cc, row in ccs.items():
            acc = by_day[day].setdefault(cc, [0] * (NTYPE + NTOPIC))
            for i, v in enumerate(row):
                acc[i] += v
    days.update(by_day)
    hours = {hk: v for hk, v in hours.items() if int(hk) >= cutoff}
    keep_days = sorted(days)[-HISTORY_DAYS:]
    return {"v": 1, "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "types": TYPES, "topics": TOPIC_IDS, "hours": hours, "days": {d: days[d] for d in keep_days}}


# --------------------------------------------------------------------------- build
def build():
    t0 = time.time()
    latest = latest_stamp()
    end_dt = datetime.strptime(latest, "%Y%m%d%H%M%S")
    stamps = [(end_dt - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(int(HOURS * 4))]
    files, expected = download_window(stamps)
    if not any(kind == "events" for _, kind, _ in files):
        raise RuntimeError("No GDELT event files could be downloaded")
    end_ts = ts_of(latest) + 900
    start_ts = end_ts - int(HOURS * 3600)

    # ---- events: best event per URL
    ev: dict[str, dict] = {}
    n_events = 0
    for path, kind, translingual in files:
        if kind != "events":
            continue
        for r in read_rows(path):
            if len(r) < len(EVENT_COLS):
                continue
            n_events += 1
            (a1, a1cc, a2, a2cc, isroot, code, base, root, gold, ments, srcs, arts, tone,
             gtype, gname, gcc, glat, glon, gfeat, added, url) = r[:len(EVENT_COLS)]
            prec = PRECISION.get(gtype)
            cat = ROOT_TO_CATEGORY.get(root.zfill(2)[:2])
            if not prec or cat is None or not url.startswith(("http://", "https://")):
                continue
            try:
                lat, lon = float(glat), float(glon)
                arts_i, srcs_i, ts = int(arts or 0), int(srcs or 0), ts_of(added)
            except ValueError:
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0) or ts < start_ts - 900:
                continue
            rank = (2 if isroot == "1" else 0) + prec * 0.6 + (0.4 if cat <= 2 else 0) + math.log1p(arts_i) * 0.5
            cur = ev.get(url)
            if cur is None or rank > cur["rank"]:
                prev = cur
                cur = ev[url] = {
                    "rank": rank, "prec": prec, "lat": lat, "lon": lon, "cat": cat, "name": gname, "cc": gcc,
                    "feat": gfeat, "a1": a1, "a2": a2, "a1cc": a1cc, "a2cc": a2cc, "code": code, "base": base,
                    "root": root.zfill(2)[:2], "gold": gold, "tone": tone, "tl": translingual,
                    "ts": ts if prev is None else min(ts, prev["ts"]),
                    "arts": arts_i if prev is None else max(arts_i, prev["arts"]),
                    "srcs": srcs_i if prev is None else max(srcs_i, prev["srcs"]),
                }
            else:
                cur["ts"] = min(cur["ts"], ts)
                cur["arts"] = max(cur["arts"], arts_i)
                cur["srcs"] = max(cur["srcs"], srcs_i)
    log(f"events read: {n_events:,}  event stories: {len(ev):,}")

    # ---- GKG: one record per URL
    gk: dict[str, dict] = {}
    for path, kind, translingual in files:
        if kind != "gkg":
            continue
        for r in read_rows(path):
            if len(r) < 12:
                continue
            url, date, title, lang, tone, topics, ltype, lname, lcc, llat, llon, lfeat = r[:12]
            if url in gk:
                continue
            try:
                ts = ts_of(date)
                lat, lon = float(llat), float(llon)
            except ValueError:
                continue
            if ts < start_ts - 900 or (lat == 0 and lon == 0):
                continue
            gk[url] = {"ts": ts, "title": title, "lang": lang or ("und" if translingual else ""), "tone": tone,
                       "topics": [int(t) for t in topics.split(",") if t], "prec": PRECISION.get(ltype, 1),
                       "name": lname, "cc": lcc, "lat": lat, "lon": lon, "feat": lfeat, "tl": translingual}
    log(f"GKG articles: {len(gk):,}")

    # ---- merge into stories
    stories: dict[str, dict] = {}
    for url in set(ev) | set(gk):
        e, g = ev.get(url), gk.get(url)
        src = e or g
        st = {
            "url": url, "ts": min(x["ts"] for x in (e, g) if x), "prec": src["prec"], "lat": src["lat"],
            "lon": src["lon"], "name": src["name"], "cc": src["cc"], "feat": src["feat"],
            "type": e["cat"] if e else GENERAL, "topics": (g["topics"] if g else []) or [OTHER],
            "title": g["title"] if g and good_title(g["title"]) else "",
            "lang": g["lang"] if g else ("und" if e["tl"] else ""),
            "tone": float((e or g)["tone"] or 0), "arts": e["arts"] if e else 0, "srcs": e["srcs"] if e else 0,
            "e": e,
        }
        if st["lang"] in ("eng",):
            st["lang"] = ""
        stories[url] = st
    log(f"stories: {len(stories):,}")

    # ---- places and counts
    places: dict[str, dict] = {}
    for st in stories.values():
        if st["prec"] == 1:
            key = f"C:{st['cc']}"
        else:
            key = f"{st['prec']}:{st['feat'] or '%.3f,%.3f' % (st['lat'], st['lon'])}"
        pl = places.get(key)
        if pl is None:
            pl = places[key] = {"name": st["name"].strip() or st["cc"], "lat": st["lat"], "lon": st["lon"],
                                "cc": st["cc"], "prec": st["prec"], "urls": [],
                                "c": [[0] * NTYPE for _ in range(3)], "t": [[0] * NTOPIC for _ in range(3)]}
        st["place"] = key
        in1, in6 = window_counts(end_ts - st["ts"])
        for w, inside in ((0, in1), (1, in6), (2, True)):
            if inside:
                pl["c"][w][st["type"]] += 1
                for t in st["topics"]:
                    pl["t"][w][t] += 1
        pl["urls"].append(st["url"])

    # ---- scoring and selection
    def score(st):
        recency = 1 - min(1, (end_ts - st["ts"]) / (HOURS * 3600))
        return (math.log1p(st["arts"]) * 2 + math.log1p(st["srcs"]) + recency * 1.5
                + (0.7 if st["type"] <= 2 else 0) + (1.2 if st["title"] else 0) + (0.4 if st["prec"] == 3 else 0))

    for st in stories.values():
        st["score"] = score(st)
    chosen, taken, per_place = [], set(), defaultdict(int)

    def take(url, cap=PER_PLACE):
        if url in taken or len(chosen) >= MAX_STORIES:
            return
        k = stories[url]["place"]
        if per_place[k] >= cap:
            return
        chosen.append(url)
        taken.add(url)
        per_place[k] += 1

    by_size = sorted(places.items(), key=lambda kv: -len(kv[1]["urls"]))
    # 1) newest hour: every place's best story from the last hour
    for key, pl in by_size:
        recent = [u for u in pl["urls"] if end_ts - stories[u]["ts"] <= 3600]
        if recent:
            take(max(recent, key=lambda u: stories[u]["score"]))
        if len(chosen) >= MAX_STORIES * 0.2:
            break
    # 2) every place's best story overall
    for key, pl in by_size:
        take(max(pl["urls"], key=lambda u: stories[u]["score"]))
        if len(chosen) >= MAX_STORIES * 0.55:
            break
    ranked = sorted(stories, key=lambda u: -stories[u]["score"])
    # 3) breadth: a quota for every event type and every topic
    for t in range(NTYPE):
        for u in [u for u in ranked if stories[u]["type"] == t][:180]:
            take(u)
    for t in range(NTOPIC):
        for u in [u for u in ranked if t in stories[u]["topics"]][:180]:
            take(u)
    # 4) fill by score
    for u in ranked:
        if len(chosen) >= MAX_STORIES:
            break
        take(u)

    # ---- publisher titles for English event stories without a GKG title
    tcache_path = CACHE / "titles.json"
    try:
        tcache = json.loads(tcache_path.read_text())
    except (OSError, ValueError):
        tcache = {}
    todo = [u for u in sorted(chosen, key=lambda u: -stories[u]["score"])
            if not stories[u]["title"] and not stories[u]["lang"] and u not in tcache][:TITLE_FETCH]
    if todo:
        log(f"fetching {len(todo)} article titles from publishers")
        with ThreadPoolExecutor(24) as pool:
            for u, t in zip(todo, pool.map(fetch_title, todo)):
                tcache[u] = t
    tcache = {u: t for u, t in tcache.items() if u in stories}
    CACHE.mkdir(parents=True, exist_ok=True)
    tcache_path.write_text(json.dumps(tcache, ensure_ascii=False))

    # ---- cross-border pairs (all stories, event actors from two different countries)
    pairs: dict[tuple, dict] = {}
    for st in stories.values():
        e = st["e"]
        if not e or not e["a1cc"] or not e["a2cc"] or e["a1cc"] == e["a2cc"]:
            continue
        if len(e["a1cc"]) != 3 or len(e["a2cc"]) != 3:
            continue
        k = (e["a1cc"], e["a2cc"])
        p = pairs.setdefault(k, {"n": [0, 0, 0], "types": [0] * NTYPE})
        in1, in6 = window_counts(end_ts - st["ts"])
        p["n"][2] += 1
        p["n"][1] += in6
        p["n"][0] += in1
        p["types"][st["type"]] += 1
    out_pairs = sorted(([a, b, *p["n"], max(range(NTYPE), key=lambda t: p["types"][t])]
                        for (a, b), p in pairs.items()), key=lambda x: -x[4])[:600]

    # ---- output
    place_keys = sorted({stories[u]["place"] for u in chosen}, key=lambda k: -len(places[k]["urls"]))
    pidx = {k: i for i, k in enumerate(place_keys)}
    out_places = [[places[k]["name"], round(places[k]["lat"], 4), round(places[k]["lon"], 4), places[k]["cc"],
                   places[k]["prec"], places[k]["c"], places[k]["t"]] for k in place_keys]
    out_stories = []
    for u in chosen:
        st, e = stories[u], stories[u]["e"]
        place = places[st["place"]]
        where = short_place(place["name"], place["prec"])
        title = st["title"] or tcache.get(u, "")
        item = {"p": pidx[st["place"]], "c": st["type"], "tp": st["topics"], "t": st["ts"], "u": u,
                "d": domain_of(u), "o": round(st["tone"], 1), "n": st["arts"], "s": st["srcs"]}
        if e:
            item.update(a1=nice_actor(e["a1"]), a2=nice_actor(e["a2"]),
                        e=describe(e["code"], e["base"], e["root"]), k=e["code"])
            if e["a1cc"] and e["a2cc"] and e["a1cc"] != e["a2cc"]:
                item["x"] = [e["a1cc"], e["a2cc"]]
        if st["lang"]:
            # Non-English source: keep the original title, write an English summary headline.
            item["lg"] = LANGS.get(st["lang"], "another language") if st["lang"] != "und" else "another language"
            if title:
                item["ot"] = title
            topic = TOPIC_IDS[st["topics"][0]]
            item["h"] = (f"{item['e']} in {where}" if e else
                         (f"News from {where}" if topic == "other" else f"{topic.capitalize()} news from {where}"))
            item["hq"] = 0
        else:
            item["h"] = title or headline_from_slug(u) or (f"{item.get('e', 'News')} in {where}")
            item["hq"] = 1 if title else 0
        out_stories.append(item)
    out_stories.sort(key=lambda s: -s["t"])

    nb = int(math.ceil(HOURS))
    hist = [[0] * nb for _ in range(NTYPE)]
    thist = [[0] * nb for _ in range(NTOPIC)]
    langs, domains, tone_bins = Counter(), Counter(), [0] * 21
    for st in stories.values():
        b = int((end_ts - st["ts"]) // 3600)
        if 0 <= b < nb:
            hist[st["type"]][b] += 1
            for t in st["topics"]:
                thist[t][b] += 1
        langs[LANGS.get(st["lang"], "Other languages") if st["lang"] else "English"] += 1
        domains[domain_of(st["url"])] += 1
        tone_bins[max(0, min(20, int(round(st["tone"])) + 10))] += 1

    result = {
        "v": 2,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end_ts, "hours": HOURS, "latestFile": latest,
        "files": {"expected": expected, "loaded": len(files)},
        "totals": {"events": n_events, "articles": len(gk), "stories": len(stories), "kept": len(out_stories),
                   "places": len(out_places), "allPlaces": len(places), "links": len(pairs)},
        "types": TYPES, "topics": TOPIC_IDS,
        "places": out_places, "stories": out_stories, "pairs": out_pairs,
        "hist": hist, "thist": thist,
        "stats": {"langs": langs.most_common(16), "domains": domains.most_common(20), "tone": tone_bins},
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_json(OUT_DIR / "news.json", result)
    log(f"news.json: {(OUT_DIR / 'news.json').stat().st_size / 1e6:.2f} MB, {len(out_stories)} stories, "
        f"{len(out_places)} places, {len(out_pairs)} links")

    history = update_history(load_history(), stories, end_ts)
    write_json(OUT_DIR / "history.json", history)
    (CACHE / "history.json").write_text(json.dumps(history, separators=(",", ":")))
    log(f"history: {len(history['days'])} days. Done in {time.time() - t0:.0f}s")


def write_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(path)


if __name__ == "__main__":
    build()
