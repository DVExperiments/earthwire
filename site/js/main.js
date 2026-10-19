import { Globe } from './globe.js';
import { countryAt, distanceKm } from './geo.js';
import {
  CATEGORIES, WINDOWS, getJSON, indexNews, placeCount, storyFilter, timeAgo, safeUrl, windowIndex,
} from './data.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = new Intl.NumberFormat();
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(max-width: 820px)');
const REFRESH_MS = 10 * 60e3;

const state = {
  hours: 24,
  enabled: CATEGORIES.map(() => true),
  view: { type: 'overview' },       // overview | place | country | near
  news: null, countries: [], cities: null,
  storyLimit: 40,
};

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
bindTools();
bindSearch();
bindSheet();
$('#aboutBtn').addEventListener('click', () => $('#about').showModal());
renderAboutLegend();
layoutInsets();
mobile.addEventListener('change', layoutInsets);
addEventListener('resize', layoutInsets);

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
})();

function startView() {
  // Start facing the visitor's part of the world, guessed from their time zone.
  const jan = new Date(2026, 0, 1).getTimezoneOffset(), jul = new Date(2026, 6, 1).getTimezoneOffset();
  let lon = -Math.max(jan, jul) / 4;
  if (lon > 180) lon -= 360;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const lat = /^Australia|Auckland|Chatham/.test(tz) ? -30 : /^America\/(Argentina|Sao_Paulo|Santiago|Lima|Bogota|Montevideo)/.test(tz) ? -18
    : /^Africa/.test(tz) ? 5 : /^Europe/.test(tz) ? 40 : /^Asia/.test(tz) ? 25 : /^America/.test(tz) ? 30 : 15;
  globe.setView(lat, lon + 8, 4.4);
  globe.target.dist = 3.7;
}

async function loadNews(isRefresh) {
  try {
    const raw = await getJSON('data/news.json', { bust: isRefresh });
    if (isRefresh && state.news && Date.parse(raw.generated) === state.news.generated) return;
    const prevKey = state.view.place?.key;
    state.news = indexNews(raw, state.countries);
    if (prevKey) {
      const p = state.news.places.find((x) => x.key === prevKey);
      state.view = p ? { type: 'place', place: p } : { type: 'overview' };
    } else if (state.view.type === 'country') {
      state.view = { type: 'country', country: state.view.country };
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
  const w = windowIndex(state.hours);
  const list = [];
  for (const p of n.places) {
    p.visibleCount = 0;
    if (p.prec === 1) continue;                 // country-only stories are listed, not drawn
    const { total, top } = placeCount(p, w, state.enabled);
    if (!total) continue;
    p.visibleCount = total; p.topCat = top;
    const recent = placeCount(p, 0, state.enabled).total > 0;
    list.push({
      key: p.key, lat: p.lat, lon: p.lon, prec: p.prec, recent, ref: p,
      color: CATEGORIES[top].rgb, size: Math.min(22, 3.6 + 2.3 * Math.log(1 + total)),
    });
  }
  // country-level places still need counts for panels
  for (const p of n.places) if (p.prec === 1) {
    const { total, top } = placeCount(p, w, state.enabled); p.visibleCount = total; p.topCat = top;
  }
  list.sort((a, b) => a.size - b.size);         // big dots drawn last
  globe.setPlaces(list);
  globe.setSelected(state.view.type === 'place' ? state.view.place.key : null);
  const top = list.slice(-36).filter((x) => x.ref.visibleCount >= 3);
  const maxN = Math.max(1, ...top.map((x) => x.ref.visibleCount));
  globe.setBeams(top.map((x) => ({ lat: x.lat, lon: x.lon, color: x.color, h: 0.03 + 0.17 * Math.sqrt(x.ref.visibleCount / maxN) })));
  updateLegendCounts();
  drawSpark();
  updateStatus();
  renderPanel();
  writeHash();
}

function updateStatus() {
  const n = state.news, el = $('#status');
  const age = Date.now() - n.generated;
  el.className = `status ${age < 90 * 60e3 ? 'live' : 'stale'}`;
  const t = new Date(n.end).toISOString().slice(11, 16);
  el.textContent = `Updated ${timeAgo(n.generated)}, news to ${t} UTC`;
  el.title = `${fmt.format(n.totals.stories)} stories from ${fmt.format(n.totals.allPlaces)} places in GDELT’s last ${n.hours} hours; ${fmt.format(n.totals.kept)} are mapped here.`;
  $('#aboutFoot').textContent = `This build: ${fmt.format(n.totals.events)} GDELT events read from ${n.files.loaded} of ${n.files.expected} update files, generated ${new Date(n.generated).toUTCString()}.`;
}

// ------------------------------------------------------------------ legend / time
function buildLegend() {
  const el = $('#legend');
  el.innerHTML = CATEGORIES.map((c, i) => `
    <button class="chip" type="button" aria-pressed="true" data-i="${i}" style="--c:${c.color}" title="${esc(c.long)}. Double-click to show only this.">
      <i class="dotc"></i>${esc(c.label)} <span class="n" data-n="${i}"></span>
    </button>`).join('');
  let timer;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const i = +b.dataset.i;
      state.enabled[i] = !state.enabled[i];
      if (!state.enabled.some(Boolean)) state.enabled = state.enabled.map(() => true);
      syncLegend(); refresh();
    }, 220);
  });
  el.addEventListener('dblclick', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    clearTimeout(timer);
    const i = +b.dataset.i;
    const only = state.enabled.every((v, k) => v === (k === i));
    state.enabled = state.enabled.map((_, k) => only || k === i);
    syncLegend(); refresh();
  });
}
function syncLegend() {
  document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', state.enabled[+b.dataset.i]));
}
function categoryTotals(hours) {
  const n = state.news, w = windowIndex(hours), t = CATEGORIES.map(() => 0);
  for (const p of n.places) p.counts[w].forEach((v, k) => { t[k] += v; });
  return t;
}
function updateLegendCounts() {
  const t = categoryTotals(state.hours);
  document.querySelectorAll('[data-n]').forEach((s) => { s.textContent = fmt.format(t[+s.dataset.n]); });
}

function buildWindows() {
  const el = $('#windows');
  el.innerHTML = WINDOWS.map((w) => `<button type="button" role="radio" aria-checked="${w.hours === state.hours}" data-h="${w.hours}">${w.label}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setHours(+b.dataset.h);
  });
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
  const svg = $('#spark'), hist = state.news.hist, H = hist[0].length;
  const totals = Array.from({ length: H }, (_, b) => hist.reduce((s, row, k) => s + (state.enabled[k] ? row[b] : 0), 0));
  const max = Math.max(1, ...totals), bw = 240 / H;
  let out = '';
  for (let b = 0; b < H; b++) {
    const x = 240 - (b + 1) * bw;          // bucket 0 is the latest hour, drawn on the right
    let y = 34;
    const cls = b < state.hours ? '' : ' class="off"';
    out += `<g${cls}>`;
    hist.forEach((row, k) => {
      if (!state.enabled[k] || !row[b]) return;
      const h = (row[b] / max) * 32;
      y -= h;
      out += `<rect x="${(x + 0.6).toFixed(2)}" y="${y.toFixed(2)}" width="${(bw - 1.2).toFixed(2)}" height="${h.toFixed(2)}" fill="${CATEGORIES[k].color}"/>`;
    });
    out += '</g>';
  }
  svg.innerHTML = out;
}

// ------------------------------------------------------------------ panel views
function storiesFor(filterFn) {
  const f = storyFilter(state.news, state.hours, state.enabled);
  return state.news.stories.filter((s) => f(s) && filterFn(s));
}

function rankStories(list) {
  return list.slice().sort((a, b) => (b.articles + b.sources * 2 + (b.realTitle ? 3 : 0)) - (a.articles + a.sources * 2 + (a.realTitle ? 3 : 0)) || b.time - a.time);
}

function storyHTML(s, showPlace) {
  const url = safeUrl(s.url); if (!url) return '';
  const c = CATEGORIES[s.cat];
  const head = s.headline || `${s.event} in ${s.place.short}`;
  const who = [s.actor1, s.actor2].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const ev = `<span class="ev">${esc(s.event)}</span>${who.length ? `, involving ${esc(who.join(' and '))}` : ''}`;
  return `<li class="story" style="--c:${c.color}">
    <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">
      <span class="story-h${s.realTitle ? '' : ' derived'}">${esc(head)}</span>
      <span class="story-ev">${ev}${showPlace ? ` in ${esc(s.place.short)}` : ''}</span>
      <span class="story-meta"><span class="src">${esc(s.domain)}</span><span>${timeAgo(s.time)}</span>${s.translated ? '<span class="tag">Translated source</span>' : ''}</span>
    </a></li>`;
}

function storyList(list, showPlace) {
  if (!list.length) return `<p class="empty">No mapped stories match the current filters. Try a longer time window or turn more news types back on.</p>`;
  const shown = list.slice(0, state.storyLimit);
  return `<ul class="stories">${shown.map((s) => storyHTML(s, showPlace)).join('')}</ul>
    ${list.length > shown.length ? `<button class="more" type="button" data-more>Show ${Math.min(40, list.length - shown.length)} more of ${fmt.format(list.length - shown.length)}</button>` : ''}`;
}

function mixHTML(counts) {
  const total = counts.reduce((a, b, k) => a + (state.enabled[k] ? b : 0), 0);
  const bar = counts.map((v, k) => state.enabled[k] && v ? `<span style="--c:${CATEGORIES[k].color};flex:${v}"></span>` : '').join('');
  const key = counts.map((v, k) => state.enabled[k] ? `<li style="--c:${CATEGORIES[k].color}"><i></i>${CATEGORIES[k].label}<b>${fmt.format(v)}</b></li>` : '').join('');
  return total ? `<div class="mix" role="img" aria-label="Share of stories by type">${bar}</div><ul class="mix-key">${key}</ul>` : '';
}

function windowPhrase() { return state.hours === 1 ? 'the last hour' : `the last ${state.hours} hours`; }

function placeButtons(places, max) {
  const w = windowIndex(state.hours);
  const list = places.filter((p) => p.visibleCount > 0).sort((a, b) => b.visibleCount - a.visibleCount).slice(0, max);
  const top = Math.max(1, ...list.map((p) => p.visibleCount));
  return `<ul class="places">${list.map((p) => `<li><button type="button" data-place="${p.i}" style="--c:${CATEGORIES[p.topCat]?.color || '#6ff3e6'}">
      <span class="pl-name">${esc(p.prec === 1 ? `${p.short} (country-wide)` : p.short)}</span><span class="pl-n">${fmt.format(p.visibleCount)}</span>
      <span class="pl-bar"><span style="width:${(p.visibleCount / top * 100).toFixed(1)}%"></span></span></button></li>`).join('')}</ul>`;
}

function renderPanel() {
  const v = state.view, body = $('#panelBody');
  const n = state.news;
  let html = '';
  if (v.type === 'overview') {
    const counts = categoryTotals(state.hours);
    const total = counts.reduce((a, b, k) => a + (state.enabled[k] ? b : 0), 0);
    const placeN = n.places.filter((p) => p.visibleCount > 0).length;
    html = `<h2>The world in ${windowPhrase()}</h2>
      <p class="lede"><b>${fmt.format(total)}</b> stories from <b>${fmt.format(placeN)}</b> places. Select a dot or search for a place to read what’s being reported there.</p>
      ${mixHTML(counts)}
      <h3>Busiest places</h3>${placeButtons(n.places.filter((p) => p.prec > 1), 8)}
      <h3>Most covered stories</h3>${storyList(rankStories(storiesFor(() => true)), true)}`;
    globe.highlightCountry(null);
  } else if (v.type === 'place') {
    const p = v.place;
    const list = rankStories(storiesFor((s) => s.place === p));
    const w = windowIndex(state.hours);
    const preciseNote = p.prec === 3 ? 'Placed at this city or landmark.'
      : p.prec === 2 ? 'Placed at the centre of this state or province; the stories didn’t name anywhere more precise.'
        : 'These stories only name the country.';
    html = `<button class="back" type="button" data-back>All news</button>
      <h2>${esc(p.short)}</h2>
      <p class="lede">${fmt.format(p.visibleCount)} ${p.visibleCount === 1 ? 'story' : 'stories'} in ${windowPhrase()}${list.length < p.visibleCount ? `, ${fmt.format(list.length)} listed here` : ''}.</p>
      <p class="prec"><span class="glyph ${p.prec === 3 ? 'solid' : 'ring'}"></span>${preciseNote}</p>
      ${p.country ? `<p class="prec">Part of <button class="linkish" type="button" data-country="${esc(p.country.i3)}">${esc(p.country.n)}</button></p>` : ''}
      ${mixHTML(p.counts[w])}
      <h3>Stories</h3>${storyList(list, false)}
      <a class="ext" href="${gdeltSearch(p)}" target="_blank" rel="noopener">Search all GDELT coverage of ${esc(p.short.split(',')[0])}</a>`;
    globe.highlightCountry(p.country);
  } else if (v.type === 'country') {
    const c = v.country;
    const inC = n.places.filter((p) => p.cc && p.cc === c.f);
    const w = windowIndex(state.hours);
    const counts = CATEGORIES.map(() => 0);
    inC.forEach((p) => p.counts[w].forEach((x, k) => { counts[k] += x; }));
    const total = counts.reduce((a, b, k) => a + (state.enabled[k] ? b : 0), 0);
    const list = rankStories(storiesFor((s) => s.place.cc === c.f));
    html = `<button class="back" type="button" data-back>All news</button>
      <h2>${esc(c.nl || c.n)}</h2>
      <p class="lede"><b>${fmt.format(total)}</b> stories in ${windowPhrase()}${c.pop ? `. Population about ${fmtPop(c.pop)}` : ''}.</p>
      ${c.f ? '' : '<p class="note">GDELT doesn’t code this territory separately, so its stories may be listed under a neighbouring country.</p>'}
      ${total ? mixHTML(counts) : ''}
      ${inC.some((p) => p.visibleCount) ? `<h3>Places</h3>${placeButtons(inC, 10)}` : ''}
      <h3>Stories</h3>${storyList(list, true)}`;
    globe.highlightCountry(c);
  } else if (v.type === 'near') {
    const { city, nearby } = v;
    html = `<button class="back" type="button" data-back>All news</button>
      <h2>${esc(city.name)}</h2>
      <p class="lede">No mapped stories within 40 km of ${esc(city.name)} in ${windowPhrase()}.</p>
      ${nearby.length ? `<h3>Nearest places with news</h3>${placeButtons(nearby, 8)}` : ''}
      ${city.countryObj ? `<p class="prec">See all of <button class="linkish" type="button" data-country="${esc(city.countryObj.i3)}">${esc(city.countryObj.n)}</button></p>` : ''}`;
    globe.highlightCountry(city.countryObj);
  }
  body.innerHTML = html;
}

function renderNoNews() {
  $('#panelBody').innerHTML = `<div class="empty"><h2>No news to show yet</h2>
    <p>The news file hasn’t been built. It’s created by the “Update news and deploy” workflow, which runs on every push and every 30 minutes.
    If this stays empty, open the repository’s Actions tab and check the latest run.</p></div>`;
  $('#status').textContent = 'No news data';
  $('#status').className = 'status';
}

function fmtPop(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(1)} billion` : n >= 1e6 ? `${Math.round(n / 1e5) / 10} million` : fmt.format(n); }

function gdeltSearch(p) {
  const name = p.short.split(',')[0];
  const span = state.hours <= 1 ? '1h' : state.hours <= 6 ? '6h' : '24h';
  return `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${name}"`)}&mode=artlist&maxrecords=75&sort=datedesc&timespan=${span}`;
}

$('#panelBody').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.hasAttribute('data-back')) { select({ type: 'overview' }); }
  else if (t.hasAttribute('data-more')) { state.storyLimit += 40; renderPanel(); }
  else if (t.dataset.place) { const p = state.news.places[+t.dataset.place]; selectPlace(p, true); }
  else if (t.dataset.country) { const c = state.countries.find((x) => x.i3 === t.dataset.country); if (c) selectCountry(c, true); }
});

function select(view) {
  state.view = view; state.storyLimit = 40;
  globe.setSelected(view.type === 'place' ? view.place.key : null);
  renderPanel();
  $('#panelBody').scrollTop = 0;
  writeHash();
  if (mobile.matches && view.type !== 'overview') setSheet('half');
}

function selectPlace(p, fly) {
  if (p.prec === 1 && p.country) return selectCountry(p.country, fly);
  select({ type: 'place', place: p });
  if (fly) globe.flyTo(p.lat, p.lon, Math.min(globe.view.dist, 2.1));
}

function selectCountry(c, fly) {
  select({ type: 'country', country: c });
  if (fly) {
    const [x0, y0, x1, y1] = c.bb.map((v) => v / 100);
    const span = Math.max(x1 - x0, (y1 - y0) * 1.4);
    globe.flyTo(c.ly, c.lx, Math.max(1.35, Math.min(3.1, 1.15 + span / 28)));
  }
}

// ------------------------------------------------------------------ globe interaction
const tip = $('#tip');
function onHover(hit) {
  if (!hit || !hit.place) { tip.hidden = true; canvas.style.cursor = ''; return; }
  const p = hit.place.ref;
  canvas.style.cursor = 'pointer';
  const c = CATEGORIES[p.topCat];
  const top = rankStories(storiesFor((s) => s.place === p))[0];
  tip.style.setProperty('--c', c.color);
  tip.innerHTML = `<div class="tip-place">${esc(p.short)}</div>
    <div class="tip-count"><b>${fmt.format(p.visibleCount)}</b> ${p.visibleCount === 1 ? 'story' : 'stories'}, mostly ${esc(c.label.toLowerCase())}</div>
    ${top ? `<div class="tip-head">${esc(top.headline || top.event)}</div>` : ''}`;
  tip.hidden = false;
  const { w } = globe.size;
  const x = Math.min(hit.x + 16, w - globe.inset.right - tip.offsetWidth - 8);
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
  const want = [];
  const v = state.view;
  if (v.type === 'place') want.push({ text: v.place.short.split(',')[0], lat: v.place.lat, lon: v.place.lon, cls: 'label' });
  if (v.type === 'country') want.push({ text: v.country.n, lat: v.country.ly, lon: v.country.lx, cls: 'label country' });
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

// ------------------------------------------------------------------ tools + layers
function bindTools() {
  $('#zoomIn').addEventListener('click', () => globe.zoomBy(0.75));
  $('#zoomOut').addEventListener('click', () => globe.zoomBy(1.33));
  $('#homeBtn').addEventListener('click', () => globe.home());
  const btn = $('#layersBtn'), box = $('#layers');
  btn.addEventListener('click', () => { box.hidden = !box.hidden; btn.setAttribute('aria-expanded', !box.hidden); });
  document.addEventListener('click', (e) => {
    if (!box.hidden && !e.target.closest('.layers-wrap')) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
  if (reduced) box.querySelector('[data-layer="rotate"]').checked = false;
  box.addEventListener('change', async (e) => {
    const name = e.target.dataset.layer, on = e.target.checked;
    if (on && name === 'air' && !globe.air) { try { globe.setAir(await getJSON('data/air.json')); } catch (err) { console.error(err); } }
    if (on && name === 'sea' && !globe.sea) { try { globe.setSea(await getJSON('data/sea.json')); } catch (err) { console.error(err); } }
    globe.setLayer(name, on);
  });
  addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, dialog')) return;
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && state.view.type !== 'overview') select({ type: 'overview' });
    if (e.key === '+' || e.key === '=') globe.zoomBy(0.8);
    if (e.key === '-') globe.zoomBy(1.25);
  });
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
      : '<li class="r-empty" role="option" aria-disabled="true">No matching country or city</li>';
    box.hidden = false; q.setAttribute('aria-expanded', 'true');
    q.setAttribute('aria-activedescendant', active >= 0 ? `opt${active}` : '');
  };
  q.addEventListener('focus', ensureCities, { once: true });
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
    else if (e.key === 'Escape') { close(); }
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
  const ranked = (state.news?.places || []).filter((p) => p.prec > 1 && p.visibleCount > 0)
    .map((p) => ({ p, d: distanceKm(city.lat, city.lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d);
  globe.flyTo(city.lat, city.lon, Math.min(globe.view.dist, 1.9));
  if (ranked[0] && ranked[0].d <= 40) { select({ type: 'place', place: ranked[0].p }); return; }
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
  const panel = $('#panel');
  panel.dataset.sheet = s;
  $('#sheetHandle').setAttribute('aria-label', s === 'full' ? 'Collapse news list' : 'Expand news list');
  setTimeout(layoutInsets, 340);
  layoutInsets();
}
function layoutInsets() {
  const panel = $('#panel');
  if (mobile.matches) {
    const h = panel.dataset.sheet === 'full' ? panel.offsetHeight : panel.dataset.sheet === 'half' ? innerHeight * 0.52 : 132;
    $('#app').style.setProperty('--sheet-h-now', `${h}px`);
    globe.setInset(0, Math.min(h, innerHeight * 0.52) + 60);
  } else {
    $('#app').style.removeProperty('--sheet-h-now');
    globe.setInset(panel.offsetWidth + 14, 0);
  }
}

function renderAboutLegend() {
  $('#aboutLegend').innerHTML = CATEGORIES.map((c) => `<div style="--c:${c.color}"><i class="dotc"></i><span>${esc(c.label)}<small>${esc(c.long)}</small></span></div>`).join('');
}

// ------------------------------------------------------------------ shareable URL
function writeHash() {
  const v = state.view, parts = [];
  if (v.type === 'place') parts.push(`place=${v.place.lat.toFixed(3)},${v.place.lon.toFixed(3)}`);
  if (v.type === 'country') parts.push(`country=${v.country.i3}`);
  if (state.hours !== 24) parts.push(`hours=${state.hours}`);
  if (!state.enabled.every(Boolean)) parts.push(`types=${CATEGORIES.filter((_, k) => state.enabled[k]).map((c) => c.id).join(',')}`);
  const h = parts.length ? `#${parts.join('&')}` : ' ';
  if (location.hash !== h.trim()) history.replaceState(null, '', h === ' ' ? location.pathname + location.search : h);
}

function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('hours')) { const h = +p.get('hours'); if ([1, 6, 24].includes(h)) setHours(h); }
  if (p.get('types')) {
    const want = p.get('types').split(',');
    state.enabled = CATEGORIES.map((c) => want.includes(c.id));
    if (!state.enabled.some(Boolean)) state.enabled = CATEGORIES.map(() => true);
    syncLegend(); refresh();
  }
  if (!p.get('country') && !p.get('place') && state.view.type !== 'overview') select({ type: 'overview' });
  if (p.get('country')) {
    const c = state.countries.find((x) => x.i3 === p.get('country'));
    if (c) selectCountry(c, true);
  } else if (p.get('place') && state.news) {
    const [lat, lon] = p.get('place').split(',').map(Number);
    const best = state.news.places.filter((x) => x.prec > 1)
      .map((x) => ({ x, d: distanceKm(lat, lon, x.lat, x.lon) })).sort((a, b) => a.d - b.d)[0];
    if (best && best.d < 5) selectPlace(best.x, true);
  }
}
