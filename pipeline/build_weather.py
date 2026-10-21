#!/usr/bin/env python3
"""Builds site/data/weather.json: a coarse global grid of current conditions
(temperature, wind, cloud cover, precipitation) from Open-Meteo.

Open-Meteo is free for non-commercial use (about 10,000 location-calls a day),
data CC BY 4.0. A 7.5-degree grid is 1,104 locations, so the grid is only
rebuilt when the published copy is older than EW_WEATHER_MAX_AGE minutes
(default 240, i.e. about 6 refreshes and 6,600 calls a day). Otherwise the
previous file is reused.

Environment: EW_PREV_URL (live site base URL), EW_OUT_DIR (site/data),
EW_WEATHER_STEP (7.5), EW_WEATHER_MAX_AGE (240).
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PREV_URL = os.environ.get("EW_PREV_URL", "").rstrip("/")
OUT = Path(os.environ.get("EW_OUT_DIR", "site/data")) / "weather.json"
STEP = float(os.environ.get("EW_WEATHER_STEP", 7.5))
MAX_AGE = float(os.environ.get("EW_WEATHER_MAX_AGE", 240))
API = "https://api.open-meteo.com/v1/forecast"
UA = "Earthwire/2.0 (static news globe)"


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def previous():
    if not PREV_URL:
        return None
    try:
        return get(f"{PREV_URL}/data/weather.json?t={int(time.time())}", 30)
    except Exception:
        return None


def build():
    prev = previous()
    if prev and prev.get("generated"):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(prev["generated"].replace("Z", "+00:00"))).total_seconds() / 60
        if age < MAX_AGE:
            OUT.write_text(json.dumps(prev, separators=(",", ":")))
            print(f"weather: reusing published grid ({age:.0f} min old)")
            return
    half = STEP / 2
    lats = [round(-90 + half + i * STEP, 3) for i in range(int(180 / STEP))]
    lons = [round(-180 + half + i * STEP, 3) for i in range(int(360 / STEP))]
    pts = [(la, lo) for la in lats for lo in lons]
    fields = ("temperature_2m", "wind_speed_10m", "wind_direction_10m", "cloud_cover", "precipitation")
    vals = {f: [] for f in fields}
    for i in range(0, len(pts), 150):
        chunk = pts[i:i + 150]
        url = (f"{API}?latitude={','.join(str(p[0]) for p in chunk)}&longitude={','.join(str(p[1]) for p in chunk)}"
               f"&current={','.join(fields)}&wind_speed_unit=ms&timezone=GMT")
        for attempt in range(3):
            try:
                data = get(url, 90)
                break
            except Exception as e:
                if attempt == 2:
                    raise
                print("retry", e)
                time.sleep(5 * (attempt + 1))
        data = data if isinstance(data, list) else [data]
        for d in data:
            cur = d.get("current", {})
            for f in fields:
                v = cur.get(f)
                vals[f].append(round(v, 1) if isinstance(v, (int, float)) else None)
        time.sleep(1)
    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Open-Meteo.com (CC BY 4.0)", "step": STEP, "lats": lats, "lons": lons,
        "temp": vals["temperature_2m"], "speed": vals["wind_speed_10m"], "dir": vals["wind_direction_10m"],
        "cloud": vals["cloud_cover"], "precip": vals["precipitation"],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"weather: {len(pts)} points written")


if __name__ == "__main__":
    build()
