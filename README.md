# labs.klymot.com

Source for [labs.klymot.com](https://labs.klymot.com) — a sub-brand of klymot.com hosting hands-on, interactive explorations of climate data. Each lab is a single scrolling page where the reader makes the analytical choices themselves, with charts that behave identically to the main klymot.com site. The design philosophy and visual identity are documented in [STYLE-GUIDE.md](./STYLE-GUIDE.md).

## Repository layout

```
.
├── src/
│   ├── layouts/          # Shared Astro layout components (BaseLayout.astro)
│   └── pages/            # One .astro file per URL
│       ├── index.astro   # Labs index (labs.klymot.com/)
│       ├── sunshine-temperature/
│       │   └── index.astro
│       └── network-altitude/
│           └── index.astro
├── public/               # Static assets — copied verbatim into docs/ at build time
│   ├── CNAME
│   ├── sunshine-temperature/
│   │   └── data/         # Per-station JSON data files (managed by the data pipeline)
│   └── network-altitude/
│       └── data/         # network-altitude.json + station-ids.json (managed by the data pipeline)
├── docs/                 # BUILD OUTPUT — committed to git, served by GitHub Pages
│   └── ...               # Do not edit by hand; always regenerate with npm run build
├── scripts/              # Python data-fetching scripts
│   ├── fetch_sunshine.py
│   └── fetch_altitude.py
└── .github/
    └── workflows/
        ├── ci.yml            # Build, test, and verify docs/ on every PR and push
        └── data-refresh.yml  # Weekly automated data fetch + rebuild + commit
```

`docs/` is the GitHub Pages source. It is committed so that every deployed state is reproducible from git history. The CI job enforces that committed `docs/` always matches what `npm run build` would produce from the committed `src/`.

## Prerequisites

- **Node 22** (exact version pinned in `.nvmrc`). If you use nvm: `nvm use`
- **Python 3.11+** — only needed for the data pipeline

## Local development

```bash
npm install
npm run dev        # Astro dev server at http://localhost:4321, hot reload from src/
```

In dev mode Astro serves directly from `src/` — `docs/` is not involved.

## Building

```bash
npm run build      # Compiles src/ → docs/
npm run preview    # Serves the built docs/ locally for a production-faithful preview
```

`docs/` must be committed alongside any `src/` change. CI will fail if they are out of sync. After any change to page sources, run `npm run build` and include the updated `docs/` in your commit.

## Tests

```bash
npm test           # Vitest unit tests

pip install pytest            # one-time setup, or:
pip install -e ".[dev]"       # installs from pyproject.toml
pytest                        # Python tests (tests/ directory)
```

## Data pipeline

`public/sunshine-temperature/data/` holds per-station JSON files containing ERA5 shortwave radiation data fetched from the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api). To refresh locally:

```bash
python scripts/fetch_sunshine.py
```

The script caches existing data and only re-fetches stations whose end date has changed.

`public/network-altitude/data/` holds `network-altitude.json` (monthly and annual network-altitude stats) and `station-ids.json` (station IDs with known location/elevation), derived from the [NOAA GHCNm v4 QCU archive](https://www.ncei.noaa.gov/pub/data/ghcn/v4/ghcnm.tavg.latest.qcu.tar.gz). To refresh locally:

```bash
python scripts/fetch_altitude.py
```

The script caches the downloaded archive by ETag and only re-processes it when the upstream file has changed.

After running either script, rebuild and commit `docs/`:

```bash
npm run build
git add public/sunshine-temperature/data/ docs/sunshine-temperature/data/ public/network-altitude/data/ docs/network-altitude/data/
git commit -m 'chore: refresh data'
```

This is automated by the `data-refresh` workflow (see below).

## CI / CD

### ci.yml

Triggers on every push to `main` and every pull request targeting `main`. Steps:

1. `npm ci` + `npm test` — JavaScript unit tests (Vitest)
2. `npm run build` — full Astro build
3. `git diff --exit-code -- docs/` — fails if the build output differs from what was committed, catching PRs that update `src/` without rebuilding `docs/`
4. `pytest` — Python tests (separate job, parallel)

### data-refresh.yml

Triggers weekly on Mondays at 04:00 UTC and on manual `workflow_dispatch`. Steps:

1. `python scripts/fetch_sunshine.py` — fetches latest ERA5 data into `public/sunshine-temperature/data/`
2. `python scripts/fetch_altitude.py` — fetches the latest GHCNm archive and recomputes network altitude into `public/network-altitude/data/`
3. `npm run build` — rebuilds `docs/` to include the new data
4. Commits and pushes `public/sunshine-temperature/data/`, `public/network-altitude/data/`, and `docs/` if anything changed

No manual intervention is needed for routine data updates.

## Adding a new lab

1. Create `src/pages/<lab-slug>/index.astro`
2. Add any data-fetching script to `scripts/` (and a matching Python test under `tests/`)
3. Add data files under `public/<lab-slug>/data/`
4. If the script needs routine refreshes, add a step for it to `data-refresh.yml` and include its output paths in the commit step
5. Add a lab card to the grid in `src/pages/index.astro`
6. Run `npm run build` and commit `docs/`

Follow `STYLE-GUIDE.md` for visual design, bias-control mechanics (randomised blocking choices, shareable URL state), chart implementation (custom canvas renderers — no Chart.js), and analytics conventions.

## Design system

See [STYLE-GUIDE.md](./STYLE-GUIDE.md) for the complete specification: Klymot teal colour tokens, fluid type scale, responsive layout rules, the section-gating anti-bias mechanic, URL state encoding, chart parity requirements with the main site, accessibility floor, and analytics tiers. The guide is the source of truth — when the main site's tokens or chart renderers change, update the guide first.
