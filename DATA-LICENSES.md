# Data and third-party licences

The MIT licence in `LICENSE` covers Earthwire's own code. Everything below belongs
to its creators and keeps its own terms. If you reuse these files, keep the credits.

| What | Where in the repo | Source | Licence |
|---|---|---|---|
| News events, topics and headlines | `site/data/news.json`, `history.json` (generated) | [The GDELT Project](https://www.gdeltproject.org/) | Free for any use, with attribution to GDELT |
| Weather | `site/data/weather.json` (generated) and local weather | [Open-Meteo](https://open-meteo.com/) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the free API is for non-commercial use |
| Population density | `site/assets/population-density.png` | WorldPop (2018), Global High Resolution Population Denominators Project, DOI [10.5258/SOTON/WP00674](https://dx.doi.org/10.5258/SOTON/WP00674) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Borders, land mask, lakes, cities | `site/data/countries.json`, `cities.json`, `site/assets/land.png` | [Natural Earth](https://www.naturalearthdata.com/) | Public domain |
| Air routes | `site/data/air.json` | [OpenFlights](https://openflights.org/data) airports and routes | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| Shipping lanes | `site/data/sea.json` | Benden, P. (2022). *Global Shipping Lanes*. DOI [10.5281/zenodo.6361763](https://doi.org/10.5281/zenodo.6361763) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Antarctic stations | `site/data/stations.json` | Positions from the COMNAP station catalogue | Facts, credited to COMNAP |
| three.js | `site/vendor/three.module.min.js` | [three.js authors](https://threejs.org/) | MIT (`site/vendor/three.LICENSE`) |
| Fonts | loaded from Google Fonts | Bricolage Grotesque, Atkinson Hyperlegible | SIL Open Font Licence 1.1 |

## Notes

**Air routes (ODbL).** `site/data/air.json` is a database derived from OpenFlights, so
it stays under the ODbL: anyone may reuse it, but a modified version of that file must
also be shared under the ODbL. This applies only to that file, not to Earthwire's code.

**Weather (Open-Meteo).** The free Open-Meteo API is for non-commercial use. If
Earthwire is ever used commercially, a paid Open-Meteo plan is needed.

**Population texture.** Earthwire's version is resampled and cleaned (ocean and lake
no-data removed), which counts as an adaptation under CC BY 4.0. Changes are made by
`tools/build_static_data.py` and `tools/build_population.py`.

**Borders** are shown as Natural Earth draws them and don't imply any position on
disputed territory.
