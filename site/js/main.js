import { Globe } from './globe.js';
import { countryAt, distanceKm } from './geo.js';
import { buildPopulation } from './population.js';
import { renderCharts, dailySeries, sparkline } from './charts.js';
import {
  TYPES, TOPICS, DIMS, WINDOWS, WEATHER_CODES, getJSON, indexNews, placeCount, storyMatcher, storyKey,
  timeAgo, safeUrl, windowIndex,
} from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(max-width: 820px)');
const REFRESH_MS = 10 * 60e3;

const LAYERS = [
  { group: 'News' },
  { id: 'news', label: 'News', on: true, info: 'A dot for every place with stories. Solid dots are cities, rings are states or provinces.' },
  { id: 'beams', label: 'Hotspot beams', on: true, info: 'Light beams over the busiest places. Taller beams mean more stories.' },
  { id: 'links', label: 'Cross-border links', on: true, swatch: 'links', info: 'Arcs between countries whose people or governments act on each other in the news.' },
  { group: 'The world' },
  { id: 'pop', label: 'Population', on: true, swatch: 'pop', info: 'Where people live. Each dot is about 25 km across; brighter means more people.' },
  { id: 'night', label: 'Day and night', on: true, info: 'Shades the half of the planet in darkness right now.' },
  { id: 'stations', label: 'Antarctic stations', on: true, swatch: 'stations', info: 'Major research stations in Antarctica.' },
  { id: 'borders', label: 'Borders', on: true, info: 'Country borders and coastlines.' },
  { id: 'grid', label: 'Latitude and longitude', on: true, info: 'Lines every 15 degrees.' },
  { group: 'Networks' },
  { id: 'air', label: 'Air routes', on: false, swatch: 'air', info: 'The 1,400 busiest airport-to-airport routes (2014 snapshot, not live flights).' },
  { id: 'sea', label: 'Shipping lanes', on: false, swatch: 'sea', info: 'Major, middle and minor shipping lanes on the oceans.' },
  { group: 'Weather' },
  { id: 'wind', label: 'Wind', on: false, swatch: 'wind', info: 'Current surface winds, animated. Brighter streaks are faster.' },
  { id: 'cloud', label: 'Clouds', on: false, swatch: 'cloud', info: 'Current cloud cover.' },
  { id: 'temp', label: 'Temperature', on: false, swatch: 'temp', info: 'Current air temperature, from blue (−30 °C) to red (40 °C).' },
];

const state = {
  hours: 24,
  mode: 'type',
  enabled: { type: TYPES.map(() => true), topic: TOPICS.map(() => true) },
  view: { type: 'overview' },
  news: null, countries: [], cities: null, history: null, weather: null,
  storyLimit: 40,
  spin: !reduced,
  layers: Object.fromEntries(LAYERS.filter((l) => l.id).map((l) => [l.id, l.on])),
};
const cats = () => DIMS[state.mode];
const enabled = () => state.enabled[state.mode];

// ------------------------------------------------------------------ boot
const canvas = $('#globe');
let globe;
try {
  globe = new Globe(canvas, { reducedMotion: reduced });
} catch (err) {
  $('#bootText').textContent = 'This browser can’t draw the 3D globe. Turn on hardware acceleration or try another browser.';
  throw err;
}
startView();
globe.on('hover', onHover);
globe.on('click', onGlobeClick);
globe.on('frame', updateLabels);

buildLegend();
buildWindows();
buildLayers();
bindTools();
bindSearch();
bindSheet();
bindDialogs();
layoutInsets();
mobile.addEventListener('change', layoutInsets);
addEventListener('resize', layoutInsets);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

(async function load() {
  try {
    state.countries = await getJSON('data/countries.json');
    globe.setCountries(state.countries);
  } catch (e) { console.error(e); }
  $('#boot').classList.add('done');
  await loadNews(false);
  applyHash();
  addEventListener('hashchange', applyHash);
  setInterval(() => loadNews(true), REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.news && Date.now() - state.news.generated > REFRESH_MS) loadNews(true);
  });
  // secondary layers load after the news is on screen
  ensureCities().then(async () => {
    try {
      const pop = await buildPopulation('assets/population-density.png', state.cities);
      globe.setPopulation(pop.positions, pop.values, pop.step);
    } catch (e) { console.error('population', e); }
  });
  getJSON('data/stations.json').then((d) => {
    globe.setStations(d.rows.map(([name, country, lat, lon, kind]) => ({ name, country, lat, lon, kind })));
    globe.setLayer('stations', state.layers.stations);
  }).catch(() => {});
})();

function startView() {
  const jan = new Date(2026, 0, 1).getTimezoneOffset(), jul = new Date(2026, 6, 1).getTimezoneOffset();
  let lon = -Math.max(jan, jul) / 4;
  if (lon > 180) lon -= 360;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const lat = /^Australia|Auckland|Chatham/.test(tz) ? -30 : /^America\/(Argentina|Sao_Paulo|Santiago|Lima|Bogota|Montevideo)/.test(tz) ? -18
    : /^Africa/.test(tz) ? 5 : /^Europe/.test(tz) ? 40 : /^Asia/.test(tz) ? 25 : /^America/.test(tz) ? 30 : 15;
  globe.setView(lat, lon + 8, 4.4);
  globe.target.dist = 3.7;
  globe.setSpin(state.spin);
}

async function loadNews(isRefresh) {
  try {
    const raw = await getJSON('data/news.json', { bust: isRefresh });
    if (raw.v !== 2) throw new Error('news.json is from an older version; waiting for the next update');
    if (isRefresh && state.news && Date.parse(raw.generated) === state.news.generated) return;
    const prev = state.view;
    state.news = indexNews(raw, state.countries);
    if (prev.type === 'place') {
      const p = state.news.places.find((x) => x.key === prev.place.key);
      state.view = p ? { ...prev, place: p } : { type: 'overview' };
    }
    refresh();
  } catch (e) {
    console.warn('news unavailable', e);
    if (!isRefresh) renderNoNews();
  }
}

// ------------------------------------------------------------------ derive + draw
function refresh() {
  const n = state.news;
  if (!n) return;
  const w = windowIndex(state.hours), en = enabled(), mode = state.mode;
  const match = storyMatcher(n, state.hours, mode, en);
  for (const p of n.places) { p.kept = 0; p.visibleCount = 0; p.topCat = -1; }
  for (const s of n.stories) if (match(s)) s.place.kept++;
  const list = [];
  for (const p of n.places) {
    const { total, top } = placeCount(p, w, mode, en);
    p.visibleCount = Math.max(total, p.kept);
    p.topCat = top;
    // Only places with stories we can actually list are drawn.
    if (p.prec === 1 || !p.kept || top < 0) continue;
    const recent = placeCount(p, 0, mode, en).total > 0;
    list.push({ key: p.key, lat: p.lat, lon: p.lon, prec: p.prec, recent, ref: p,
      color: cats()[top].rgb, size: Math.min(22, 3.6 + 2.3 * Math.log(1 + p.visibleCount)) });
  }
  list.sort((a, b) => a.size - b.size);
  globe.setPlaces(list);
  globe.setSelected(state.view.type === 'place' ? state.view.place.key : null);
  const top = list.slice(-36).filter((x) => x.ref.visibleCount >= 3);
  const maxN = Math.max(1, ...top.map((x) => x.ref.visibleCount));
  globe.setBeams(top.map((x) => ({ lat: x.lat, lon: x.lon, color: x.color, h: 0.03 + 0.17 * Math.sqrt(x.ref.visibleCount / maxN) })));
  drawLinks();
  updateLegendCounts();
  drawSpark();
  updateStatus();
  renderPanel();
  writeHash();
}

function countryOfView() {
  const v = state.view;
  if (v.type === 'country') return v.country;
  if (v.type === 'place') return v.place.country;
  if (v.type === 'near') return v.city.countryObj;
  return null;
}

function drawLinks() {
  const n = state.news, w = windowIndex(state.hours), v = state.view;
  let pairs = n.pairs.filter((p) => p.n[w] > 0);
  const c = countryOfView();
  if (v.type === 'pair') pairs = pairs.filter((p) => samePair(p, v.a, v.b));
  else if (c) pairs = pairs.filter((p) => p.a === c || p.b === c);
  pairs = mergePairs(pairs, w).slice(0, c || v.type === 'pair' ? 30 : 60);
  const max = Math.max(1, ...pairs.map((p) => p.count));
  globe.setLinks(pairs.map((p) => ({
    a: { lat: p.a.ly, lon: p.a.lx }, b: { lat: p.b.ly, lon: p.b.lx },
    color: TYPES[p.top].rgb, w: Math.sqrt(p.count / max),
  })));
}

const samePair = (p, a, b) => (p.a === a && p.b === b) || (p.a === b && p.b === a);

// Combine A→B and B→A into one undirected link.
function mergePairs(pairs, w) {
  const m = new Map();
  for (const p of pairs) {
    const key = [p.a.i3, p.b.i3].sort().join('|');
    const cur = m.get(key) || { a: p.a, b: p.b, count: 0, top: p.top, topN: 0 };
    cur.count += p.n[w];
    if (p.n[w] > cur.topN) { cur.topN = p.n[w]; cur.top = p.top; }
    m.set(key, cur);
  }
  return [...m.values()].sort((x, y) => y.count - x.count);
}

function updateStatus() {
  const n = state.news, el = $('#status');
  const age = Date.now() - n.generated;
  el.className = `status ${age < 90 * 60e3 ? 'live' : 'stale'}`;
  el.textContent = `Updated ${timeAgo(n.generated)}`;
  el.title = `News up to ${new Date(n.end).toUTCString()}. ${fmt.format(n.totals.stories)} stories from ${fmt.format(n.totals.allPlaces)} places in GDELT’s last ${n.hours} hours.`;
  $('#aboutFoot').textContent = `This build read ${fmt.format(n.totals.events)} GDELT events and ${fmt.format(n.totals.articles)} articles from ${n.files.loaded} of ${n.files.expected} update files, generated ${new Date(n.generated).toUTCString()}.`;
}

// ------------------------------------------------------------------ legend / time
function buildLegend() {
  $('#modeSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setMode(b.dataset.mode);
  });
  const el = $('#legend');
  let timer;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const en = enabled(), i = +b.dataset.i;
      en[i] = !en[i];
      if (!en.some(Boolean)) en.fill(true);
      syncLegend(); refresh();
    }, 220);
  });
  el.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    clearTimeout(timer);
    const en = enabled(), i = +b.dataset.i;
    const only = en.every((v, k) => v === (k === i));
    en.forEach((_, k) => { en[k] = only || k === i; });
    syncLegend(); refresh();
  });
  drawLegend();
}
function drawLegend() {
  document.querySelectorAll('#modeSwitch button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === state.mode));
  $('#legend').innerHTML = cats().map((c, i) => `
    <button class="chip" type="button" aria-pressed="${enabled()[i]}" data-i="${i}" style="--c:${c.color}" title="${esc(c.long)}. Double-click to show only this.">
      <i class="dotc"></i>${esc(c.label)} <span class="n" data-n="${i}"></span></button>`).join('');
}
function setMode(m) {
  if (m === state.mode || !DIMS[m]) return;
  state.mode = m;
  if (state.view.type === 'category') state.view = { type: 'overview' };
  if (state.view.cat != null) state.view = { ...state.view, cat: null };
  drawLegend(); refresh();
}
function syncLegend() {
  document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', enabled()[+b.dataset.i]));
}
function totalsFor(places, hours, mode = state.mode) {
  const w = windowIndex(hours), t = DIMS[mode].map(() => 0);
  for (const p of places) p.counts[mode][w].forEach((v, k) => { t[k] += v; });
  return t;
}
function updateLegendCounts() {
  const t = totalsFor(state.news.places, state.hours);
  document.querySelectorAll('[data-n]').forEach((s) => { s.textContent = fmt.format(t[+s.dataset.n]); });
}

function buildWindows() {
  const el = $('#windows');
  el.innerHTML = WINDOWS.map((w) => `<button type="button" role="radio" aria-checked="${w.hours === state.hours}" tabindex="${w.hours === state.hours ? 0 : -1}" data-h="${w.hours}">${w.label}</button>`).join('');
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setHours(+b.dataset.h); });
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = WINDOWS.findIndex((w) => w.hours === state.hours);
    const j = Math.max(0, Math.min(WINDOWS.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    setHours(WINDOWS[j].hours); el.children[j].focus();
  });
}
function setHours(h) {
  state.hours = h;
  document.querySelectorAll('#windows button').forEach((b) => {
    const on = +b.dataset.h === h; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
  });
  state.storyLimit = 40;
  refresh();
}

function drawSpark() {
  const svg = $('#spark'), hist = state.mode === 'type' ? state.news.hist : state.news.thist;
  if (!hist.length) { svg.innerHTML = ''; return; }
  const H = hist[0].length, en = enabled();
  const totals = Array.from({ length: H }, (_, b) => hist.reduce((s, row, k) => s + (en[k] ? row[b] : 0), 0));
  const max = Math.max(1, ...totals), bw = 240 / H;
  let out = '';
  for (let b = 0; b < H; b++) {
    const x = 240 - (b + 1) * bw;
    let y = 34;
    out += `<g${b < state.hours ? '' : ' class="off"'}>`;
    hist.forEach((row, k) => {
      if (!en[k] || !row[b]) return;
      const h = (row[b] / max) * 32;
      y -= h;
      out += `<rect x="${(x + 0.6).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw - 1.2).toFixed(2)}" height="${h.toFixed(2)}" fill="${cats()[k].color}"/>`;
    });
    out += '</g>';
  }
  svg.innerHTML = out;
}

// ------------------------------------------------------------------ panel building blocks
function storiesFor(filterFn, catFilter = null) {
  const match = storyMatcher(state.news, state.hours, state.mode, enabled());
  return state.news.stories.filter((s) => match(s) && filterFn(s)
    && (catFilter == null || (state.mode === 'type' ? s.cat === catFilter : s.topics.includes(catFilter))));
}

const weight = (s) => s.articles + s.sources * 2 + (s.realTitle ? 3 : 0) + (s.original ? 2 : 0);
function rankStories(list) { return list.slice().sort((a, b) => weight(b) - weight(a) || b.time - a.time); }

function storyHTML(s, showPlace) {
  const url = safeUrl(s.url); if (!url) return '';
  const k = storyKey(s, state.mode, enabled());
  const c = cats()[k] || cats()[0];
  const who = [s.actor1, s.actor2].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const what = s.event
    ? `<span class="ev">${esc(s.event)}</span>${who.length ? `, involving ${esc(who.join(' and '))}` : ''}`
    : `<span class="ev">${esc(s.topics.filter((t) => t !== 10).map((t) => TOPICS[t].label).join(' and ') || 'News')}</span>`;
  const link = s.link && s.link[0] && s.link[1] ? `<span class="tag link">${esc(s.link[0].n)} ↔ ${esc(s.link[1].n)}</span>` : '';
  const translate = s.lang ? `<a class="tr" href="https://translate.google.com/translate?sl=auto&tl=en&u=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer">Read in English</a>` : '';
  return `<li class="story" style="--c:${c.color}">
    <a class="story-h${s.realTitle || s.lang ? '' : ' derived'}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.headline || `${s.event} in ${s.place.short}`)}</a>
    ${s.original ? `<p class="story-orig">Original ${esc(s.lang)} headline: <span>${esc(s.original)}</span></p>` : ''}
    <p class="story-ev">${what}${showPlace ? ` in ${esc(s.place.short)}` : ''}</p>
    <p class="story-meta"><span class="src">${esc(s.domain)}</span><span>${timeAgo(s.time)}</span>${s.lang && !s.original ? `<span>${esc(s.lang === 'another language' ? 'Non-English source' : `${s.lang} source`)}</span>` : ''}${translate}${link}</p>
  </li>`;
}

function storyList(list, showPlace, total) {
  if (!list.length) return `<p class="empty">None of the stories saved for this map match these filters. Try a longer time window or turn more categories back on.</p>`;
  const shown = list.slice(0, state.storyLimit);
  const note = total && total > list.length
    ? `<p class="list-note">${fmt.format(total)} reports in total; the ${fmt.format(list.length)} most covered are saved for the map.</p>` : '';
  return `${note}<ul class="stories">${shown.map((s) => storyHTML(s, showPlace)).join('')}</ul>
    ${list.length > shown.length ? `<button class="more" type="button" data-more>Show ${Math.min(40, list.length - shown.length)} more of ${fmt.format(list.length - shown.length)}</button>` : ''}`;
}

function mixHTML(counts, active = null) {
  const en = enabled();
  const total = counts.reduce((a, b, k) => a + (en[k] ? b : 0), 0);
  if (!total) return '';
  const bar = counts.map((v, k) => en[k] && v ? `<span style="--c:${cats()[k].color};flex:${v}"></span>` : '').join('');
  const key = counts.map((v, k) => (en[k] && v ? { v, k } : null)).filter(Boolean).sort((a, b) => b.v - a.v)
    .map(({ v, k }) => `<li><button type="button" data-cat="${k}" style="--c:${cats()[k].color}" aria-pressed="${active === k}"><i></i>${esc(cats()[k].label)}<b>${fmt.format(v)}</b></button></li>`).join('');
  return `<div class="mix" role="img" aria-label="Share of stories">${bar}</div>
    <ul class="mix-key" aria-label="Select a category to list its stories">${key}</ul>`;
}

function windowPhrase() { return state.hours === 1 ? 'the last hour' : `the last ${state.hours} hours`; }
function windowAccent() { return `<button type="button" class="accent" data-cycle-window title="Change time window">${state.hours === 1 ? 'hour' : `${state.hours} hours`}</button>`; }

function placeButtons(places, max, catFilter = null) {
  const w = windowIndex(state.hours), mode = state.mode;
  const val = (p) => (catFilter == null ? p.visibleCount : p.counts[mode][w][catFilter]);
  const list = places.filter((p) => val(p) > 0 && p.kept > 0).sort((a, b) => val(b) - val(a)).slice(0, max);
  if (!list.length) return '';
  const top = Math.max(1, ...list.map(val));
  return `<ul class="places">${list.map((p) => `<li><button type="button" data-place="${p.i}" style="--c:${cats()[catFilter ?? p.topCat]?.color || '#6ff3e6'}">
      <span class="pl-name">${esc(p.prec === 1 ? `${p.short} (country-wide)` : p.short)}</span><span class="pl-n">${fmt.format(val(p))}</span>
      <span class="pl-bar"><span style="width:${(val(p) / top * 100).toFixed(1)}%"></span></span></button></li>`).join('')}</ul>`;
}

function head(crumbs) {
  return `<div class="panel-head"><button class="back" type="button" data-back aria-label="Back to all news">All news</button>
    <span class="crumbs">${crumbs.map(esc).join('<span aria-hidden="true"> / </span>')}</span></div>`;
}

function countryName(fips) { return state.news.byFips.get(fips)?.n || fips || 'Unknown'; }

function connectedHTML(country) {
  const w = windowIndex(state.hours);
  const pairs = mergePairs(state.news.pairs.filter((p) => (p.a === country || p.b === country) && p.n[w] > 0), w).slice(0, 8);
  if (!pairs.length) return '';
  const max = Math.max(...pairs.map((p) => p.count));
  return `<h3>Connected countries</h3><p class="sub">Stories where people or governments from ${esc(country.n)} and another country act on each other.</p>
    <ul class="places">${pairs.map((p) => {
      const other = p.a === country ? p.b : p.a;
      return `<li><button type="button" data-pair="${esc(country.i3)}|${esc(other.i3)}" style="--c:${TYPES[p.top].color}">
        <span class="pl-name">${esc(other.n)}</span><span class="pl-n">${fmt.format(p.count)}</span>
        <span class="pl-bar"><span style="width:${(p.count / max * 100).toFixed(1)}%"></span></span></button></li>`;
    }).join('')}</ul>`;
}

function unusualHTML() {
  const h = state.history;
  if (!h) return '';
  const days = Object.keys(h.days).sort();
  const base = days.slice(0, -2);
  if (base.length < 5) return '';
  const offset = state.mode === 'type' ? 0 : TYPES.length;
  const today = new Map();
  for (const p of state.news.places) {
    const row = today.get(p.cc) || cats().map(() => 0);
    p.counts[state.mode][2].forEach((v, k) => { row[k] += v; });
    today.set(p.cc, row);
  }
  const found = [];
  for (const [cc, row] of today) {
    row.forEach((v, k) => {
      if (v < 8 || !enabled()[k] || cats()[k].id === 'other' || cats()[k].id === 'general') return;
      const avg = base.reduce((s, d) => s + (h.days[d][cc]?.[offset + k] || 0), 0) / base.length;
      const ratio = v / (avg + 1);
      if (ratio >= 2.5) found.push({ cc, k, v, ratio, isNew: avg < 0.5 });
    });
  }
  found.sort((a, b) => b.ratio - a.ratio);
  if (!found.length) return '';
  return `<h3>Unusual activity</h3><p class="sub">Compared with the daily average over the previous ${base.length} days.</p>
    <ul class="places">${found.slice(0, 5).map((f) => {
      const c = state.news.byFips.get(f.cc);
      return `<li><button type="button" ${c ? `data-country="${esc(c.i3)}" data-cat="${f.k}"` : ''} style="--c:${cats()[f.k].color}">
        <span class="pl-name"><i class="dotc"></i> ${esc(cats()[f.k].label)} in ${esc(countryName(f.cc))}</span>
        <span class="pl-n">${f.isNew ? 'new' : `${f.ratio.toFixed(1)}×`}</span></button></li>`;
    }).join('')}</ul>`;
}

function trendHTML(country) {
  const h = state.history;
  if (!h || !country.f) return '';
  const { days, series } = dailySeries(h, state.mode, country.f);
  if (days.length < 3) return '';
  const totals = days.map((_, i) => series.reduce((s, row, k) => s + (enabled()[k] ? row[days.length - 1 - i] : 0), 0));
  return `<h3>Last ${days.length} days</h3>${sparkline(totals, 'var(--holo)')}<div class="ch-axis"><span>${days[0]}</span><span>${days[days.length - 1]}</span></div>`;
}

function weatherSlot(lat, lon) {
  const id = `wx${Math.round(lat * 100)}_${Math.round(lon * 100)}`;
  queueMicrotask(() => loadLocalWeather(id, lat, lon));
  return `<div class="wx" id="${id}" aria-live="polite"><span class="wx-loading">Loading local weather</span></div>`;
}
const wxCache = new Map();
async function loadLocalWeather(id, lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  try {
    let d = wxCache.get(key);
    if (!d) {
      d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
      wxCache.set(key, d);
    }
    const el = document.getElementById(id); if (!el) return;
    const c = d.current;
    el.innerHTML = `<span class="wx-t">${Math.round(c.temperature_2m)}°C</span>
      <span class="wx-d"><b>${esc(WEATHER_CODES[c.weather_code] || 'Current weather')}</b>
      High ${Math.round(d.daily.temperature_2m_max[0])}° and low ${Math.round(d.daily.temperature_2m_min[0])}°, wind ${Math.round(c.wind_speed_10m)} km/h, humidity ${c.relative_humidity_2m}%</span>`;
  } catch {
    const el = document.getElementById(id); if (el) el.remove();
  }
}

// ------------------------------------------------------------------ panel views
function renderPanel() {
  const v = state.view, body = $('#panelBody'), n = state.news;
  const w = windowIndex(state.hours);
  let html = '';
  if (v.type === 'overview') {
    const counts = totalsFor(n.places, state.hours);
    // topic counts overlap (a story can have two topics), so count unique stories from event types
    const total = state.mode === 'type' || enabled().every(Boolean)
      ? totalsFor(n.places, state.hours, 'type').reduce((a, b, k) => a + (state.mode === 'type' && !enabled()[k] ? 0 : b), 0)
      : counts.reduce((a, b, k) => a + (enabled()[k] ? b : 0), 0);
    const placeN = n.places.filter((p) => p.kept > 0).length;
    html = `<h2>The world in the last ${windowAccent()}</h2>
      <p class="lede"><b>${fmt.format(total)}</b> stories from <b>${fmt.format(placeN)}</b> places. Select a dot, a country or a category below to read what’s being reported.</p>
      ${mixHTML(counts)}
      ${unusualHTML()}
      <h3>Busiest places</h3>${placeButtons(n.places.filter((p) => p.prec > 1), 8)}
      <h3>Most covered stories</h3>${storyList(rankStories(storiesFor(() => true)), true)}`;
  } else if (v.type === 'category') {
    const c = cats()[v.cat];
    const total = totalsFor(n.places, state.hours)[v.cat];
    const list = rankStories(storiesFor(() => true, v.cat));
    html = `${head([state.mode === 'type' ? 'Event type' : 'Topic', c.label])}
      <h2 class="cat-title" style="--c:${c.color}"><i></i>${esc(c.label)}</h2>
      <p class="lede">${esc(c.long)}. <b>${fmt.format(total)}</b> stories in ${windowPhrase()}.</p>
      <h3>Where</h3>${placeButtons(n.places, 8, v.cat)}
      <h3>Stories</h3>${storyList(list, true, total)}`;
  } else if (v.type === 'place') {
    const p = v.place;
    const list = rankStories(storiesFor((s) => s.place === p, v.cat));
    const preciseNote = p.prec === 3 ? 'Placed at this city or landmark.'
      : p.prec === 2 ? 'Placed at the centre of this state or province; the stories didn’t name anywhere more precise.'
        : 'These stories only name the country.';
    const countryCount = p.country ? n.places.filter((x) => x.cc === p.cc).reduce((s, x) => s + x.visibleCount, 0) : 0;
    html = `${head(['World', p.country?.n, p.short.split(',')[0]].filter(Boolean))}
      <h2>${esc(p.short)}</h2>
      <p class="lede">${fmt.format(p.visibleCount)} ${p.visibleCount === 1 ? 'story' : 'stories'} in ${windowPhrase()}.</p>
      <p class="prec"><span class="glyph ${p.prec === 3 ? 'solid' : 'ring'}"></span>${preciseNote}</p>
      ${weatherSlot(p.lat, p.lon)}
      ${p.country ? `<button class="wide-btn" type="button" data-country="${esc(p.country.i3)}">All news in ${esc(p.country.n)}<span>${fmt.format(countryCount)}</span></button>` : ''}
      ${mixHTML(p.counts[state.mode][w], v.cat)}
      <h3>${v.cat != null ? `${esc(cats()[v.cat].label)} stories` : 'Stories'}</h3>${storyList(list, false)}`;
  } else if (v.type === 'country') {
    const c = v.country;
    const inC = n.places.filter((p) => p.cc && p.cc === c.f);
    const counts = cats().map(() => 0);
    inC.forEach((p) => p.counts[state.mode][w].forEach((x, k) => { counts[k] += x; }));
    const total = counts.reduce((a, b, k) => a + (enabled()[k] ? b : 0), 0);
    const list = rankStories(storiesFor((s) => s.place.cc === c.f, v.cat));
    html = `${head(['World', c.n])}
      <h2>${esc(c.nl || c.n)}</h2>
      <p class="lede"><b>${fmt.format(total)}</b> stories in ${windowPhrase()}${c.pop ? `. Population about ${fmtPop(c.pop)}` : ''}.</p>
      ${c.f ? '' : '<p class="note">GDELT doesn’t code this territory separately, so its stories may be listed under a neighbouring country.</p>'}
      ${mixHTML(counts, v.cat)}
      ${trendHTML(c)}
      ${connectedHTML(c)}
      ${inC.some((p) => p.kept) ? `<h3>Places</h3>${placeButtons(inC, 8, v.cat)}` : ''}
      <h3>${v.cat != null ? `${esc(cats()[v.cat].label)} stories` : 'Stories'}</h3>${storyList(list, true)}`;
  } else if (v.type === 'pair') {
    const list = rankStories(storiesFor((s) => s.link && ((s.link[0] === v.a && s.link[1] === v.b) || (s.link[0] === v.b && s.link[1] === v.a))));
    const total = mergePairs(n.pairs.filter((p) => samePair(p, v.a, v.b)), w)[0]?.count || 0;
    html = `${head(['World', 'Cross-border'])}
      <h2>${esc(v.a.n)} and ${esc(v.b.n)}</h2>
      <p class="lede"><b>${fmt.format(total)}</b> stories in ${windowPhrase()} where people or governments from one act on the other.</p>
      <div class="pair-btns">${[v.a, v.b].filter((c) => !c.virtual).map((c) => `<button class="wide-btn" type="button" data-country="${esc(c.i3)}">All news in ${esc(c.n)}</button>`).join('')}</div>
      <h3>Stories</h3>${storyList(list, true, total)}`;
  } else if (v.type === 'near') {
    const { city, nearby } = v;
    html = `${head(['World', city.countryObj?.n, city.name].filter(Boolean))}
      <h2>${esc(city.name)}</h2>
      <p class="lede">No mapped stories within 40 km of ${esc(city.name)} in ${windowPhrase()}.</p>
      ${weatherSlot(city.lat, city.lon)}
      ${city.countryObj ? `<button class="wide-btn" type="button" data-country="${esc(city.countryObj.i3)}">All news in ${esc(city.countryObj.n)}</button>` : ''}
      ${nearby.length ? `<h3>Nearest places with news</h3>${placeButtons(nearby, 8)}` : ''}`;
  }
  body.innerHTML = html;
  globe.highlightCountry(v.type === 'pair' ? null : countryOfView());
}

function renderNoNews() {
  $('#panelBody').innerHTML = `<div class="empty"><h2>No news to show yet</h2>
    <p>The news file hasn’t been built for this version. It’s created by the “Update news and deploy” workflow, which runs on every push and every 30 minutes.
    If this stays empty, open the repository’s Actions tab and check the latest run.</p></div>`;
  $('#status').textContent = 'No news data';
  $('#status').className = 'status';
}

function fmtPop(x) { return x >= 1e9 ? `${(x / 1e9).toFixed(1)} billion` : x >= 1e6 ? `${Math.round(x / 1e5) / 10} million` : fmt.format(x); }

$('#panelBody').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const v = state.view;
  if (t.hasAttribute('data-back')) select({ type: 'overview' });
  else if (t.hasAttribute('data-more')) { state.storyLimit += 40; renderPanel(); }
  else if (t.hasAttribute('data-cycle-window')) { const i = WINDOWS.findIndex((x) => x.hours === state.hours); setHours(WINDOWS[(i + 1) % WINDOWS.length].hours); }
  else if (t.dataset.place) selectPlace(state.news.places[+t.dataset.place], true);
  else if (t.dataset.pair) {
    const [a, b] = t.dataset.pair.split('|').map(findCountry);
    if (a && b) select({ type: 'pair', a, b });
  } else if (t.dataset.country) {
    const c = findCountry(t.dataset.country);
    if (c) selectCountry(c, true, t.dataset.cat != null ? +t.dataset.cat : null);
  } else if (t.dataset.cat != null) {
    const k = +t.dataset.cat;
    if (v.type === 'overview' || v.type === 'category') select({ type: 'category', cat: k });
    else { state.view = { ...v, cat: v.cat === k ? null : k }; state.storyLimit = 40; renderPanel(); writeHash(); }
  }
});

function findCountry(i3) {
  if (i3 === 'EUR') return state.news.pairs.find((p) => p.a.i3 === 'EUR')?.a || state.news.pairs.find((p) => p.b.i3 === 'EUR')?.b;
  return state.countries.find((x) => x.i3 === i3);
}

function select(view) {
  state.view = view; state.storyLimit = 40;
  globe.setSelected(view.type === 'place' ? view.place.key : null);
  globe.setHold(view.type !== 'overview' && view.type !== 'category');
  drawLinks();
  renderPanel();
  $('#panelBody').scrollTop = 0;
  writeHash();
  if (mobile.matches && view.type !== 'overview') setSheet('half');
}

function selectPlace(p, fly) {
  if (p.prec === 1 && p.country) return selectCountry(p.country, fly);
  select({ type: 'place', place: p, cat: null });
  if (fly) globe.flyTo(p.lat, p.lon, Math.min(globe.view.dist, 2.1));
}

function selectCountry(c, fly, cat = null) {
  select({ type: 'country', country: c, cat });
  if (fly) {
    const [x0, y0, x1, y1] = c.bb.map((v) => v / 100);
    const span = Math.min(x1 - x0 > 180 ? 40 : x1 - x0, 120) + (y1 - y0) * 0.6;
    globe.flyTo(c.ly, c.lx, Math.max(1.35, Math.min(3.4, 1.2 + span / 30)));
  }
}

// ------------------------------------------------------------------ globe interaction
const tip = $('#tip');
function onHover(hit) {
  if (!hit || (!hit.place && !hit.station)) { tip.hidden = true; canvas.style.cursor = ''; return; }
  canvas.style.cursor = hit.place ? 'pointer' : 'default';
  if (hit.station) {
    const s = hit.station;
    tip.style.setProperty('--c', '#d9f6ff');
    tip.innerHTML = `<div class="tip-place">${esc(s.name)} Station</div><div class="tip-count">${esc(s.country)}, ${s.kind === 'y' ? 'staffed all year' : 'summer only'}</div>`;
  } else {
    const p = hit.place.ref, c = cats()[p.topCat];
    const top = rankStories(storiesFor((s) => s.place === p))[0];
    tip.style.setProperty('--c', c.color);
    tip.innerHTML = `<div class="tip-place">${esc(p.short)}</div>
      <div class="tip-count"><b>${fmt.format(p.visibleCount)}</b> ${p.visibleCount === 1 ? 'story' : 'stories'}, mostly ${esc(c.label.toLowerCase())}</div>
      ${top ? `<div class="tip-head">${esc(top.headline || top.event)}</div>` : ''}`;
  }
  tip.hidden = false;
  const x = Math.min(hit.x + 16, globe.size.w - globe.inset.right - tip.offsetWidth - 8);
  tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(70, hit.y - tip.offsetHeight - 14)}px)`;
}

function onGlobeClick(hit) {
  tip.hidden = true;
  if (!state.news) return;
  if (hit.place) return selectPlace(hit.place.ref, false);
  if (hit.lat == null) { if (state.view.type !== 'overview') select({ type: 'overview' }); return; }
  const c = countryAt(state.countries, hit.lat, hit.lon);
  if (c) selectCountry(c, false); else select({ type: 'overview' });
}

const labelsEl = $('#labels');
const labelPool = [];
function updateLabels() {
  const want = [], v = state.view;
  if (v.type === 'place') want.push({ text: v.place.short.split(',')[0], lat: v.place.lat, lon: v.place.lon, cls: 'label' });
  if (v.type === 'country') want.push({ text: v.country.n, lat: v.country.ly, lon: v.country.lx, cls: 'label country' });
  if (v.type === 'pair') for (const c of [v.a, v.b]) want.push({ text: c.n, lat: c.ly, lon: c.lx, cls: 'label country' });
  if (v.type === 'near') want.push({ text: v.city.name, lat: v.city.lat, lon: v.city.lon, cls: 'label' });
  while (labelPool.length < want.length) { const d = document.createElement('div'); labelsEl.appendChild(d); labelPool.push(d); }
  labelPool.forEach((el, i) => {
    const l = want[i];
    if (!l) { el.style.display = 'none'; return; }
    const s = globe.project(l.lat, l.lon);
    el.style.display = s.visible ? '' : 'none';
    if (el.textContent !== l.text) el.textContent = l.text;
    el.className = l.cls;
    el.style.left = `${s.x}px`; el.style.top = `${s.y}px`;
  });
}

// ------------------------------------------------------------------ tools, layers, spin
function setSpin(on) {
  state.spin = on;
  globe.setSpin(on);
  const b = $('#spinBtn');
  b.setAttribute('aria-pressed', String(!on));
  b.setAttribute('aria-label', on ? 'Pause the globe’s spin (space bar)' : 'Resume the globe’s spin (space bar)');
  b.title = b.getAttribute('aria-label');
  b.innerHTML = on
    ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.5v11M13 4.5v11"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4.5l8 5.5-8 5.5z"/></svg>';
}

function buildLayers() {
  const box = $('#layers');
  box.innerHTML = '<legend class="sr">Map layers</legend>' + LAYERS.map((l) => l.group
    ? `<p class="layer-group">${esc(l.group)}</p>`
    : `<label class="layer"><input type="checkbox" data-layer="${l.id}" ${state.layers[l.id] ? 'checked' : ''}>
        <span class="layer-text"><span class="layer-name">${esc(l.label)}${l.swatch ? ` <span class="swatch ${l.swatch}"></span>` : ''}</span>
        <span class="layer-info">${esc(l.info)}</span></span></label>`).join('') + '<p class="layer-note" id="wxNote"></p>';
  $('#aboutLayers').innerHTML = LAYERS.filter((l) => l.id).map((l) => `<dt>${esc(l.label)}</dt><dd>${esc(l.info)}</dd>`).join('');
  for (const [id, on] of Object.entries(state.layers)) globe.setLayer(id, on);
  box.addEventListener('change', async (e) => {
    const id = e.target.dataset.layer, on = e.target.checked;
    state.layers[id] = on;
    try {
      if (on && id === 'air' && !globe.air) globe.setAir(await getJSON('data/air.json'));
      if (on && id === 'sea' && !globe.sea) globe.setSea(await getJSON('data/sea.json'));
      if (on && ['wind', 'cloud', 'temp'].includes(id) && !state.weather) {
        state.weather = await getJSON('data/weather.json', { bust: true });
        globe.setWeather(state.weather);
        $('#wxNote').textContent = `Weather from Open-Meteo, updated ${timeAgo(Date.parse(state.weather.generated))}.`;
      }
    } catch (err) {
      console.error(err);
      if (['wind', 'cloud', 'temp'].includes(id)) {
        $('#wxNote').textContent = 'Weather data isn’t available yet. It’s added by the next scheduled update.';
        e.target.checked = false; state.layers[id] = false; return;
      }
    }
    globe.setLayer(id, on);
  });
}

function bindTools() {
  $('#zoomIn').addEventListener('click', () => globe.zoomBy(0.75));
  $('#zoomOut').addEventListener('click', () => globe.zoomBy(1.33));
  $('#homeBtn').addEventListener('click', () => globe.home());
  $('#spinBtn').addEventListener('click', () => setSpin(!state.spin));
  setSpin(state.spin);
  const btn = $('#layersBtn'), box = $('#layers');
  btn.addEventListener('click', () => { box.hidden = !box.hidden; btn.setAttribute('aria-expanded', !box.hidden); });
  document.addEventListener('click', (e) => {
    if (!box.hidden && !e.target.closest('.layers-wrap')) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
  addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog[open]')) return;
    if (e.key === ' ' && !e.target.closest('button, a')) { e.preventDefault(); setSpin(!state.spin); }
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && state.view.type !== 'overview') select({ type: 'overview' });
    if (e.key === '+' || e.key === '=') globe.zoomBy(0.8);
    if (e.key === '-') globe.zoomBy(1.25);
  });
}

function bindDialogs() {
  $('#aboutBtn').addEventListener('click', () => $('#about').showModal());
  $('#aboutLegend').innerHTML = [...TYPES.map((c) => ({ ...c, g: 'Event type' })), ...TOPICS.map((c) => ({ ...c, g: 'Topic' }))]
    .map((c) => `<div style="--c:${c.color}"><i class="dotc"></i><span>${esc(c.label)}<small>${esc(c.long)}</small></span></div>`).join('');
  $('#dataBtn').addEventListener('click', async () => {
    const d = $('#dataDialog');
    if (!state.news) return;
    d.showModal();
    const body = $('#dataBody');
    const draw = () => renderCharts(body, {
      news: state.news, history: state.history, mode: state.mode, countryName,
      pairName: (p) => `${p.a.n} and ${p.b.n}`,
    });
    draw();
    if (!state.history) { await loadHistory(); draw(); }
  });
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
}

async function loadHistory() {
  try { state.history = await getJSON('data/history.json', { bust: true }); } catch { state.history = null; }
}

// ------------------------------------------------------------------ search
function norm(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }

async function ensureCities() {
  if (state.cities) return;
  state.cities = [];
  try {
    const d = await getJSON('data/cities.json');
    state.cities = d.rows.map(([name, lon, lat, pop, country, region, cap]) => ({ name, lon, lat, pop, country, region, cap, k: norm(name) }));
  } catch (e) { console.error(e); }
}

function bindSearch() {
  const q = $('#q'), box = $('#results');
  let items = [], active = -1;
  const close = () => { box.hidden = true; q.setAttribute('aria-expanded', 'false'); active = -1; };
  const draw = () => {
    box.innerHTML = items.length ? items.map((it, i) => `<li role="option" id="opt${i}" aria-selected="${i === active}" data-i="${i}">
      <span>${esc(it.label)}</span><span class="r-kind">${esc(it.kind)}</span></li>`).join('')
      : '<li class="r-empty" role="option" aria-disabled="true">No matching country, city or category</li>';
    box.hidden = false; q.setAttribute('aria-expanded', 'true');
    q.setAttribute('aria-activedescendant', active >= 0 ? `opt${active}` : '');
  };
  q.addEventListener('input', async () => {
    const term = norm(q.value.trim());
    if (term.length < 2) { close(); return; }
    await ensureCities();
    items = search(term); active = items.length ? 0 : -1; draw();
  });
  q.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]'); if (!li) return;
    e.preventDefault(); choose(items[+li.dataset.i]);
  });
  q.addEventListener('blur', () => setTimeout(close, 120));
  function choose(it) { close(); q.value = ''; q.blur(); it.go(); }
}

function search(term) {
  const out = [];
  const score = (k) => (k === term ? 0 : k.startsWith(term) ? 1 : k.includes(` ${term}`) ? 2 : k.includes(term) ? 3 : -1);
  for (const [mode, list] of Object.entries(DIMS)) list.forEach((c, k) => {
    const s = score(norm(c.label));
    if (s >= 0) out.push({ s, w: 4, label: c.label, kind: mode === 'type' ? 'Event type' : 'Topic', go: () => { setMode(mode); select({ type: 'category', cat: k }); } });
  });
  for (const c of state.countries) {
    const s = Math.min(...[c.n, c.nl].map((x) => score(norm(x))).filter((x) => x >= 0), 99);
    if (s < 99) out.push({ s, w: 3, label: c.nl || c.n, kind: 'Country', go: () => selectCountry(c, true) });
  }
  const newsKeys = new Set();
  if (state.news) for (const p of state.news.places) {
    if (p.prec === 1 || !p.stories.length) continue;
    const s = score(norm(p.name.split(',')[0]));
    if (s >= 0) { newsKeys.add(norm(p.short)); out.push({ s, w: 2, n: p.stories.length, label: p.short, kind: `${p.stories.length} ${p.stories.length === 1 ? 'story' : 'stories'}`, go: () => selectPlace(p, true) }); }
  }
  for (const c of state.cities || []) {
    const s = score(c.k);
    if (s < 0) continue;
    const label = `${c.name}, ${c.country}`;
    if (newsKeys.has(norm(label))) continue;
    out.push({ s, w: 1, n: c.pop, label, kind: c.cap ? 'Capital' : 'City', go: () => goCity(c) });
  }
  out.sort((a, b) => a.s - b.s || b.w - a.w || (b.n || 0) - (a.n || 0));
  return out.slice(0, 8);
}

function goCity(city) {
  city.countryObj = state.countries.find((c) => c.n === city.country || c.nl === city.country) || countryAt(state.countries, city.lat, city.lon);
  const ranked = (state.news?.places || []).filter((p) => p.prec > 1 && p.kept > 0)
    .map((p) => ({ p, d: distanceKm(city.lat, city.lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d);
  globe.flyTo(city.lat, city.lon, Math.min(globe.view.dist, 1.9));
  if (ranked[0] && ranked[0].d <= 40) { select({ type: 'place', place: ranked[0].p, cat: null }); return; }
  select({ type: 'near', city, nearby: ranked.filter((r) => r.d < 600).slice(0, 8).map((r) => r.p) });
}

// ------------------------------------------------------------------ mobile sheet + layout
function bindSheet() {
  const panel = $('#panel');
  $('#sheetHandle').addEventListener('click', () => {
    const order = ['peek', 'half', 'full'];
    setSheet(order[(order.indexOf(panel.dataset.sheet) + 1) % 3]);
  });
  let y0 = null;
  panel.addEventListener('touchstart', (e) => { if (e.target.closest('.sheet-handle') || $('#panelBody').scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    const order = ['peek', 'half', 'full'], i = order.indexOf(panel.dataset.sheet);
    if (dy < -40) setSheet(order[Math.min(2, i + 1)]);
    if (dy > 40) setSheet(order[Math.max(0, i - 1)]);
  });
}
function setSheet(s) {
  $('#panel').dataset.sheet = s;
  $('#sheetHandle').setAttribute('aria-label', s === 'full' ? 'Collapse news list' : 'Expand news list');
  setTimeout(layoutInsets, 340);
  layoutInsets();
}
function layoutInsets() {
  const panel = $('#panel');
  if (mobile.matches) {
    const h = panel.dataset.sheet === 'full' ? panel.offsetHeight : panel.dataset.sheet === 'half' ? innerHeight * 0.52 : 132;
    $('#app').style.setProperty('--sheet-h-now', `${h}px`);
    globe.setInset(0, Math.min(h, innerHeight * 0.52) + 90);
  } else {
    $('#app').style.removeProperty('--sheet-h-now');
    globe.setInset(panel.offsetWidth + 14, 0);
  }
}

// ------------------------------------------------------------------ shareable URL
function writeHash() {
  const v = state.view, parts = [];
  if (v.type === 'place') parts.push(`place=${v.place.lat.toFixed(3)},${v.place.lon.toFixed(3)}`);
  if (v.type === 'country') parts.push(`country=${v.country.i3}`);
  if (v.type === 'pair') parts.push(`link=${v.a.i3},${v.b.i3}`);
  if (v.type === 'category') parts.push(`category=${cats()[v.cat].id}`);
  if (v.cat != null && v.type !== 'category') parts.push(`category=${cats()[v.cat].id}`);
  if (state.mode !== 'type') parts.push('colour=topic');
  if (state.hours !== 24) parts.push(`hours=${state.hours}`);
  if (!enabled().every(Boolean)) parts.push(`show=${cats().filter((_, k) => enabled()[k]).map((c) => c.id).join(',')}`);
  const h = parts.length ? `#${parts.join('&')}` : '';
  if (location.hash !== h) { writingHash = true; history.replaceState(null, '', h || location.pathname + location.search); writingHash = false; }
}
let writingHash = false;

function applyHash() {
  if (writingHash || !state.news) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('colour') === 'topic') setMode('topic');
  if (p.get('hours')) { const h = +p.get('hours'); if ([1, 6, 24].includes(h)) setHours(h); }
  if (p.get('show')) {
    const want = p.get('show').split(','), en = enabled();
    cats().forEach((c, k) => { en[k] = want.includes(c.id); });
    if (!en.some(Boolean)) en.fill(true);
    syncLegend(); refresh();
  }
  const catIdx = p.get('category') ? cats().findIndex((c) => c.id === p.get('category')) : -1;
  const cat = catIdx >= 0 ? catIdx : null;
  if (p.get('country')) {
    const c = findCountry(p.get('country'));
    if (c) selectCountry(c, true, cat);
  } else if (p.get('link')) {
    const [a, b] = p.get('link').split(',').map(findCountry);
    if (a && b) select({ type: 'pair', a, b });
  } else if (p.get('place')) {
    const [lat, lon] = p.get('place').split(',').map(Number);
    const best = state.news.places.filter((x) => x.prec > 1)
      .map((x) => ({ x, d: distanceKm(lat, lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d)[0];
    if (best && best.d < 5) { selectPlace(best.x, true); if (cat != null) { state.view.cat = cat; renderPanel(); } }
  } else if (cat != null) {
    select({ type: 'category', cat });
  } else if (state.view.type !== 'overview') select({ type: 'overview' });
}

// History powers "Unusual activity" and country trends; fetch it quietly.
loadHistory().then(() => { if (state.news) renderPanel(); });
