// Geographic helpers. Convention matches THREE.SphereGeometry UV mapping, so
// equirectangular textures, borders and dots all line up exactly.
const D2R = Math.PI / 180;

export function toXYZ(lat, lon, r = 1, out = [0, 0, 0]) {
  const la = lat * D2R, lo = lon * D2R, c = Math.cos(la);
  out[0] = r * c * Math.cos(lo);
  out[1] = r * Math.sin(la);
  out[2] = -r * c * Math.sin(lo);
  return out;
}

export function toLatLon(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  return { lat: Math.asin(y / r) / D2R, lon: Math.atan2(-z, x) / D2R };
}

// Great-circle interpolation between two lat/lon points, returns array of [lat, lon].
export function greatCircle(lat1, lon1, lat2, lon2, steps) {
  const a = toXYZ(lat1, lon1), b = toXYZ(lat2, lon2);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const w = Math.acos(dot), s = Math.sin(w) || 1e-9;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k1 = Math.sin((1 - t) * w) / s, k2 = Math.sin(t * w) / s;
    pts.push(toLatLon(a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2));
  }
  return { pts, angle: w };
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Rings are flat integer arrays [lon*100, lat*100, ...].
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function countryAt(countries, lat, lon) {
  const x = lon * 100, y = lat * 100;
  for (const c of countries) {
    const [x0, y0, x1, y1] = c.bb;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    let hits = 0;
    for (const r of c.r) if (inRing(x, y, r)) hits++;
    if (hits % 2 === 1) return c;
  }
  return null;
}

// Split long border segments so lines hug the sphere instead of cutting through it.
export function ringToSegments(ring, r, out, maxDeg = 1.5) {
  for (let i = 0; i < ring.length - 2; i += 2) {
    const lon1 = ring[i] / 100, lat1 = ring[i + 1] / 100;
    const lon2 = ring[i + 2] / 100, lat2 = ring[i + 3] / 100;
    if (Math.abs(lon2 - lon1) > 180) continue; // antimeridian seam
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1)) / maxDeg));
    let prev = toXYZ(lat1, lon1, r);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const p = toXYZ(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t, r);
      out.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
      prev = p;
    }
  }
}
