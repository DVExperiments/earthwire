#!/usr/bin/env python3
"""Build the static geography layers used by the globe.

Run once (or whenever you want to refresh the base geography):

    pip install pillow
    python tools/build_static_data.py

Outputs (all in site/):
  data/countries.json  borders, names, FIPS/ISO codes, label points
  data/cities.json     populated places (search + labels)
  data/air.json        busiest airport-pair routes (OpenFlights)
  data/sea.json        global shipping lanes (CIA / Benden 2022)
  assets/land.png      2048x1024 equirectangular land mask

Sources and licences are listed in README.md.
"""
from __future__ import annotations

import json
import math
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
CACHE = ROOT / ".static-cache"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
SOURCES = {
    "countries": NE + "ne_50m_admin_0_countries.geojson",
    "places": NE + "ne_10m_populated_places_simple.geojson",
    "airports": "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat",
    "routes": "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat",
    "lakes": NE + "ne_10m_lakes.geojson",
    "lanes": "https://raw.githubusercontent.com/newzealandpaul/Shipping-Lanes/main/data/Shipping_Lanes_v1.geojson",
}

# Natural Earth leaves FIPS_10 blank (-99) for a few countries. GDELT uses FIPS 10-4.
FIPS_FIX = {
    "S. Sudan": "OD", "Norway": "NO", "Israel": "IS", "Palestine": "WE",
    "N. Cyprus": "CY", "Somaliland": "SO", "Åland": "FI", "Indian Ocean Ter.": "",
    "Siachen Glacier": "",
}


def fetch(key: str) -> bytes:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / key
    if not path.exists():
        print("downloading", SOURCES[key])
        req = urllib.request.Request(SOURCES[key], headers={"User-Agent": "earthwire-build"})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def perp(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(pts, tol):
    """Iterative Douglas-Peucker."""
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        best, idx = 0.0, -1
        for i in range(s + 1, e):
            d = perp(pts[i], pts[s], pts[e])
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(pts, keep) if k]


def q(v):
    return int(round(v * 100))  # 0.01 degree ~ 1.1 km


def build_countries():
    gj = json.loads(fetch("countries"))
    out = []
    polys_for_mask = []
    for f in gj["features"]:
        p = f["properties"]
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        rings = []
        for poly in polys:
            for ri, ring in enumerate(poly):
                polys_for_mask.append((ring, ri > 0))
                s = simplify(ring, 0.02)
                if len(s) < 4:
                    s = ring  # tiny islands: keep full detail
                if len(s) < 4:
                    continue
                flat = []
                for lon, lat in s:
                    flat += [q(lon), q(lat)]
                rings.append(flat)
        fips = p.get("FIPS_10") or ""
        if fips == "-99" or p["NAME"] in FIPS_FIX:
            fips = FIPS_FIX.get(p["NAME"], "")
        iso2 = p.get("ISO_A2_EH") if p.get("ISO_A2_EH") not in (None, "-99") else ""
        lons = [r[i] for r in rings for i in range(0, len(r), 2)]
        lats = [r[i] for r in rings for i in range(1, len(r), 2)]
        out.append({
            "n": p["NAME"],
            "nl": p.get("NAME_LONG") or p["NAME"],
            "f": fips,
            "i2": iso2,
            "i3": p.get("ADM0_A3"),
            "c": p.get("CONTINENT"),
            "pop": p.get("POP_EST"),
            "lx": round(p.get("LABEL_X"), 2),
            "ly": round(p.get("LABEL_Y"), 2),
            "bb": [min(lons), min(lats), max(lons), max(lats)],
            "r": rings,
        })
    out.sort(key=lambda c: c["n"])
    (SITE / "data/countries.json").write_text(json.dumps(out, separators=(",", ":")))
    print("countries:", len(out), "rings:", sum(len(c["r"]) for c in out))
    return polys_for_mask


def build_land_mask(polys):
    from PIL import Image, ImageDraw, ImageFilter
    W, H = 4096, 2048
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    # Holes in admin-0 polygons are almost always enclaves (e.g. Lesotho) that are
    # themselves countries, so only outer rings are filled.
    for ring, is_hole in polys:
        if is_hole:
            continue
        pts = [((lon + 180) / 360 * W, (90 - lat) / 180 * H) for lon, lat in ring]
        if len(pts) > 2:
            d.polygon(pts, fill=255)
    img = img.resize((2048, 1024), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(0.6))
    img.save(SITE / "assets/land.png", optimize=True)
    print("land mask written")
    clean_population_texture(img)


def clean_population_texture(land):
    """The inherited WorldPop texture stored no-data (ocean, lakes) as 255 and
    bilinear resampling smeared it into coastal pixels. Remove no-data and cap
    every pixel next to it at the brightness of its clean neighbours, so real
    coastal cities stay bright and empty coastlines stop glowing."""
    from PIL import Image, ImageChops, ImageDraw, ImageFilter
    pop_path = SITE / "assets/population-density.png"
    info_path = SITE / "assets/population-density.json"
    if not pop_path.exists() or info_path.exists():
        return  # already cleaned; delete the .json to clean a freshly downloaded texture
    pop = Image.open(pop_path).convert("L")
    W, H = pop.size
    px = pop.load()

    def components(threshold):
        seen = bytearray(W * H)
        for y0 in range(H):
            for x0 in range(W):
                if px[x0, y0] < threshold or seen[y0 * W + x0]:
                    continue
                comp, stack = [], [(x0, y0)]
                seen[y0 * W + x0] = 1
                while stack:
                    x, y = stack.pop()
                    comp.append((x, y))
                    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                        nx %= W
                        if 0 <= ny < H and not seen[ny * W + nx] and px[nx, ny] >= threshold:
                            seen[ny * W + nx] = 1
                            stack.append((nx, ny))
                yield comp

    # 1. No-data mask: sea and Natural Earth lakes.
    nodata = land.resize((W, H), Image.Resampling.BILINEAR).point(lambda v: 255 if v < 128 else 0)
    ld = ImageDraw.Draw(nodata)
    for f in json.loads(fetch("lakes"))["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            pts = [((lon + 180) / 360 * W, (90 - lat) / 180 * H) for lon, lat in poly[0]]
            if len(pts) > 2:
                ld.polygon(pts, fill=255, outline=255)
    pop = ImageChops.subtract(pop, nodata)

    # 2. Pixels within 2 px of no-data are capped by nearby clean pixels.
    near = ImageChops.subtract(nodata.filter(ImageFilter.MaxFilter(5)), nodata)
    clean = ImageChops.subtract(pop, near)
    cap = clean.filter(ImageFilter.MaxFilter(7))
    # Narrow islands have no clean neighbours; give them a moderate ceiling instead.
    has_clean = ImageChops.subtract(Image.new("L", (W, H), 255), near).point(lambda v: 255 if v else 0)
    has_clean = ImageChops.multiply(has_clean, land.resize((W, H)).point(lambda v: 255 if v >= 128 else 0))
    has_clean = has_clean.filter(ImageFilter.MaxFilter(7))
    cap = Image.composite(cap, Image.new("L", (W, H), 175), has_clean)
    capped = ImageChops.darker(pop, cap)
    pop = Image.composite(capped, pop, near)

    # 3. Large saturated inland blobs are lakes missing from Natural Earth (e.g. Aral Sea).
    px = pop.load()
    for comp in list(components(254)):
        if len(comp) > 12:
            for x, y in comp:
                px[x, y] = 0
    # 4. Small very bright blobs in empty surroundings are small lakes, not cities.
    px = pop.load()
    for comp in list(components(200)):
        if len(comp) > 6:
            continue
        ring = [px[(x + dx) % W, y + dy] for x, y in comp for dx in (-2, 0, 2) for dy in (-2, 0, 2)
                if 0 <= y + dy < H and px[(x + dx) % W, y + dy] < 200]
        if ring and sum(ring) / len(ring) < 90:
            for x, y in comp:
                px[x, y] = 0
    pop.save(pop_path, optimize=True)
    info_path.write_text(json.dumps({
        "source": "WorldPop 1 km population density 2020",
        "citation": "WorldPop et al. (2018), Global High Resolution Population Denominators Project, DOI: 10.5258/SOTON/WP00674",
        "license": "CC BY 4.0",
        "encoding": "log1p(density)/log1p(10000) * 255, equirectangular 1440x720",
        "cleaned": "ocean, lake and coastal no-data removed by tools/build_static_data.py",
    }, indent=2) + "\n")
    print("population texture cleaned")


def build_cities():
    gj = json.loads(fetch("places"))
    rows = []
    for f in gj["features"]:
        p = f["properties"]
        pop = int(p.get("pop_max") or 0)
        if pop < 20000 and not p.get("adm0cap"):
            continue
        rows.append([
            p.get("name") or p.get("nameascii"),
            round(p["longitude"], 3), round(p["latitude"], 3),
            pop, p.get("adm0name") or "", p.get("adm1name") or "",
            1 if p.get("adm0cap") else 0,
        ])
    rows.sort(key=lambda r: -r[3])
    (SITE / "data/cities.json").write_text(json.dumps(
        {"fields": ["name", "lon", "lat", "pop", "country", "region", "capital"], "rows": rows},
        separators=(",", ":"), ensure_ascii=False))
    print("cities:", len(rows))


def build_air(limit=1400):
    airports = {}
    import csv, io
    for row in csv.reader(io.StringIO(fetch("airports").decode("utf-8", "replace"))):
        try:
            iata = row[4]
            if len(iata) == 3 and iata != "\\N":
                airports[iata] = (row[2], float(row[6]), float(row[7]))
        except (IndexError, ValueError):
            continue
    pairs = defaultdict(set)
    for row in csv.reader(io.StringIO(fetch("routes").decode("utf-8", "replace"))):
        if len(row) < 5:
            continue
        a, b, airline = row[2], row[4], row[0]
        if a in airports and b in airports and a != b:
            pairs[tuple(sorted((a, b)))].add(airline)
    ranked = sorted(pairs.items(), key=lambda kv: -len(kv[1]))
    # favour long-haul diversity: take busiest, but cap routes per airport
    per_airport = defaultdict(int)
    chosen = []
    for (a, b), al in ranked:
        if per_airport[a] >= 24 or per_airport[b] >= 24:
            continue
        chosen.append((a, b, len(al)))
        per_airport[a] += 1
        per_airport[b] += 1
        if len(chosen) >= limit:
            break
    used = sorted({x for a, b, _ in chosen for x in (a, b)})
    idx = {c: i for i, c in enumerate(used)}
    out = {
        "airports": [[c, airports[c][0], round(airports[c][2], 3), round(airports[c][1], 3)] for c in used],
        "routes": [[idx[a], idx[b], n] for a, b, n in chosen],
    }
    (SITE / "data/air.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print("air routes:", len(chosen), "airports:", len(used))


def build_sea():
    gj = json.loads(fetch("lanes"))
    rank = {"Major": 0, "Middle": 1, "Minor": 2}
    out = []
    for f in gj["features"]:
        t = rank.get(f["properties"].get("Type"), 2)
        for line in f["geometry"]["coordinates"]:
            s = simplify(line, 0.05)
            if len(s) < 2:
                continue
            flat = []
            for lon, lat in s:
                flat += [q(lon), q(lat)]
            out.append([t, flat])
    (SITE / "data/sea.json").write_text(json.dumps(out, separators=(",", ":")))
    print("sea lines:", len(out))


if __name__ == "__main__":
    (SITE / "data").mkdir(parents=True, exist_ok=True)
    (SITE / "assets").mkdir(parents=True, exist_ok=True)
    polys = build_countries()
    build_land_mask(polys)
    build_cities()
    build_air()
    build_sea()
