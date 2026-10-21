# Earthwire

**The world’s news, where it happens.** A holographic globe of the last 24 hours of world news, built on
[GDELT](https://www.gdeltproject.org/). It runs entirely on GitHub Pages, updates itself every 30 minutes and
can be installed on a phone like an app.

Dots can be coloured two ways:

**By event type** (what happened, from GDELT’s event coding)

| Colour | Type | Covers |
|---|---|---|
| Red | Conflict | Fighting, attacks, mass violence |
| Orange | Security | Arrests, crackdowns, military posturing |
| Yellow | Protest | Demonstrations, strikes, riots |
| Violet | Tension | Accusations, demands, threats, sanctions |
| Blue | Diplomacy | Statements, talks, visits, agreements |
| Green | Cooperation | Aid, joint work, releases |
| Slate | General | Reporting with no political event: business, science, culture and more |

**By topic** (what the story is about, from GDELT’s Global Knowledge Graph themes): politics, economy,
tech & science, health, environment, disasters, food & farming, energy, crime & justice and society.

A solid dot is a specific city or landmark. A ring is the centre of a state or province, used when the story
names nothing more precise. Stories that only name a country are listed when you open that country, so the map
never pretends a country-wide story happened at a country’s midpoint.

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
- The **pause button** (or the **space bar**) stops and starts the slow spin. The globe also holds still while
  you’re looking at a place, and starts again when you go back to all news.
- **Click a dot** for its stories, **click a country** for everything located there, or **click a category**
  in the side panel to list every story in it.
- **Search** for a country, city or category (press `/`). **Esc** goes back to all news.
- **Colour by** switches the dots between event type and topic. Click a legend chip to hide or show it;
  double-click to show only that one.
- Choose **1 hour, 6 hours or 24 hours** (or click the coloured time in the panel title).
- **Cross-border links** are arcs between countries whose people or governments act on each other. Open a
  country to see its connected countries, then open a pair to read the stories linking them.
- **Unusual activity** appears once a week of history has built up: categories running well above a country’s
  normal daily level.
- **Data** opens charts: stories per hour, event and topic shares, top countries, strongest links, languages,
  sources, tone of coverage and daily totals going back up to four months.
- **Layers** adds population, day and night, Antarctic stations, air routes, shipping lanes, live wind, clouds
  and temperature. Each layer is explained in the menu and in About.
- Places show the **local weather** from Open-Meteo.
- **Install it:** on a phone, open the site and choose *Add to Home Screen* (Safari: Share menu; Chrome: ⋮ menu).
  It opens full screen with its own icon.
- The address bar always reflects what you’re looking at, so any view can be shared as a link.

---

## How it works

```
GitHub Actions (every 30 min)
  pipeline/build_news.py
    ├─ downloads GDELT 2.0 event exports AND Global Knowledge Graph files for the last 24 h
    │  (English + Translingual, 65 languages); each 15-minute file is cached, so only new ones download
    ├─ events give the event type, location and the countries involved (cross-border links)
    ├─ GKG gives topics, real page titles, source language, and news that has no political event
    ├─ merges both into one story per article, picks where each story happened
    ├─ selects up to 8,000 stories: the newest hour for every place, every place's top story,
    │  a quota for every event type and topic, then the rest by coverage
    ├─ writes site/data/news.json
    └─ updates site/data/history.json: daily counts per country, carried forward from the live site
  pipeline/build_weather.py
    └─ a 7.5° global grid of current conditions from Open-Meteo, refreshed every 4 hours
  → deploys site/ to GitHub Pages

Browser
  plain HTML, CSS and JavaScript modules + three.js (no build step); a service worker makes it installable
```

```
.github/workflows/
  update-and-deploy.yml   scheduled news + weather build and Pages deploy
  keepalive.yml           monthly empty commit so schedules stay active
  build-population.yml    optional, manual: rebuild the population layer at higher resolution
pipeline/
  build_news.py           GDELT → news.json + history.json (Python standard library only)
  build_weather.py        Open-Meteo → weather.json
  cameo.py                event codes, plain-English descriptions, event types
  topics.py               GKG themes → topics
tools/
  build_static_data.py    rebuilds borders, cities, routes, lanes, land mask
  build_population.py     rebuilds the WorldPop population texture
site/
  index.html, css/, js/, sw.js, manifest.webmanifest
  data/                   countries, cities, air routes, shipping lanes, stations (+ generated news, history, weather)
  assets/                 land mask, population texture, icons
  vendor/                 three.js r169
```

### Settings

Change these in `.github/workflows/update-and-deploy.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `EW_HOURS` | `24` | Hours of news on the map |
| `EW_MAX_STORIES` | `8000` | Stories included in `news.json` (all stories still count toward dot sizes and charts) |
| `EW_TRANSLINGUAL` | `1` | Include GDELT’s non-English coverage (`0` for English sources only) |
| `EW_GKG` | `1` | Include the Global Knowledge Graph (topics, titles, general news). `0` makes runs much faster but drops topics |
| `EW_TITLE_FETCH` | `200` | Headlines fetched from publishers per run, for stories GDELT has no title for |
| `EW_WEATHER_MAX_AGE` | `240` | Minutes before the weather grid is refreshed (keeps within Open-Meteo’s free limit) |

**The first run takes longer** (roughly 10–25 minutes) because it downloads a full day of GDELT files, including
the large Knowledge Graph files. Later runs only download the newest files and take a few minutes.

### Sharper population layer (optional)

The population dots come from a WorldPop texture. To rebuild it at twice the resolution, go to
**Actions → Rebuild population layer → Run workflow**. It commits a new texture, which goes live with the next
scheduled update.

### Running it on your own computer

```bash
python pipeline/build_news.py        # Python 3.10+, no packages
python pipeline/build_weather.py
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

Stories from non-English sources get an English summary headline written from GDELT’s coding (for example
“Demonstration or rally in Lyon, France”), with the original headline and a *Read in English* link that opens the
article through Google Translate. Headlines that couldn’t be found at all are rebuilt from the article’s web
address and shown in a lighter weight.

History starts on your first deployment and needs about a week before *Unusual activity* appears. If the site
goes more than a day without an update, that gap is missing from the daily history.

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

### Version 2 (user-testing update)

- Topics from GDELT’s Knowledge Graph, plus general news that isn’t a political event.
- Cross-border links, connected countries and country-pair views.
- Clickable categories, a Data dashboard, unusual-activity alerts and daily history.
- Pause/resume button and space bar; the globe holds still while a place is open.
- Population redrawn as a sharp dot matrix with towns boosted, so sparsely populated countries show.
- Day and night, live wind, clouds, temperature and local weather; Antarctic research stations.
- Installable on phones; English summary headlines and translation links for non-English sources.
- Clearer navigation, layer explanations, distinct air and sea colours, and the 1-hour “not mapped” bug fixed.

---

## Credits and licences

- News events: [The GDELT Project](https://www.gdeltproject.org/) — free for any use with attribution.
- Population: WorldPop (2018), Global High Resolution Population Denominators Project, 2020 1 km density,
  DOI 10.5258/SOTON/WP00674 — CC BY 4.0. Cleaned for display by `tools/build_static_data.py`.
- Borders, lakes and cities: [Natural Earth](https://www.naturalearthdata.com/) — public domain. Borders are shown
  as Natural Earth draws them and don’t imply any position on disputed territory.
- Weather: [Open-Meteo](https://open-meteo.com/) — CC BY 4.0, free for non-commercial use.
- Antarctic stations: positions from the COMNAP station catalogue.
- Air routes: [OpenFlights](https://openflights.org/data) route and airport data (2014 snapshot) — ODbL.
- Shipping lanes: Benden, P. (2022). *Global Shipping Lanes*. Zenodo. DOI 10.5281/zenodo.6361763 — CC BY 4.0.
- Rendering: [three.js](https://threejs.org/) — MIT (see `site/vendor/three.LICENSE`).
- Fonts: Bricolage Grotesque and Atkinson Hyperlegible via Google Fonts — SIL Open Font Licence.

The Earthwire code itself has no licence file yet. Add one (MIT is a common choice) if you want others to be
able to reuse it.
