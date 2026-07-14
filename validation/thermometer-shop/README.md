# Thermometer Shop — USCRN validation

The Thermometer Shop's weather is synthetic, so it has no page-served data
pipeline. What it has instead is this validation: a repeatable check that the
simulated day's short-term temperature texture — in particular the solar
spikes that clumps of passing cloud carve into a broken-sky afternoon —
matches real 5-minute records from the US Climate Reference Network.

## How to run it

```sh
python3 scripts/fetch_thermometer_shop_validation.py   # ~14 MB per station-year, git-ignored
npm run validate:thermometer-shop
# hold-out year:
python3 scripts/fetch_thermometer_shop_validation.py --year 2023
node scripts/validate-thermometer-shop-cloud.mjs --year=2023
```

The pure pieces (file parsing, day classification, metrics) are covered by
`scripts/validate-thermometer-shop-cloud.test.mjs` in the normal `npm test`
run; the comparison itself needs the fetched data and is run manually.

## What it compares

Observed side: USCRN sub-hourly (5-minute mean) air temperature — aspirated
PRT, the same chain the lab's "reference-network PRT + mechanically
aspirated shield" cart item models — at the two near-sea-level stations in
`stations.json`, chosen on opposite coasts for opposite cloud regimes
(Pacific marine stratiform vs Atlantic convective cumulus). Each day of the
station-year is classified clear / broken / overcast from measured solar
radiation against a clear-sky envelope; ambiguous days are dropped.

Model side: `simulateDay` at the station's latitude and day-of-year, with
the cloud fraction estimated as the day's *sunshine-gate occupancy* (the
fraction of well-up samples with the sun's disc plausibly obscured — the
same semantics as the model's cloud gate), and the wind taken from the
day's mean measured 1.5 m wind, log-profile-scaled (~×1.5) to the
standard-height-flavoured speeds the lab's wind regimes quote. Each
simulated day is fed through the lab's own USCRN chain and reduced to
5-minute means, so both sides are the same kind of series.

Metrics, daytime only (sun elevation > 10°):

- **σ(ΔT₅)** — standard deviation of successive 5-minute-mean differences;
- **p95|ΔT₅|** — the size of the larger 5-minute jumps;
- **σ(resid1h)** — standard deviation of the residual against a 1-hour
  centered moving average (the high-frequency wiggle a smooth diurnal
  cycle would not have).

## Why it exists

The model originally applied cloud as a smooth cap on solar intensity
(Kasten & Czeplak 1980 on the day's cloud fraction); the stochastic cloud
gate only reached the wall exposure's direct beam. This check was built to
test that suspicion, and confirmed it: broken-day flicker at the
convective-cumulus site exceeded what the model produced. The model now
splits sunlight into an always-present diffuse part plus a gated direct
beam whose gate-average reproduces Kasten–Czeplak exactly, and the OU
turbulence amplitude was retuned *together with* the gate against this
comparison (see `OU_SIGMA_DAY` in `src/lib/thermometer-shop-model.js`).

Because 2024 is therefore a **tuning set, not a test**, the same comparison
is also run against the same stations' **2023** records as a held-out
check: nothing was adjusted against 2023.

## Reading the output, and the 2024 (tuning) + 2023 (hold-out) results

The model's medians should sit within or near the observed [q25–q75]
interval in every station × sky-class cell. Against both years (fetched
2026-07-14, model as of that date) they do, with the expected one-knob
limit: real broken-cloud spikes run sharper than the model's at the
convective site (Titusville) and softer at the marine one (Coos Bay) — a
cloud-type distinction a single cloud slider cannot express, and
acknowledged in the lab's methodology copy. Median σ(ΔT₅) in °C, observed
vs model:

| Station, sky class | 2024 obs | 2024 model | 2023 obs (hold-out) | 2023 model |
|---|---|---|---|---|
| Coos Bay clear | 0.270 | 0.234 | 0.268 | 0.206 |
| Coos Bay broken | 0.212 | 0.252 | 0.201 | 0.220 |
| Coos Bay overcast | 0.145 | 0.133 | 0.114 | 0.138 |
| Titusville clear | 0.227 | 0.259 | 0.215 | 0.291\* |
| Titusville broken | 0.231 | 0.259 | 0.251 | 0.279 |
| Titusville overcast | 0.152 | 0.161 | 0.189 | 0.191 |

The hold-out year shows the same pattern as the tuning year (the two
stations bracket the model in opposite directions on clear days), which is
the no-overfitting signal this check exists to provide.

\* Titusville's 1.5 m anemometer reported flat zeros (with good QC flags)
for most of 2023, so those model runs fall back to the calm-wind floor,
which inflates modelled clear-day jitter; its 2023 wind inputs are
unreliable and that cell should be read with that caveat. (Unflagged
`-99.00` wind sentinels in the same file are screened out by the parser.)

If the weather generator's stochastic pieces change (gate timescale, OU
amplitudes, irradiance decomposition, seeding), rerun BOTH years and
re-check this table; `stations.json` sets the default year and stations,
`--year=` overrides it.

## Data isolation

This directory is the thermometer-shop lab's own; nothing here is read
from or written to any other lab's data. The raw USCRN files live in
`data/` (git-ignored, re-fetchable); source is NOAA NCEI,
`https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/`.
