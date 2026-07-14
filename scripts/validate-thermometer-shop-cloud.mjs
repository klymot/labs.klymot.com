// Validation: does the thermometer-shop synthetic day reproduce the
// short-term (5-minute) daytime temperature variability seen in real USCRN
// sub-hourly data — especially the solar spikes of broken-cloud days?
//
// Observed side: USCRN 5-min AIR_TEMPERATURE (aspirated PRT, 5-min means)
// for the near-sea-level stations in validation/thermometer-shop/
// stations.json. Days are classified clear / broken / overcast from
// measured SOLAR_RADIATION against a clear-sky envelope, plus the variance
// of the clearness index (broken-ness).
//
// Model side: simulateDay at the station's latitude and day-of-year; cloud
// fraction estimated as the day's sunshine-gate occupancy (fraction of
// well-up samples with the sun's disc plausibly obscured — the same
// semantics as the model's cloud gate; inverting Kasten–Czeplak from mean
// clearness is ill-conditioned near clear sky because of its c^3.4); wind
// from the day's mean measured 1.5 m wind, log-profile-scaled to the
// standard-height-flavoured speeds the lab's regimes quote. The simulated
// day is fed through the lab's own USCRN chain — aspirated shield +
// reference-network PRT — and reduced to 5-min means, so both sides of the
// comparison are the same kind of series.
//
// Metrics, daytime only (sun elevation > 10°): σ and p95 of successive
// 5-min-mean temperature differences, and σ of the residual against a 1-h
// centered moving average. These are exactly the scales the cloud gate and
// the OU turbulence populate; the model's amplitudes were tuned against
// this comparison (see OU_SIGMA_DAY in the model).
//
// Data files are git-ignored; fetch them first:
//   python3 scripts/fetch_thermometer_shop_validation.py
// then:
//   npm run validate:thermometer-shop

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  simulateDay,
  runCartItem,
  getInstrument,
  getExposure,
  DT_SECONDS,
} from '../src/lib/thermometer-shop-model.js';

const VALIDATION_DIR = new URL('../validation/thermometer-shop/', import.meta.url);

const DEG = Math.PI / 180;
const SOLAR_CONSTANT = 1361; // same values as the model's clear-sky envelope
const CLEAR_SKY_TRANSMISSION = 0.75;

// Sunshine-gate threshold: clearness below this means the sun's disc is
// plausibly obscured (diffuse-ish sky). Drives the cSunshine estimate.
const SUN_OBSCURED_CLEARNESS = 0.65;

// USCRN wind is measured at 1.5 m; the lab's regime speeds read as
// standard(ish) 10 m winds. Log-profile conversion for z0 ≈ 3 cm.
const WIND_1_5M_TO_10M = 1.5;

const MODEL_SEEDS = [11, 22, 33, 44, 55, 66, 77, 88];
const MAX_DAYS_PER_CLASS = 12;

// ── Geometry ──────────────────────────────────────────────────────────────
// Same declination/elevation formulae as the model, plus the equation of
// time (the observed files are on local standard time; the clearness
// classification needs true solar time).
export function equationOfTimeMinutes(doy) {
  const b = (2 * Math.PI * (doy - 81)) / 364;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

export function sinElev(latDeg, doy, solarHour) {
  const decl = 23.44 * Math.sin(DEG * ((360 / 365) * (doy + 284))) * DEG;
  const lat = latDeg * DEG;
  const hourAngle = (solarHour - 12) * 15 * DEG;
  return (
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
  );
}

export function dayOfYearFromYmd(ymd) {
  const y = +ymd.slice(0, 4);
  const m = +ymd.slice(4, 6);
  const d = +ymd.slice(6, 8);
  const t = Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1);
  return Math.round(t / 86400000) + 1;
}

function solarHourAt(st, doy, binIndex) {
  const lstHour = (binIndex * 5) / 60 + 5 / 120; // bin center
  return lstHour + (st.lonDeg - st.tzMeridian) / 15 + equationOfTimeMinutes(doy) / 60;
}

// ── Parse one station-year into per-LST-day records ───────────────────────
// USCRN subhourly01 fields (whitespace-split, 0-indexed here): 3 LST_DATE,
// 4 LST_TIME, 8 AIR_TEMPERATURE (°C, 5-min mean), 10 SOLAR_RADIATION
// (W/m²), 11 SR_FLAG, 21 WIND_1_5 (m/s), 22 WIND_FLAG. Missing = -9999.
export function loadStationDays(text) {
  const days = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const f = line.trim().split(/\s+/);
    const lstDate = f[3];
    const lstTime = f[4];
    let rec = days.get(lstDate);
    if (!rec) {
      rec = {
        t: new Float64Array(288).fill(NaN),
        ghi: new Float64Array(288).fill(NaN),
        wind: new Float64Array(288).fill(NaN),
      };
      days.set(lstDate, rec);
    }
    const idx = Math.round((+lstTime.slice(0, 2) * 60 + +lstTime.slice(2)) / 5) % 288;
    const airT = +f[8];
    const ghi = +f[10];
    const wind = +f[21];
    if (airT > -9990) rec.t[idx] = airT;
    if (ghi > -9990 && f[11] === '0') rec.ghi[idx] = ghi;
    if (wind > -9990 && f[22] === '0') rec.wind[idx] = wind;
  }
  return days;
}

// ── Classify a day's cloudiness from its clearness index ─────────────────
// Clearness k = measured GHI / (S0 · 0.75 · sinElev) over samples with
// sinElev > 0.2 (sun well up — low-sun samples are geometry-noisy).
// Returns null for days that fit no class cleanly or have too many gaps.
export function classifyDay(st, lstDate, rec) {
  const doy = dayOfYearFromYmd(lstDate);
  const ks = [];
  let windSum = 0;
  let windN = 0;
  let missingT = 0;
  for (let i = 0; i < 288; i++) {
    if (!Number.isFinite(rec.t[i])) missingT++;
    if (Number.isFinite(rec.wind[i])) {
      windSum += rec.wind[i];
      windN++;
    }
    if (!Number.isFinite(rec.ghi[i])) continue;
    const se = sinElev(st.latDeg, doy, solarHourAt(st, doy, i));
    if (se < 0.2) continue;
    ks.push(rec.ghi[i] / (SOLAR_CONSTANT * CLEAR_SKY_TRANSMISSION * se));
  }
  if (ks.length < 24 || missingT > 6 || windN < 100) return null;
  const mean = ks.reduce((a, b) => a + b, 0) / ks.length;
  const sd = Math.sqrt(ks.reduce((a, b) => a + (b - mean) ** 2, 0) / ks.length);
  const cSunshine = ks.filter((k) => k < SUN_OBSCURED_CLEARNESS).length / ks.length;
  let cls = null;
  if (mean > 0.85 && sd < 0.1) cls = 'clear';
  else if (mean < 0.35) cls = 'overcast';
  else if (mean > 0.45 && mean < 0.9 && sd > 0.25) cls = 'broken';
  if (!cls) return null;
  return { doy, cls, kMean: mean, kSd: sd, cSunshine, windMean: windSum / windN };
}

// ── Variability metrics on a 5-min series, daytime only ──────────────────
export function daytimeMask(st, doy, length = 288, solarTime = false) {
  const mask = new Array(length).fill(false);
  for (let i = 0; i < length; i++) {
    const solarHour = solarTime
      ? (i * 5) / 60 + 5 / 120
      : solarHourAt(st, doy, i);
    mask[i] = sinElev(st.latDeg, doy, solarHour) > Math.sin(10 * DEG);
  }
  return mask;
}

export function metrics(series5, mask) {
  const dts = [];
  for (let i = 1; i < series5.length; i++) {
    if (!mask[i] || !mask[i - 1]) continue;
    if (!Number.isFinite(series5[i]) || !Number.isFinite(series5[i - 1])) continue;
    dts.push(series5[i] - series5[i - 1]);
  }
  if (dts.length < 20) return null;
  const sd = Math.sqrt(dts.reduce((a, b) => a + b * b, 0) / dts.length);
  const abs = dts.map(Math.abs).sort((a, b) => a - b);
  const p95 = abs[Math.floor(0.95 * (abs.length - 1))];
  // High-frequency residual: series minus 1-h (12-sample) centered mean.
  const resid = [];
  for (let i = 6; i < series5.length - 6; i++) {
    if (!mask[i] || !Number.isFinite(series5[i])) continue;
    let s = 0;
    let n = 0;
    for (let j = i - 6; j <= i + 6; j++) {
      if (Number.isFinite(series5[j])) {
        s += series5[j];
        n++;
      }
    }
    if (n < 11) continue;
    resid.push(series5[i] - s / n);
  }
  if (resid.length < 20) return null;
  const residSd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / resid.length);
  return { dtSd: sd, dtP95: p95, residSd, n: dts.length };
}

// ── Model side: one simulated day through the USCRN chain ─────────────────
export function modelDayMetrics(st, dayInfo, seed) {
  const day = simulateDay({
    latDeg: st.latDeg,
    dayOfYear: dayInfo.doy,
    cloudFraction: dayInfo.cSunshine,
    seed,
    windMps: Math.max(dayInfo.windMean * WIND_1_5M_TO_10M, 0.4),
    gustFrac: 0.4,
  });
  const inst = { ...getInstrument('prtUscrn'), toleranceC: 0, resolutionC: 0.001 };
  const r = runCartItem(day, inst, getExposure('aspirated'), `v:${seed}`);
  const stepsPer5 = Math.round(300 / DT_SECONDS);
  const series5 = [];
  for (let b = 0; b + stepsPer5 <= r.instrSeries.length; b += stepsPer5) {
    let s = 0;
    for (let i = b; i < b + stepsPer5; i++) s += r.instrSeries[i];
    series5.push(s / stepsPer5);
  }
  // The model's time axis is already local solar time.
  return metrics(series5, daytimeMask(st, dayInfo.doy, series5.length, true));
}

// ── Run ───────────────────────────────────────────────────────────────────
function quantiles(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.max(0, Math.floor(p * (s.length - 1)))];
  return { med: q(0.5), q25: q(0.25), q75: q(0.75), n: s.length };
}

function fmtRow(name, rows) {
  const dtSd = quantiles(rows.map((r) => r.dtSd));
  const dtP95 = quantiles(rows.map((r) => r.dtP95));
  const residSd = quantiles(rows.map((r) => r.residSd));
  const f = (q) => `${q.med.toFixed(3)} [${q.q25.toFixed(3)}–${q.q75.toFixed(3)}]`;
  return (
    `    ${name.padEnd(6)} σ(ΔT₅) ${f(dtSd)}  p95|ΔT₅| ${f(dtP95)}  ` +
    `σ(resid1h) ${f(residSd)}  (n=${rows.length})`
  );
}

function main() {
  const manifest = JSON.parse(readFileSync(new URL('stations.json', VALIDATION_DIR), 'utf8'));
  const { year } = manifest;
  for (const st of manifest.stations) {
    const dataUrl = new URL(`data/CRNS0101-05-${year}-${st.slug}.txt`, VALIDATION_DIR);
    if (!existsSync(dataUrl)) {
      console.error(
        `Missing ${fileURLToPath(dataUrl)}\n` +
          'Fetch the raw files first: python3 scripts/fetch_thermometer_shop_validation.py'
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\n=== ${st.label}, ${year} ===`);
    const days = loadStationDays(readFileSync(dataUrl, 'utf8'));
    const byClass = { clear: [], broken: [], overcast: [] };
    for (const [lstDate, rec] of days) {
      const info = classifyDay(st, lstDate, rec);
      if (!info) continue;
      const m = metrics(Array.from(rec.t), daytimeMask(st, info.doy));
      if (m) byClass[info.cls].push({ info, obs: m });
    }
    for (const cls of ['clear', 'broken', 'overcast']) {
      const list = byClass[cls];
      if (list.length === 0) {
        console.log(`  ${cls}: no qualifying days`);
        continue;
      }
      // Sample days evenly through the year to cap model runs.
      const stride = Math.max(1, Math.floor(list.length / MAX_DAYS_PER_CLASS));
      const sample = list.filter((_, i) => i % stride === 0).slice(0, MAX_DAYS_PER_CLASS);
      const obsRows = sample.map((d) => d.obs);
      const modelRows = [];
      for (const d of sample) {
        for (const seed of MODEL_SEEDS) {
          const m = modelDayMetrics(st, d.info, seed);
          if (m) modelRows.push(m);
        }
      }
      console.log(
        `  ${cls}: ${list.length} days qualify, ${sample.length} sampled; ` +
          `k̄ med ${quantiles(sample.map((d) => d.info.kMean)).med.toFixed(2)}, ` +
          `wind med ${quantiles(sample.map((d) => d.info.windMean)).med.toFixed(1)} m/s (1.5 m), ` +
          `model c med ${quantiles(sample.map((d) => d.info.cSunshine)).med.toFixed(2)}`
      );
      console.log(fmtRow('obs', obsRows));
      console.log(fmtRow('model', modelRows));
    }
  }
  console.log(
    '\nReading: model medians should sit within or near the observed ' +
      '[q25–q75] in every class. Known limit: one cloud slider cannot ' +
      'distinguish cloud types — real broken-cloud spikes run sharper than ' +
      'the model at convective-cumulus sites and softer at marine-cloud ones.'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
