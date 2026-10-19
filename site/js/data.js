// Category order must match pipeline/cameo.py
export const CATEGORIES = [
  { id: 'conflict', label: 'Conflict', long: 'Armed conflict, attacks and violence', color: '#ff4d6a' },
  { id: 'security', label: 'Security', long: 'Arrests, crackdowns and military posturing', color: '#ff9a3d' },
  { id: 'protest', label: 'Protest', long: 'Demonstrations, strikes and unrest', color: '#ffd84a' },
  { id: 'tension', label: 'Tension', long: 'Accusations, demands, threats and sanctions', color: '#c58bff' },
  { id: 'diplomacy', label: 'Diplomacy', long: 'Statements, talks, visits and agreements', color: '#52a8ff' },
  { id: 'cooperation', label: 'Cooperation', long: 'Aid, joint projects and releases', color: '#4fe3a0' },
];
CATEGORIES.forEach((c) => {
  const n = parseInt(c.color.slice(1), 16);
  c.rgb = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
});

export const WINDOWS = [
  { hours: 1, label: '1 hour', key: 5 },
  { hours: 6, label: '6 hours', key: 6 },
  { hours: 24, label: '24 hours', key: 7 },
];

const PRECISION = { 1: 'country', 2: 'region', 3: 'city' };

export async function getJSON(url, { bust = false } = {}) {
  const res = await fetch(bust ? `${url}?t=${Date.now()}` : url, { cache: bust ? 'no-store' : 'default' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Turn the compact news.json into objects that are easy to render.
export function indexNews(raw, countries) {
  const byFips = new Map();
  for (const c of countries) if (c.f && !byFips.has(c.f)) byFips.set(c.f, c);
  const places = raw.places.map(([name, lat, lon, cc, prec, c1, c6, c24], i) => ({
    i, key: `${prec}:${lat},${lon}`, name, short: shortName(name, prec), lat, lon, cc, prec,
    precision: PRECISION[prec], counts: [c1, c6, c24], country: byFips.get(cc) || null, stories: [],
  }));
  const stories = raw.stories.map((s) => ({
    place: places[s.p], cat: s.c, time: s.t * 1000, url: s.u,
    headline: s.h || '', realTitle: !!s.hq, domain: s.d, actor1: s.a1, actor2: s.a2,
    event: s.e, goldstein: s.g, tone: s.o, articles: s.n, sources: s.s, code: s.k, translated: !!s.l,
  }));
  for (const s of stories) s.place.stories.push(s);
  return {
    places, stories, end: raw.end * 1000, generated: Date.parse(raw.generated), hours: raw.hours,
    hist: raw.hist, totals: raw.totals, files: raw.files,
  };
}

export function shortName(full, prec = 3) {
  const parts = full.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return full;
  // region-level places get a marker so they aren't confused with the city of the same name
  if (prec === 2) return `${parts[0]} (region), ${parts[parts.length - 1]}`;
  // "Auckland, Auckland, New Zealand" -> "Auckland, New Zealand"
  const first = parts[0], last = parts[parts.length - 1];
  return first === last ? first : `${first}, ${last}`;
}

export function windowIndex(hours) { return hours <= 1 ? 0 : hours <= 6 ? 1 : 2; }

// Visible count for a place, given the time window and enabled categories.
export function placeCount(p, w, enabled) {
  const c = p.counts[w];
  let total = 0, top = -1, topN = 0;
  for (let k = 0; k < c.length; k++) {
    if (!enabled[k]) continue;
    total += c[k];
    if (c[k] > topN) { topN = c[k]; top = k; }
  }
  return { total, top };
}

export function storyFilter(news, hours, enabled) {
  const cutoff = news.end - hours * 3600e3;
  return (s) => s.time >= cutoff && enabled[s.cat];
}

export function timeAgo(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function safeUrl(u) {
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch { return null; }
}
