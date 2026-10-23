import { toXYZ } from './geo.js';

// Builds an equal-area dot matrix from the WorldPop texture. Each dot is one grid
// cell; its brightness is the cell's (log-scaled) population density. Cities from
// Natural Earth light their cell too, so sparsely populated countries with real
// towns (New Zealand, Australia, Canada) stay visible.
export async function buildPopulation(textureUrl, cities) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = textureUrl; });
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const step = Math.max(0.2, 360 / W);                // grid spacing in degrees
  const rows = Math.round(180 / step);
  const cells = new Map();                            // "row:col" -> value
  const rowCols = [];
  for (let r = 0; r < rows; r++) {
    const lat = -90 + (r + 0.5) * step;
    rowCols[r] = Math.max(1, Math.round((360 / step) * Math.cos(lat * Math.PI / 180)));
    if (lat < -60 || lat > 84) continue;              // no permanent population
    const y = Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
    for (let c = 0; c < rowCols[r]; c++) {
      const lon = -180 + (c + 0.5) * (360 / rowCols[r]);
      const x = Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
      const v = px[(y * W + x) * 4] / 255;
      if (v > 0.07) cells.set(r * 100000 + c, v);
    }
  }
  for (const c of cities || []) {
    if (c.pop < 15000) continue;
    const r = Math.floor((c.lat + 90) / step);
    if (!rowCols[r]) continue;
    const col = Math.floor(((c.lon + 180) / 360) * rowCols[r]) % rowCols[r];
    const key = r * 100000 + col;
    const v = Math.max(0.3, Math.min(1, (Math.log10(c.pop) - 3.9) / 3.0));
    cells.set(key, Math.max(cells.get(key) || 0, v));
  }
  const n = cells.size;
  const positions = new Float32Array(n * 3), values = new Float32Array(n), tmp = [0, 0, 0];
  // A perfectly regular grid beats against the screen's pixel grid while the globe
  // turns (moiré). A fixed random offset inside each cell breaks that up.
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let i = 0;
  for (const [key, v] of cells) {
    const r = Math.floor(key / 100000), c = key % 100000;
    const lat = -90 + (r + 0.5 + (rand() - 0.5) * 0.8) * step;
    const lon = -180 + (c + 0.5 + (rand() - 0.5) * 0.8) * (360 / rowCols[r]);
    toXYZ(lat, lon, 1.0012, tmp);
    positions.set(tmp, i * 3);
    values[i++] = Math.min(1, Math.pow(v, 1.25) * 1.08);
  }
  return { positions, values, step };
}
