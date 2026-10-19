#!/usr/bin/env python3
"""Earthwire news builder.

Downloads the GDELT 2.0 event exports for a rolling window (default 24 h),
de-duplicates them into one story per article URL, places each story at the
coordinates GDELT geocoded for the event, and writes a compact JSON file that
the static site loads.

Standard library only. Configuration through environment variables:

  EW_HOURS            rolling window in hours                       (24)
  EW_MAX_STORIES      stories kept in the output                    (6000)
  EW_PER_PLACE        max stories kept per place                    (40)
  EW_TRANSLINGUAL     1 = include GDELT Translingual (65 languages)  (1)
  EW_TITLE_FETCH      max new article titles fetched per run         (350)
  EW_CACHE            cache directory                                (.cache)
  EW_OUT              output file                       (site/data/news.json)
  EW_GDELT_BASE       base URL of the GDELT v2 feed
                      (http://data.gdeltproject.org/gdeltv2/)
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
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cameo import CATEGORY_IDS, ROOT_TO_CATEGORY, describe  # noqa: E402

csv.field_size_limit(10_000_000)

HOURS = float(os.environ.get("EW_HOURS", 24))
MAX_STORIES = int(os.environ.get("EW_MAX_STORIES", 6000))
PER_PLACE = int(os.environ.get("EW_PER_PLACE", 40))
TRANSLINGUAL = os.environ.get("EW_TRANSLINGUAL", "1") == "1"
TITLE_FETCH = int(os.environ.get("EW_TITLE_FETCH", 350))
CACHE = Path(os.environ.get("EW_CACHE", ".cache"))
OUT = Path(os.environ.get("EW_OUT", "site/data/news.json"))
BASE = os.environ.get("EW_GDELT_BASE", "http://data.gdeltproject.org/gdeltv2/")
UA = "Earthwire/1.0 (+https://github.com; static news globe; contact via repository)"
NCAT = len(CATEGORY_IDS)

# GDELT 2.0 event export columns (61 per row)
C_ID, C_A1NAME, C_A2NAME = 0, 6, 16
C_ROOTEVENT, C_CODE, C_BASE, C_ROOT, C_QUAD = 25, 26, 27, 28, 29
C_GOLD, C_MENTIONS, C_SOURCES, C_ARTICLES, C_TONE = 30, 31, 32, 33, 34
C_GTYPE, C_GNAME, C_GCC, C_GADM1, C_GLAT, C_GLON, C_GFEAT = 51, 52, 53, 54, 56, 57, 58
C_ADDED, C_URL = 59, 60

# ActionGeo_Type -> precision: 1 country, 2 region (state/province), 3 city/landmark
PRECISION = {"1": 1, "2": 2, "5": 2, "3": 3, "4": 3}


def log(*a):
    print(*a, flush=True)


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


def stamps_back_from(latest: str, hours: float) -> list[str]:
    end = datetime.strptime(latest, "%Y%m%d%H%M%S")
    n = int(hours * 4)
    return [(end - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S") for i in range(n)]


KEEP_COLS = (C_A1NAME, C_A2NAME, C_ROOTEVENT, C_CODE, C_BASE, C_ROOT, C_GOLD, C_MENTIONS, C_SOURCES,
             C_ARTICLES, C_TONE, C_GTYPE, C_GNAME, C_GCC, C_GLAT, C_GLON, C_GFEAT, C_ADDED, C_URL)


def reduce_zip(data: bytes) -> bytes:
    """Keep only geocoded rows and the columns Earthwire uses; returns gzip'd TSV."""
    out = io.StringIO()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for member in z.namelist():
            with z.open(member) as fh:
                text = io.TextIOWrapper(fh, encoding="utf-8", errors="replace", newline="")
                for row in csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE):
                    if len(row) < 61 or row[C_GTYPE] not in PRECISION:
                        continue
                    slim = [""] * 61
                    for c in KEEP_COLS:
                        slim[c] = row[c].replace("\t", " ").replace("\n", " ")
                    out.write("\t".join(slim) + "\n")
    return gzip.compress(out.getvalue().encode("utf-8"), 6)


def fetch_file(name: str) -> Path | None:
    path = CACHE / "gdelt" / (name + ".tsv.gz")
    if path.exists() and path.stat().st_size > 0:
        return path
    for attempt in range(3):
        try:
            data = http_get(BASE + name, timeout=90)
            path.write_bytes(reduce_zip(data))
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except zipfile.BadZipFile:
            return None
        except Exception:  # network hiccup, retry
            pass
        time.sleep(2 * (attempt + 1))
    return None


def download_window(stamps: list[str]) -> list[tuple[Path, bool]]:
    (CACHE / "gdelt").mkdir(parents=True, exist_ok=True)
    names = [(f"{s}.export.CSV.zip", False) for s in stamps]
    if TRANSLINGUAL:
        names += [(f"{s}.translation.export.CSV.zip", True) for s in stamps]
    cached = sum((CACHE / "gdelt" / (n + ".tsv.gz")).exists() for n, _ in names)
    with ThreadPoolExecutor(6) as pool:
        paths = list(pool.map(lambda n: fetch_file(n[0]), names))
    got = [(p, tl) for p, (_, tl) in zip(paths, names) if p]
    keep = {n + ".tsv.gz" for n, _ in names}
    for f in (CACHE / "gdelt").iterdir():
        if f.name not in keep:
            f.unlink(missing_ok=True)
    log(f"files: {len(got)} of {len(names)} available ({cached} from cache)")
    return got


def read_rows(path: Path):
    with gzip.open(path, "rt", encoding="utf-8", errors="replace", newline="") as fh:
        for line in fh:
            row = line.rstrip("\n").split("\t")
            if len(row) >= 61:
                yield row


# --------------------------------------------------------------------------- text helpers
def nice_actor(name: str) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    small = {"of", "and", "the", "for", "in", "on", "de", "la", "al"}
    words = name.lower().split()
    out = [w if (i and w in small) else w.capitalize() for i, w in enumerate(words)]
    s = " ".join(out)
    for ac in ("Us", "Uk", "Un", "Eu", "Nato", "Fbi", "Cia", "Imf", "Who", "Uae"):
        s = re.sub(rf"\b{ac}\b", ac.upper(), s)
    return s


def domain_of(url: str) -> str:
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


_ID = re.compile(r"^(?:\d+|[0-9a-f]{8,}|[a-z]?\d{5,}[a-z]?|amp|html?|php|aspx?|index|story|article|news)$", re.I)


def headline_from_slug(url: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return ""
    segs = [urllib.parse.unquote(s) for s in parts.path.split("/") if s]
    for seg in reversed(segs):
        seg = re.sub(r"\.(s?html?|php|aspx?|cms|ece)$", "", seg, flags=re.I)
        tokens = [t for t in re.split(r"[-_+\s]+", seg) if t]
        tokens = [t for t in tokens if not _ID.match(t)]
        alpha = [t for t in tokens if re.search(r"[^\W\d_]", t)]
        if len(alpha) >= 3 and len(" ".join(tokens)) >= 15:
            text = " ".join(tokens)[:160]
            return text[0].upper() + text[1:]
    return ""


def clean_title(raw: str, domain: str) -> str:
    t = html.unescape(re.sub(r"\s+", " ", raw)).strip()
    # strip trailing " | Site Name" / " - Site Name" when the rest is long enough
    m = re.match(r"^(.{25,}?)\s+[|\-–—:]\s+[^|\-–—]{2,40}$", t)
    if m:
        t = m.group(1)
    return t[:220]


_TITLE_RE = [
    re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]*content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']og:title', re.I),
    re.compile(r"<title[^>]*>([^<]{5,400})</title>", re.I),
]


def fetch_title(url: str) -> str:
    try:
        data = http_get(url, timeout=7, limit=180_000)
    except Exception:
        return ""
    m = re.search(rb'charset=["\']?([A-Za-z0-9_\-]+)', data[:4000])
    enc = m.group(1).decode() if m else "utf-8"
    try:
        text = data.decode(enc, errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    for rx in _TITLE_RE:
        mt = rx.search(text)
        if mt:
            t = clean_title(mt.group(1), domain_of(url))
            bad = ("access denied", "just a moment", "attention required", "403", "404", "page not found",
                   "subscribe to read", "are you a robot", "captcha")
            if t and not any(b in t.lower() for b in bad):
                return t
    return ""


# --------------------------------------------------------------------------- build
def build():
    t0 = time.time()
    latest = latest_stamp()
    stamps = stamps_back_from(latest, HOURS)
    files = download_window(stamps)
    if not files:
        raise RuntimeError("No GDELT files could be downloaded")

    end = datetime.strptime(latest, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc) + timedelta(minutes=15)
    end_ts = int(end.timestamp())
    start_ts = end_ts - int(HOURS * 3600)

    best: dict[str, dict] = {}       # url -> chosen event
    n_events = 0
    for path, translingual in files:
        for r in read_rows(path):
            n_events += 1
            url = r[C_URL].strip()
            if not url.startswith(("http://", "https://")):
                continue
            gtype = r[C_GTYPE]
            prec = PRECISION.get(gtype)
            if not prec:
                continue
            try:
                lat, lon = float(r[C_GLAT]), float(r[C_GLON])
            except ValueError:
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
                continue
            root = r[C_ROOT].zfill(2)[:2]
            cat = ROOT_TO_CATEGORY.get(root)
            if cat is None:
                continue
            try:
                arts = int(r[C_ARTICLES] or 0)
                srcs = int(r[C_SOURCES] or 0)
                ments = int(r[C_MENTIONS] or 0)
                ts = int(datetime.strptime(r[C_ADDED], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())
            except ValueError:
                continue
            if ts < start_ts - 900:
                continue
            is_root = r[C_ROOTEVENT] == "1"
            # prefer: root event, precise location, conflict-ish over statements, more coverage
            rank = (2 if is_root else 0) + prec * 0.6 + (0.4 if cat <= 2 else 0) + math.log1p(arts) * 0.5
            cur = best.get(url)
            if cur is None:
                best[url] = {
                    "rank": rank, "row": r, "prec": prec, "lat": lat, "lon": lon, "cat": cat,
                    "ts": ts, "arts": arts, "srcs": srcs, "ments": ments, "tl": translingual,
                }
            else:
                cur["ts"] = min(cur["ts"], ts)
                cur["arts"] = max(cur["arts"], arts)
                cur["srcs"] = max(cur["srcs"], srcs)
                cur["ments"] = max(cur["ments"], ments)
                if rank > cur["rank"]:
                    cur.update(rank=rank, row=r, prec=prec, lat=lat, lon=lon, cat=cat)
    log(f"events read: {n_events:,}  unique stories: {len(best):,}")

    # ---- places
    places: dict[str, dict] = {}
    for url, ev in best.items():
        r = ev["row"]
        if ev["prec"] == 1:
            key = "C:" + r[C_GCC]
        else:
            key = r[C_GFEAT] or f"{ev['lat']:.3f},{ev['lon']:.3f}"
            key = f"{ev['prec']}:{key}"
        pl = places.get(key)
        if pl is None:
            pl = places[key] = {
                "name": r[C_GNAME].strip() or r[C_GCC], "lat": ev["lat"], "lon": ev["lon"],
                "cc": r[C_GCC], "prec": ev["prec"],
                "c1": [0] * NCAT, "c6": [0] * NCAT, "c24": [0] * NCAT, "urls": [],
            }
        age = end_ts - ev["ts"]
        pl["c24"][ev["cat"]] += 1
        if age <= 6 * 3600:
            pl["c6"][ev["cat"]] += 1
        if age <= 3600:
            pl["c1"][ev["cat"]] += 1
        pl["urls"].append(url)
        ev["place"] = key

    # ---- story scoring and selection (geographic breadth first, then weight)
    def score(ev):
        recency = 1 - min(1, (end_ts - ev["ts"]) / (HOURS * 3600))
        return math.log1p(ev["arts"]) * 2 + math.log1p(ev["srcs"]) + recency * 1.5 + (0.7 if ev["cat"] <= 2 else 0)

    for ev in best.values():
        ev["score"] = score(ev)
    chosen: list[str] = []
    per_place = defaultdict(int)
    # 1) one top story for every place (busiest places first)
    for key, pl in sorted(places.items(), key=lambda kv: -sum(kv[1]["c24"])):
        top = max(pl["urls"], key=lambda u: best[u]["score"])
        chosen.append(top)
        per_place[key] += 1
        if len(chosen) >= MAX_STORIES * 0.55:
            break
    taken = set(chosen)
    # 2) fill by score with a per-place cap
    for url in sorted(best, key=lambda u: -best[u]["score"]):
        if len(chosen) >= MAX_STORIES:
            break
        if url in taken:
            continue
        key = best[url]["place"]
        if per_place[key] >= PER_PLACE:
            continue
        chosen.append(url)
        taken.add(url)
        per_place[key] += 1

    # ---- titles (cached between runs)
    tcache_path = CACHE / "titles.json"
    try:
        tcache = json.loads(tcache_path.read_text())
    except (OSError, ValueError):
        tcache = {}
    todo = [u for u in sorted(chosen, key=lambda u: -best[u]["score"]) if u not in tcache][:TITLE_FETCH]
    if todo:
        log(f"fetching {len(todo)} article titles")
        with ThreadPoolExecutor(24) as pool:
            for u, t in zip(todo, pool.map(fetch_title, todo)):
                tcache[u] = t
    tcache = {u: t for u, t in tcache.items() if u in best}
    tcache_path.write_text(json.dumps(tcache, ensure_ascii=False))

    # ---- output
    place_keys = sorted({best[u]["place"] for u in chosen}, key=lambda k: -sum(places[k]["c24"]))
    pidx = {k: i for i, k in enumerate(place_keys)}
    out_places = []
    for k in place_keys:
        p = places[k]
        out_places.append([p["name"], round(p["lat"], 4), round(p["lon"], 4), p["cc"], p["prec"],
                           p["c1"], p["c6"], p["c24"]])
    stories = []
    for u in chosen:
        ev = best[u]
        r = ev["row"]
        a1, a2 = nice_actor(r[C_A1NAME]), nice_actor(r[C_A2NAME])
        title = tcache.get(u) or ""
        stories.append({
            "p": pidx[ev["place"]], "c": ev["cat"], "t": ev["ts"], "u": u,
            "h": title or headline_from_slug(u), "hq": 1 if title else 0,
            "d": domain_of(u), "a1": a1, "a2": a2,
            "e": describe(r[C_CODE], r[C_BASE], r[C_ROOT].zfill(2)[:2]),
            "g": round(float(r[C_GOLD] or 0), 1), "o": round(float(r[C_TONE] or 0), 1),
            "n": ev["arts"], "s": ev["srcs"], "k": r[C_CODE], "l": 1 if ev["tl"] else 0,
        })
    stories.sort(key=lambda s: -s["t"])

    hist = [[0] * int(math.ceil(HOURS)) for _ in range(NCAT)]
    for ev in best.values():
        b = int((end_ts - ev["ts"]) // 3600)
        if 0 <= b < len(hist[0]):
            hist[ev["cat"]][b] += 1

    result = {
        "v": 1,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end_ts, "hours": HOURS, "latestFile": latest,
        "files": {"expected": len(stamps) * (2 if TRANSLINGUAL else 1), "loaded": len(files)},
        "totals": {"events": n_events, "stories": len(best), "kept": len(stories), "places": len(out_places),
                   "allPlaces": len(places)},
        "categories": CATEGORY_IDS,
        "places": out_places,
        "stories": stories,
        "hist": hist,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
    tmp.replace(OUT)
    log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB) "
        f"stories={len(stories)} places={len(out_places)} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    build()
