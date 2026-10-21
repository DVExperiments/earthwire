// Orders must match pipeline/cameo.py and pipeline/topics.py
function withRgb(list) {
  list.forEach((c) => {
    const n = parseInt(c.color.slice(1), 16);
    c.rgb = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  });
  return list;
}

export const TYPES = withRgb([
  { id: 'conflict', label: 'Conflict', long: 'Armed conflict, attacks and violence', color: '#ff4d6a' },
  { id: 'security', label: 'Security', long: 'Arrests, crackdowns and military posturing', color: '#ff9a3d' },
  { id: 'protest', label: 'Protest', long: 'Demonstrations, strikes and unrest', color: '#ffd84a' },
  { id: 'tension', label: 'Tension', long: 'Accusations, demands, threats and sanctions', color: '#c58bff' },
  { id: 'diplomacy', label: 'Diplomacy', long: 'Statements, talks, visits and agreements', color: '#52a8ff' },
  { id: 'cooperation', label: 'Cooperation', long: 'Aid, joint projects and releases', color: '#4fe3a0' },
  { id: 'general', label: 'General', long: 'Reporting with no political event: business, science, culture and more', color: '#71879a' },
]);

export const TOPICS = withRgb([
  { id: 'politics', label: 'Politics', long: 'Elections, governments and lawmaking', color: '#5aa9ff' },
  { id: 'economy', label: 'Economy', long: 'Business, markets, trade, jobs and prices', color: '#3fe0a0' },
  { id: 'technology', label: 'Tech & science', long: 'Technology, science, space and cyber', color: '#a98bff' },
  { id: 'health', label: 'Health', long: 'Health care, disease and medicine', color: '#ff6fb0' },
  { id: 'environment', label: 'Environment', long: 'Climate, pollution, nature and water', color: '#8fe356' },
  { id: 'disasters', label: 'Disasters', long: 'Floods, storms, fires, quakes and extreme weather', color: '#ff5d4d' },
  { id: 'agriculture', label: 'Food & farming', long: 'Agriculture, food supply and fishing', color: '#e0c45a' },
  { id: 'energy', label: 'Energy', long: 'Oil, gas, electricity and renewables', color: '#ffa53d' },
  { id: 'crime', label: 'Crime & justice', long: 'Crime, policing, courts and corruption', color: '#d6dde3' },
  { id: 'society', label: 'Society', long: 'Education, religion, sport, culture and migration', color: '#4fe0e6' },
  { id: 'other', label: 'Other', long: 'Articles GDELT didn’t tag with a known topic', color: '#6f8a96' },
]);

export const DIMS = { type: TYPES, topic: TOPICS };

export const WINDOWS = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
];

// CAMEO actor country codes that differ from Natural Earth's ADM0_A3
const CAMEO_FIX = { ROM: 'ROU', KSV: 'KOS', SSD: 'SDS', PSE: 'PSX', TMP: 'TLS', ZAR: 'COD' };
export const EU_ANCHOR = { n: 'European Union', nl: 'European Union', lx: 4.35, ly: 50.85, i3: 'EUR', virtual: true };

export async function getJSON(url, { bust = false } = {}) {
  const res = await fetch(bust ? `${url}?t=${Date.now()}` : url, { cache: bust ? 'no-store' : 'default' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export function shortName(full, prec = 3) {
  const parts = full.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return full;
  if (prec === 2) return `${parts[0]} (region), ${parts[parts.length - 1]}`;
  const first = parts[0], last = parts[parts.length - 1];
  return first === last ? first : `${first}, ${last}`;
}

export function indexNews(raw, countries) {
  const byFips = new Map(), byA3 = new Map();
  for (const c of countries) {
    if (c.f && !byFips.has(c.f)) byFips.set(c.f, c);
    if (c.i3) byA3.set(c.i3, c);
  }
  const cameo = (code) => (code === 'EUR' ? EU_ANCHOR : byA3.get(CAMEO_FIX[code] || code) || null);
  const places = raw.places.map(([name, lat, lon, cc, prec, c, t], i) => ({
    i, key: `${prec}:${lat},${lon}`, name, short: shortName(name, prec), lat, lon, cc, prec,
    counts: { type: c, topic: t }, country: byFips.get(cc) || null, stories: [],
  }));
  const stories = raw.stories.map((s) => ({
    place: places[s.p], cat: s.c, topics: s.tp || [10], time: s.t * 1000, url: s.u,
    headline: s.h || '', realTitle: !!s.hq, original: s.ot || '', lang: s.lg || '',
    domain: s.d, actor1: s.a1 || '', actor2: s.a2 || '', event: s.e || '', tone: s.o,
    articles: s.n, sources: s.s, link: s.x ? s.x.map(cameo) : null,
  }));
  for (const s of stories) s.place.stories.push(s);
  const pairs = (raw.pairs || []).map(([a, b, n1, n6, n24, top]) => ({
    a: cameo(a), b: cameo(b), n: [n1, n6, n24], top,
  })).filter((p) => p.a && p.b && p.a !== p.b);
  return {
    places, stories, pairs, end: raw.end * 1000, generated: Date.parse(raw.generated), hours: raw.hours,
    hist: raw.hist, thist: raw.thist || [], totals: raw.totals, files: raw.files, stats: raw.stats || {},
    byFips,
  };
}

export function windowIndex(hours) { return hours <= 1 ? 0 : hours <= 6 ? 1 : 2; }

export function placeCount(p, w, mode, enabled) {
  const c = p.counts[mode][w];
  let total = 0, top = -1, topN = 0;
  for (let k = 0; k < c.length; k++) {
    if (!enabled[k]) continue;
    total += c[k];
    if (c[k] > topN) { topN = c[k]; top = k; }
  }
  return { total, top };
}

export function storyMatcher(news, hours, mode, enabled) {
  const cutoff = news.end - hours * 3600e3;
  if (mode === 'type') return (s) => s.time >= cutoff && enabled[s.cat];
  return (s) => s.time >= cutoff && s.topics.some((t) => enabled[t]);
}

export function storyKey(s, mode, enabled) {
  if (mode === 'type') return s.cat;
  return s.topics.find((t) => enabled[t]) ?? s.topics[0];
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

// WMO weather codes used by Open-Meteo
export const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers',
  82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};
