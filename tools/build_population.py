#!/usr/bin/env python3
"""Rebuild site/assets/population-density.png from WorldPop at higher resolution.

Run by the "Rebuild population layer" workflow (Actions tab, manual). Fetches the
WorldPop 2020 1 km population density raster through its public ArcGIS image
service in tiles, treats no-data properly (the cause of the old glowing oceans),
log-scales it and writes an equirectangular PNG. The globe turns it into dots.

    pip install requests numpy pillow rasterio
    python tools/build_population.py            # 0.125 degree (2880 x 1440)
"""
from __future__ import annotations

import io
import json
import math
import os
from pathlib import Path

import numpy as np
import requests
from PIL import Image
from rasterio.io import MemoryFile

SERVICE = "https://worldpop.arcgis.com/arcgis/rest/services/WorldPop_Population_Density_1km/ImageServer/exportImage"
RES = float(os.environ.get("EW_POP_RES", 0.125))      # degrees per pixel
LAT_N, LAT_S = 84.0, -60.0                              # WorldPop coverage
OUT = Path("site/assets/population-density.png")
INFO = Path("site/assets/population-density.json")
TILE = 60                                               # degrees per tile side


def fetch_tile(session, w, s, e, n, px_w, px_h):
    params = {"bbox": f"{w},{s},{e},{n}", "bboxSR": 4326, "imageSR": 4326, "size": f"{px_w},{px_h}",
              "format": "tiff", "pixelType": "F32", "noData": -1, "interpolation": "RSP_BilinearInterpolation",
              "time": "1577836800000", "f": "image"}
    r = session.get(SERVICE, params=params, timeout=180, headers={"User-Agent": "Earthwire population builder"})
    r.raise_for_status()
    if r.content[:4] not in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        raise RuntimeError(f"Expected a TIFF, got {r.headers.get('content-type')}: {r.text[:200]}")
    with MemoryFile(r.content) as mem, mem.open() as ds:
        a = ds.read(1).astype(np.float32)
        if ds.nodata is not None:
            a[a == ds.nodata] = 0
    a[~np.isfinite(a)] = 0
    a[(a < 0) | (a > 200000)] = 0      # no-data sentinels and nonsense values
    return a


def main():
    W, H = int(360 / RES), int(180 / RES)
    full = np.zeros((H, W), dtype=np.float32)
    with requests.Session() as session:
        for w in range(-180, 180, TILE):
            for n in range(int(LAT_N), int(LAT_S), -TILE):
                s = max(LAT_S, n - TILE)
                e = w + TILE
                pw, ph = int(round((e - w) / RES)), int(round((n - s) / RES))
                print(f"tile {w},{s} -> {e},{n} ({pw}x{ph})", flush=True)
                tile = fetch_tile(session, w, s, e, n, pw, ph)
                y0, x0 = int(round((90 - n) / RES)), int(round((w + 180) / RES))
                full[y0:y0 + tile.shape[0], x0:x0 + tile.shape[1]] = tile[:H - y0, :W - x0]
    if np.count_nonzero(full) < 10000:
        raise SystemExit("WorldPop returned almost no data; not overwriting the existing texture.")
    enc = np.uint8(np.clip(np.log1p(full) / math.log1p(10000) * 255, 0, 255))
    Image.fromarray(enc, "L").save(OUT, optimize=True)
    INFO.write_text(json.dumps({
        "source": "WorldPop 1 km population density 2020",
        "citation": "WorldPop et al. (2018), Global High Resolution Population Denominators Project, DOI: 10.5258/SOTON/WP00674",
        "license": "CC BY 4.0", "encoding": f"log1p(density)/log1p(10000) * 255, equirectangular {W}x{H}",
        "cleaned": "no-data removed at source by tools/build_population.py",
    }, indent=2) + "\n")
    print(f"wrote {OUT} {W}x{H}, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
