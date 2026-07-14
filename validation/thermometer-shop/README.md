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

## Reading the output, and the 2024 result

The model's medians should sit within or near the observed [q25–q75]
interval in every station × sky-class cell. Against 2024 (fetched
2026-07-14, model as of that date) they do, with the expected one-knob
limit: real broken-cloud spikes run sharper than the model's at the
convective site (Titusville) and softer at the marine one (Coos Bay) — a
cloud-type distinction a single cloud slider cannot express, and now
acknowledged in the lab's methodology copy. Median σ(ΔT₅) in °C, observed
vs model, that run:

| Station, sky class | Observed | Model |
|---|---|---|
| Coos Bay clear | 0.270 | 0.237 |
| Coos Bay broken | 0.190 | 0.240 |
| Coos Bay overcast | 0.127 | 0.127 |
| Titusville clear | 0.208 | 0.256 |
| Titusville broken | 0.268 | 0.242 |
| Titusville overcast | 0.152 | 0.156 |

If the weather generator's stochastic pieces change (gate timescale, OU
amplitudes, irradiance decomposition), rerun this and re-check that table;
`stations.json` sets the year and stations.

## Data isolation

This directory is the thermometer-shop lab's own; nothing here is read
from or written to any other lab's data. The raw USCRN files live in
`data/` (git-ignored, re-fetchable); source is NOAA NCEI,
`https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/`.
