import { TYPES, TOPICS } from './data.js';

const fmt = new Intl.NumberFormat();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function donut(values, cats, title, unit = 'stories') {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const R = 62, r = 40, C = 80;
  let a0 = -Math.PI / 2, paths = '';
  values.forEach((v, k) => {
    if (!v) return;
    const a1 = a0 + (v / total) * Math.PI * 2 - 0.004;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${(C + rad * Math.cos(ang)).toFixed(2)} ${(C + rad * Math.sin(ang)).toFixed(2)}`;
    paths += `<path d="M${p(R, a0)} A${R} ${R} 0 ${big} 1 ${p(R, a1)} L${p(r, a1)} A${r} ${r} 0 ${big} 0 ${p(r, a0)}Z" fill="${cats[k].color}"><title>${esc(cats[k].label)}: ${fmt.format(v)} (${Math.round(v / total * 100)}%)</title></path>`;
    a0 = a1 + 0.004;
  });
  const key = values.map((v, k) => ({ v, k })).filter((x) => x.v).sort((a, b) => b.v - a.v)
    .map(({ v, k }) => `<li style="--c:${cats[k].color}"><i></i>${esc(cats[k].label)}<b>${Math.round(v / total * 100)}%</b></li>`).join('');
  return `<div class="ch-donut"><svg viewBox="0 0 160 160" role="img" aria-label="${esc(title)}">${paths}
    <text x="80" y="76" text-anchor="middle" class="ch-big">${fmt.format(total)}</text>
    <text x="80" y="96" text-anchor="middle" class="ch-small">${unit}</text></svg><ul class="ch-key">${key}</ul></div>`;
}

function stacked(series, cats, labelLeft, labelRight) {
  const W = 600, H = 170, n = series[0]?.length || 0;
  if (!n) return '<p class="ch-note">No data yet.</p>';
  const totals = Array.from({ length: n }, (_, b) => series.reduce((s, row) => s + row[b], 0));
  const max = Math.max(1, ...totals);
  const x = (b) => W - (b + 0.5) * (W / n);            // bucket 0 = newest, on the right
  const y = (v) => H - 4 - (v / max) * (H - 14);
  const base = new Array(n).fill(0);
  let out = '';
  series.forEach((row, k) => {
    if (!row.some(Boolean)) return;
    const top = row.map((v, b) => base[b] + v);
    const d = `M${top.map((v, b) => `${x(b).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${base.map((v, b) => `${x(b).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('L')}Z`;
    out += `<path d="${d}" fill="${cats[k].color}" fill-opacity="0.78"><title>${esc(cats[k].label)}</title></path>`;
    top.forEach((v, b) => { base[b] = v; });
  });
  const grid = [0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="ch-grid"/><text x="4" y="${y(max * f) + 12}" class="ch-small">${fmt.format(Math.round(max * f))}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="ch-wide" role="img" aria-label="Stories per hour">${grid}${out}</svg>
    <div class="ch-axis"><span>${labelLeft}</span><span>${labelRight}</span></div>`;
}

function bars(items, max) {
  max = max || Math.max(1, ...items.map((i) => i.value));
  return `<ul class="ch-bars">${items.map((i) => `<li><span class="ch-label">${esc(i.label)}</span><span class="ch-val">${fmt.format(i.value)}</span>
    <span class="ch-track">${i.segments
      ? i.segments.map((s) => s.v ? `<span style="width:${(s.v / max * 100).toFixed(2)}%;background:${s.color}"></span>` : '').join('')
      : `<span style="width:${(i.value / max * 100).toFixed(2)}%;background:${i.color || 'var(--holo)'}"></span>`}</span></li>`).join('')}</ul>`;
}

function toneChart(bins) {
  const W = 600, H = 120, max = Math.max(1, ...bins), bw = W / bins.length;
  const rects = bins.map((v, i) => {
    const t = i - 10;
    const color = t < -1 ? '#ff6b7f' : t > 1 ? '#4fe3a0' : '#a9c4cf';
    const h = (v / max) * (H - 10);
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" fill-opacity=".8"><title>Tone ${t}: ${fmt.format(v)} stories</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="ch-wide" role="img" aria-label="Tone of coverage">${rects}</svg>
    <div class="ch-axis"><span>More negative</span><span>Neutral</span><span>More positive</span></div>`;
}

export function dailySeries(history, dim, filterCc) {
  const days = Object.keys(history?.days || {}).sort();
  const offset = dim === 'type' ? 0 : TYPES.length;
  const cats = dim === 'type' ? TYPES : TOPICS;
  const series = cats.map(() => new Array(days.length).fill(0));
  days.forEach((d, i) => {
    for (const [cc, row] of Object.entries(history.days[d])) {
      if (filterCc && cc !== filterCc) continue;
      cats.forEach((_, k) => { series[k][days.length - 1 - i] += row[offset + k] || 0; });
    }
  });
  return { days, series };
}

export function renderCharts(el, { news, history, mode, countryName, pairName }) {
  const typeTotals = TYPES.map((_, k) => news.places.reduce((s, p) => s + p.counts.type[2][k], 0));
  const topicTotals = TOPICS.map((_, k) => news.places.reduce((s, p) => s + p.counts.topic[2][k], 0));
  const byCountry = new Map();
  for (const p of news.places) {
    const key = p.cc || '??';
    const row = byCountry.get(key) || TYPES.map(() => 0);
    p.counts.type[2].forEach((v, k) => { row[k] += v; });
    byCountry.set(key, row);
  }
  const topCountries = [...byCountry.entries()].map(([cc, row]) => ({ cc, row, value: row.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.value - a.value).slice(0, 12)
    .map((c) => ({ label: countryName(c.cc), value: c.value, segments: c.row.map((v, k) => ({ v, color: TYPES[k].color })) }));
  const pairs = news.pairs.slice().sort((a, b) => b.n[2] - a.n[2]).slice(0, 10)
    .map((p) => ({ label: pairName(p), value: p.n[2], color: TYPES[p.top].color }));
  const langs = (news.stats.langs || []).map(([label, value]) => ({ label, value, color: '#7fd8ff' }));
  const domains = (news.stats.domains || []).slice(0, 12).map(([label, value]) => ({ label, value, color: '#a9c4cf' }));
  const hours = news.hist[0].length;
  const series24 = mode === 'type' ? news.hist : news.thist;
  const cats = mode === 'type' ? TYPES : TOPICS;
  const daily = dailySeries(history, mode);
  const dailyBlock = daily.days.length >= 2
    ? stacked(daily.series, cats, daily.days[0], daily.days[daily.days.length - 1])
    : `<p class="ch-note">History starts building from your first deployment. After a few days this chart shows daily totals going back up to four months.</p>`;
  el.innerHTML = `
    <section class="ch-card ch-span"><h3>Stories per hour, last ${hours} hours</h3>
      <p class="ch-sub">Coloured by ${mode === 'type' ? 'event type' : 'topic'}. Switch colouring with the legend on the map.</p>
      ${stacked(series24, cats, `${hours} h ago`, 'Now')}</section>
    <section class="ch-card"><h3>What kind of events</h3>${donut(typeTotals, TYPES, 'Share of stories by event type')}</section>
    <section class="ch-card"><h3>What topics</h3><p class="ch-sub">A story can have two topics.</p>${donut(topicTotals, TOPICS, 'Share of topic tags', 'topic tags')}</section>
    <section class="ch-card"><h3>Most reported countries</h3>${bars(topCountries)}</section>
    <section class="ch-card"><h3>Strongest cross-border links</h3><p class="ch-sub">Stories where people or groups from two countries act on each other.</p>${pairs.length ? bars(pairs) : '<p class="ch-note">No links in this build.</p>'}</section>
    <section class="ch-card ch-span"><h3>Daily stories</h3>${dailyBlock}</section>
    <section class="ch-card"><h3>Languages of sources</h3>${bars(langs)}</section>
    <section class="ch-card"><h3>Most active sources</h3>${bars(domains)}</section>
    <section class="ch-card ch-span"><h3>Tone of coverage</h3><p class="ch-sub">GDELT scores each article’s wording from negative to positive. Most news leans negative.</p>${toneChart(news.stats.tone || [])}</section>
    <p class="ch-foot">All counts are for the last ${news.hours} hours unless shown otherwise: ${fmt.format(news.totals.stories)} stories from ${fmt.format(news.totals.allPlaces)} places.</p>`;
}

export function sparkline(values, color, w = 300, h = 46) {
  if (!values.length) return '';
  const max = Math.max(1, ...values), bw = w / values.length;
  return `<svg viewBox="0 0 ${w} ${h}" class="ch-spark" preserveAspectRatio="none">${values.map((v, i) => {
    const bh = (v / max) * (h - 2);
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"/>`;
  }).join('')}</svg>`;
}
