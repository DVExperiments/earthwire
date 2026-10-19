# Earthwire

**The world’s news, where it happens.** A holographic globe of the last 24 hours of world news, built on
[GDELT](https://www.gdeltproject.org/). It runs entirely on GitHub Pages and updates itself every 30 minutes.

Each dot is a news story placed where the event it describes happened, coloured by type:

| Colour | Type | What it covers (GDELT CAMEO codes) |
|---|---|---|
| Red | Conflict | Fighting, attacks, mass violence (18–20) |
| Orange | Security | Arrests, crackdowns, military posturing (15, 17) |
| Yellow | Protest | Demonstrations, strikes, riots (14) |
| Violet | Tension | Accusations, demands, threats, sanctions (09–13, 16) |
| Blue | Diplomacy | Statements, appeals, talks, visits, agreements (01–05) |
| Green | Cooperation | Aid, joint work, releases (06–08) |

A solid dot is a specific city or landmark. A ring is the centre of a state or province, used when the story
names nothing more precise. Stories that only name a country aren’t drawn as dots — they’re listed when you open
that country, so the map never pretends a country-wide story happened at a country’s midpoint.

---

## Setting it up

1. Create a new **public** repository on GitHub (for example `earthwire`).
2. Unzip this folder and upload **everything inside it** to the repository root, including the hidden
   `.github` folder. (On the GitHub website: *Add file → Upload files*, then drag the contents in. If your
   computer hides the `.github` folder, turn on “show hidden files” first.)
3. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Go to the **Actions** tab. If it asks, click the button to enable workflows. Open
   **Update news and deploy** and click **Run workflow**.
5. After 3–6 minutes the run finishes and the site is live at
   `https://<your-username>.github.io/<repository-name>/`.

From then on it updates by itself every 30 minutes. The first run downloads a full day of GDELT files
(a few minutes); later runs only download the new 15-minute files.

### If something goes wrong

- **The site says “No news to show yet”.** The news build hasn’t succeeded yet. Open the latest run in the
  Actions tab and look at the *Build news from GDELT* step.
- **A run shows a yellow warning about GDELT.** GDELT was briefly unreachable, so the workflow re-published the
  previous news. The next run will usually catch up on its own.
- **Updates stop after a couple of months.** GitHub pauses scheduled workflows in quiet repositories. The
  included *Keep scheduled updates alive* workflow prevents this; if it ever happens, go to Actions and re-enable
  the workflow.

---

## Using it

- **Drag** to spin, **scroll or pinch** to zoom, **double-click** to zoom into a spot.
- **Click a dot** to read its stories, or **click a country** to see everything located there.
- **Search** for any country or city (press `/` to jump to the search box).
- **Click a type** in the legend to hide or show it; **double-click** one to show only that type.
- Switch between the **last hour, 6 hours or 24 hours**. The bar chart shows stories per hour for the whole day.
- **Layers** turns on population, real air routes and real shipping lanes.
- The address bar always reflects what you’re looking at, so you can share a link to a place, a country, a time
  window or a filter.

---

## How it works

```
GitHub Actions (every 30 min)
  pipeline/build_news.py
    ├─ reads GDELT 2.0 event exports for the last 24 h (English + Translingual, 65 languages)
    ├─ keeps only geocoded events, one story per article URL
    ├─ picks each story's best event (lead event, most precise place, most coverage)
    ├─ selects up to 6,000 stories: every place gets its top story first, then the rest by coverage
    ├─ fetches real headlines for the top stories (cached between runs)
    └─ writes site/data/news.json
  → deploys site/ to GitHub Pages

Browser
  site/index.html + js/*.js + vendor/three.module.min.js (no build step)
```

```
.github/workflows/
  update-and-deploy.yml   scheduled news build + Pages deploy
  keepalive.yml           monthly empty commit so schedules stay active
pipeline/
  build_news.py           GDELT → news.json (Python standard library only)
  cameo.py                event codes, plain-English descriptions, category mapping
tools/
  build_static_data.py    rebuilds the static geography layers (only needed to refresh them)
site/
  index.html, css/, js/   the app
  data/                   countries, cities, air routes, shipping lanes (+ news.json, generated)
  assets/                 land mask, population texture, icon
  vendor/                 three.js r169
```

### Settings

Change these in `.github/workflows/update-and-deploy.yml`, under the *Build news from GDELT* step:

| Variable | Default | Meaning |
|---|---|---|
| `EW_HOURS` | `24` | Hours of news kept on the map |
| `EW_MAX_STORIES` | `6000` | Stories included in `news.json` (all stories still count toward dot sizes) |
| `EW_TRANSLINGUAL` | `1` | Include GDELT’s translated non-English coverage (`0` for English sources only) |
| `EW_TITLE_FETCH` | `350` | New headlines fetched from publishers per run |

To change how often it updates, edit the `cron` line (GitHub runs schedules every 5 minutes at most, and
often a few minutes late).

### Running it on your own computer

```bash
python pipeline/build_news.py        # needs Python 3.10+, no packages
cd site && python -m http.server 8000
# open http://localhost:8000
```

---

## Accuracy and limits

GDELT codes events and locations by machine. Some stories land in the wrong place or category, and a place can
appear because it was mentioned rather than because something happened there. Earthwire reduces this by
using each article’s lead event, preferring precise locations and never drawing country-only stories as dots,
but it can’t remove it. Read the map as a picture of where the world’s attention is, and read the original
reporting for the facts.

Headlines that couldn’t be fetched from the publisher are rebuilt from the article’s web address and shown in
a lighter weight.

---

## What changed from WorldPulse

- **GDELT instead of RSS.** Coverage of the whole world in 100+ languages, with coordinates for each event,
  instead of guessing places from RSS text.
- **One clean pipeline** (two files) replacing around 40 layered patch scripts.
- **Population layer fixed.** The old texture stored oceans and lakes as maximum density, so the sea glowed.
  It’s now masked, with coastal cities kept bright.
- **Real networks.** Air routes from OpenFlights and shipping lanes from a CIA-derived dataset replace the
  hand-drawn “illustrative” corridors.
- **Location precision is visible** (solid dot, ring, or country list) instead of every story looking equally
  certain.
- **No build tools.** The site is plain HTML, CSS and JavaScript modules; three.js is included.
- **Resilient updates.** Cached downloads, automatic fallback to the last good data, and self-cleaning caches.

---

## Credits and licences

- News events: [The GDELT Project](https://www.gdeltproject.org/) — free for any use with attribution.
- Population: WorldPop (2018), Global High Resolution Population Denominators Project, 2020 1 km density,
  DOI 10.5258/SOTON/WP00674 — CC BY 4.0. Cleaned for display by `tools/build_static_data.py`.
- Borders, lakes and cities: [Natural Earth](https://www.naturalearthdata.com/) — public domain. Borders are shown
  as Natural Earth draws them and don’t imply any position on disputed territory.
- Air routes: [OpenFlights](https://openflights.org/data) route and airport data (2014 snapshot) — ODbL.
- Shipping lanes: Benden, P. (2022). *Global Shipping Lanes*. Zenodo. DOI 10.5281/zenodo.6361763 — CC BY 4.0.
- Rendering: [three.js](https://threejs.org/) — MIT (see `site/vendor/three.LICENSE`).
- Fonts: Bricolage Grotesque and Atkinson Hyperlegible via Google Fonts — SIL Open Font Licence.

The Earthwire code itself has no licence file yet. Add one (MIT is a common choice) if you want others to be
able to reuse it.
