/* Lab: What Does More CO₂ Actually Change? (labs-support idea #11)
 *
 * Data: precomputed correlated-k grids from the labs-support co2-spectrum
 * pipeline (HITRAN via HAPI through IGRA radiosonde profiles). Per station:
 *   co2_k.bin — uint16 LE, [layer][bin][g] row-major; CO₂ optical depth per
 *               unit mixing ratio (multiply by the slider's vmr).
 *   h2o_od.bin — same layout; actual H₂O optical depth (evaluate at vmr 1).
 *   profile.json — level arrays + layer boundaries/temperatures.
 * Per-bin transmittance = sum_g w_g * exp(-vmr * sum_layers k[l][bin][g]).
 *
 * DOM-free math is exported (vitest: co2-spectrum-lab.test.js); the DOM/canvas
 * driver (initCo2Lab) follows the average-really-average lab's conventions.
 */

/* ── Pure math ────────────────────────────────────────────────────────── */

// Codes: 0 is exactly zero; 1..65535 map linearly in log10 space.
export function dequantize(codes, log10lo, log10hi) {
  const out = new Float32Array(codes.length);
  const span = (log10hi - log10lo) / 65534;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    out[i] = c === 0 ? 0 : Math.pow(10, log10lo + (c - 1) * span);
  }
  return out;
}

// Sum the per-layer grids down the column: (L*bins*g) -> (bins*g).
export function columnSum(k, nLayers, nBins, nG) {
  const out = new Float32Array(nBins * nG);
  for (let l = 0; l < nLayers; l++) {
    const base = l * nBins * nG;
    for (let i = 0; i < nBins * nG; i++) out[i] += k[base + i];
  }
  return out;
}

// Per-bin transmittance at a mixing ratio from the column-summed grid.
export function transmittance(colSum, weights, vmr, nBins, nG) {
  const out = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let t = 0;
    for (let g = 0; g < nG; g++) t += weights[g] * Math.exp(-vmr * colSum[b * nG + g]);
    out[b] = t;
  }
  return out;
}

// Random-overlap combination of two gases' per-bin transmittances.
export function combineTransmittance(a, b) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

// Per-bin g-weighted altitude (m) where cumulative optical depth, integrated
// from the top layer down, reaches 1. Layers in the grid are ordered
// bottom-up. Mirrors groundHiddenAltitude: the mean is taken over the g-points
// that do cross, and a bin where less than half the quadrature weight ever
// crosses returns NaN (the top never drops out of sight there); the caller
// decides how to draw that. zSurface is kept for the signature's callers.
export function emissionAltitude(k, nLayers, nBins, nG, weights, vmr, zMids, zSurface) {
  const out = new Float64Array(nBins);
  const cum = new Float64Array(nG);
  const zAt = new Float64Array(nG);
  for (let b = 0; b < nBins; b++) {
    cum.fill(0);
    zAt.fill(NaN);
    let remaining = nG;
    for (let l = nLayers - 1; l >= 0 && remaining > 0; l--) {
      const base = (l * nBins + b) * nG;
      for (let g = 0; g < nG; g++) {
        if (cum[g] >= 1) continue;
        cum[g] += vmr * k[base + g];
        if (cum[g] >= 1) {
          zAt[g] = zMids[l];
          remaining--;
        }
      }
    }
    let wCrossed = 0;
    let z = 0;
    for (let g = 0; g < nG; g++) {
      if (Number.isFinite(zAt[g])) {
        wCrossed += weights[g];
        z += weights[g] * zAt[g];
      }
    }
    out[b] = wCrossed >= 0.5 ? z / wCrossed : NaN;
  }
  void zSurface;
  return out;
}

// Mirror of emissionAltitude: cumulative optical depth from the BOTTOM layer
// upward — the g-weighted height above which the ground is no longer visible
// at each wavelength. Bins where the majority (by quadrature weight) of
// g-points never reach tau=1 return NaN: the ground stays visible from any
// height there, and the curve is drawn with a gap.
export function groundHiddenAltitude(k, nLayers, nBins, nG, weights, vmr, zMids) {
  const out = new Float64Array(nBins);
  const cum = new Float64Array(nG);
  const zAt = new Float64Array(nG);
  for (let b = 0; b < nBins; b++) {
    cum.fill(0);
    zAt.fill(NaN);
    let remaining = nG;
    for (let l = 0; l < nLayers && remaining > 0; l++) {
      const base = (l * nBins + b) * nG;
      for (let g = 0; g < nG; g++) {
        if (cum[g] >= 1) continue;
        cum[g] += vmr * k[base + g];
        if (cum[g] >= 1) {
          zAt[g] = zMids[l];
          remaining--;
        }
      }
    }
    let wCrossed = 0;
    let z = 0;
    for (let g = 0; g < nG; g++) {
      if (Number.isFinite(zAt[g])) {
        wCrossed += weights[g];
        z += weights[g] * zAt[g];
      }
    }
    out[b] = wCrossed >= 0.5 ? z / wCrossed : NaN;
  }
  return out;
}

// Temperature (K) at altitude z from the profile's level arrays (linear interp).
export function temperatureAt(zLevels, tLevels, z) {
  if (z <= zLevels[0]) return tLevels[0];
  const n = zLevels.length;
  if (z >= zLevels[n - 1]) return tLevels[n - 1];
  let i = 1;
  while (i < n && zLevels[i] < z) i++;
  const f = (z - zLevels[i - 1]) / (zLevels[i] - zLevels[i - 1]);
  return tLevels[i - 1] + f * (tLevels[i] - tLevels[i - 1]);
}

// Mean of a per-bin series over a wavenumber interval.
export function bandMean(series, nuMin, binWidth, lo, hi) {
  const b0 = Math.max(0, Math.round((lo - nuMin) / binWidth));
  const b1 = Math.min(series.length, Math.round((hi - nuMin) / binWidth));
  if (b1 <= b0) return null;
  let s = 0;
  for (let b = b0; b < b1; b++) s += series[b];
  return s / (b1 - b0);
}

// Linear interpolation in log-x (the solar-curve ppm grid is log-spaced).
export function interpLogX(xs, ys, x) {
  const lx = Math.log(x);
  if (lx <= Math.log(xs[0])) return ys[0];
  const n = xs.length;
  if (lx >= Math.log(xs[n - 1])) return ys[n - 1];
  let i = 1;
  while (i < n && Math.log(xs[i]) < lx) i++;
  const l0 = Math.log(xs[i - 1]);
  const l1 = Math.log(xs[i]);
  const f = (lx - l0) / (l1 - l0);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}

// Has the reader's slider exploration covered enough ground to earn the
// connect-the-dots reveal? Requires several distinct samples spanning a wide
// concentration ratio.
export function sweepEarned(visitedPpm, minCount = 8, minSpanRatio = 8) {
  const arr = Array.from(visitedPpm);
  if (arr.length < minCount) return false;
  return Math.max(...arr) / Math.min(...arr) >= minSpanRatio;
}

// Fraction of a blackbody's TOTAL emitted energy falling in each display bin
// (bin centre nu, width binWidth, in cm-1) at temperature T: the Planck
// distribution in x = hc*nu/kT, normalised by the Stefan–Boltzmann integral.
export function planckBinFraction(nuCenters, binWidth, T) {
  const hcOverK = 1.438777; // cm K
  const norm = 15 / Math.pow(Math.PI, 4);
  const out = new Float64Array(nuCenters.length);
  for (let i = 0; i < nuCenters.length; i++) {
    const x = (hcOverK * nuCenters[i]) / T;
    const dx = (hcOverK * binWidth) / T;
    out[i] = norm * (x * x * x / Math.expm1(x)) * dx;
  }
  return out;
}

// Where a beam's energy is absorbed, layer by layer and by which gas. Walks
// the column in the beam's direction (downward: top layer first; upward:
// bottom layer first). Within a layer the absorbed energy is split between
// the gases in proportion to their optical depths. Returns fractions of the
// source's total energy absorbed in each layer, for CO₂ and for H₂O.
export function absorptionByLayer(kCo2, kH2o, nLayers, nBins, nG, weights, vmr, binWeights, downward) {
  const co2 = new Float64Array(nLayers);
  const h2o = new Float64Array(nLayers);
  for (let b = 0; b < nBins; b++) {
    const wb = binWeights[b];
    if (!(wb > 0)) continue;
    for (let g = 0; g < nG; g++) {
      const w = wb * weights[g];
      let t = 1;
      for (let i = 0; i < nLayers && t > 1e-12; i++) {
        const l = downward ? nLayers - 1 - i : i;
        const idx = (l * nBins + b) * nG + g;
        const tc = vmr * kCo2[idx];
        const th = kH2o[idx];
        const tau = tc + th;
        if (tau <= 0) continue;
        const a = t * -Math.expm1(-tau);
        const ac = a * (tc / tau);
        co2[l] += w * ac;
        h2o[l] += w * (a - ac);
        t *= Math.exp(-tau);
      }
    }
  }
  return { co2, h2o };
}

// Planck spectral exitance per wavenumber, W m-2 per cm-1, from a surface at T.
export function planckExitance(nuCenters, T) {
  const hcOverK = 1.438777; // cm K
  const C = 3.7418e-8;      // 2*pi*h*c^2 converted to per-cm^-1 units
  const out = new Float64Array(nuCenters.length);
  for (let i = 0; i < nuCenters.length; i++) {
    const nu = nuCenters[i];
    out[i] = C * nu * nu * nu / Math.expm1((hcOverK * nu) / T);
  }
  return out;
}

// Relative Planck blackbody spectral intensity vs wavenumber (cm-1) at the
// sun's nominal effective temperature — the shape of sunlight at the top of
// the atmosphere, normalized so the maximum over the given bins is 1.
export function solarShapeRelative(nuCenters, tSun = 5772) {
  const hcOverK = 1.438777; // cm K
  const out = new Float64Array(nuCenters.length);
  let max = 0;
  for (let i = 0; i < nuCenters.length; i++) {
    const nu = nuCenters[i];
    out[i] = nu * nu * nu / Math.expm1((hcOverK * nu) / tSun);
    if (out[i] > max) max = out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= max || 1;
  return out;
}

// Relative absorption at concentration ppm, normalized to the value at
// refPpm, for one solar-curve series. Both axes of the relative chart are
// ratios; at ppm === refPpm this is exactly 1.
export function relativeAbsorption(ppmGrid, values, refPpm, ppm) {
  const ref = interpLogX(ppmGrid, values, refPpm);
  if (!(ref > 0)) return null;
  return interpLogX(ppmGrid, values, ppm) / ref;
}

// Log slider mapping: x in [0,1] <-> ppm in [PPM_MIN, PPM_MAX].
export const PPM_MIN = 10;
export const PPM_MAX = 5000;
export function ppmFromSlider(x) {
  return PPM_MIN * Math.pow(PPM_MAX / PPM_MIN, Math.min(1, Math.max(0, x)));
}
export function sliderFromPpm(ppm) {
  return Math.log(ppm / PPM_MIN) / Math.log(PPM_MAX / PPM_MIN);
}
export function fmtPpm(ppm) {
  return ppm >= 100 ? String(Math.round(ppm)) : ppm.toFixed(1);
}

/* ── Display constants ────────────────────────────────────────────────── */

// Factual band regions for the table fallback and zoom presets (names only,
// no commentary on what any band does).
export const BANDS = [
  { label: 'CO₂ 15 μm band', lo: 550, hi: 800 },
  { label: '8–12 μm window', lo: 800, hi: 1200 },
  { label: 'H₂O 6.3 μm band', lo: 1300, hi: 2000 },
  { label: 'CO₂ 4.3 μm band', lo: 2100, hi: 2450 },
  { label: 'CO₂ 2.7 μm band', lo: 3450, hi: 3800 },
  { label: 'CO₂ 2.0 μm band', lo: 4750, hi: 5250 },
  { label: 'CO₂ 1.6 μm band', lo: 6000, hi: 6550 },
  { label: 'CO₂ 1.4 μm band', lo: 6900, hi: 7100 },
];

export const ZOOMS = [
  { key: 'full', label: 'Full range', lo: 400, hi: 8000 },
  { key: 'b15', label: '≈15 μm region', lo: 500, hi: 900 },
  { key: 'b43', label: '≈4.3 μm region', lo: 2000, hi: 2600 },
  { key: 'nir', label: 'Near-infrared', lo: 3200, hi: 7500 },
];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}


/* ── Driver ───────────────────────────────────────────────────────────── */

// The fixed amount of the opening demonstration chart — a round number with no
// climate meaning (guardrail 2). It exists to show clipping: the computed
// curve against the curve you would get if absorption simply added up.
export const DEMO_PPM = 1000;

// Approximate sRGB colour of monochromatic light at wavelength nm (380–780),
// after Dan Bruton's piecewise fit; null outside the visible range.
export function wavelengthToRgb(nm) {
  if (nm < 380 || nm > 780) return null;
  let r = 0; let g = 0; let b = 0;
  if (nm < 440) { r = -(nm - 440) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = -(nm - 510) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = -(nm - 645) / 65; }
  else { r = 1; }
  let f = 1;
  if (nm < 420) f = 0.3 + 0.7 * (nm - 380) / 40;
  else if (nm > 700) f = 0.3 + 0.7 * (780 - nm) / 80;
  const c = (v) => Math.round(255 * Math.pow(v * f, 0.8));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

// Absorbance (log10, base-10) of one homogeneous sample from its per-bin
// k-distribution: A = -log10( sum_g w_g exp(-scale * k[b,g]) ).
export function sampleAbsorbance(kSlab, weights, scale, nBins, nG) {
  const out = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let t = 0;
    for (let g = 0; g < nG; g++) t += weights[g] * Math.exp(-scale * kSlab[b * nG + g]);
    out[b] = -Math.log10(Math.max(t, 1e-300));
  }
  return out;
}

// The scale (concentration factor) at which the strongest bin of a sample
// reaches absorbance target. Monotone in scale, so bisect in log space.
export function scaleForPeakAbsorbance(kSlab, weights, target, nBins, nG, lo = 1e-12, hi = 1e3) {
  const peak = (sc) => { const a = sampleAbsorbance(kSlab, weights, sc, nBins, nG); let m = 0; for (let b = 0; b < nBins; b++) if (a[b] > m) m = a[b]; return m; };
  let l = Math.log(lo); let h = Math.log(hi);
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (l + h);
    if (peak(Math.exp(mid)) < target) l = mid; else h = mid;
  }
  return Math.exp(0.5 * (l + h));
}

// Transmittance "if absorption simply added up": every molecule takes the same
// slice of light as the first one did, so the absorbed fraction is the weak-
// limit absorption per unit vmr times the vmr — a straight line through the
// origin that crosses below zero wherever the real curve has hit the floor.
export function naiveTransmittance(colSum, weights, vmr, nBins, nG) {
  const out = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let tau = 0;
    for (let g = 0; g < nG; g++) tau += weights[g] * colSum[b * nG + g];
    out[b] = 1 - vmr * tau;
  }
  return out;
}

export function initCo2Lab(config) {
  const { manifest, dataBase, funnelPrefix, sendFeatureBeacon } = config;
  const grid = manifest.grid;
  const NU_MIN = grid.nu_min_cm1;
  const BIN_W = grid.bin_width_cm1;
  const N_BINS = grid.n_bins;
  const N_G = grid.n_g;
  const W_G = grid.g_weights;
  const binNu = (b) => NU_MIN + (b + 0.5) * BIN_W;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

  /* ── State ── */
  let stdData = null;        // the standard atmosphere (intro chart only): { co2Sum, h2oSum, nLayers, ... }
  let stationId = null;
  let station = null;        // manifest entry
  let data = null;           // chosen station: { co2, co2Sum, h2o, h2oSum, profile, nLayers, zMids, zLevels, tLevels, zSurface, zDataTop, energy }
  let vmrPpm = ppmFromSlider(Math.random());   // randomized start (guardrail: no anchor)
  let refPpm = null;         // chosen in the reference step (blocking)
  let showCO2 = true;
  let showRef = true;
  let showH2O = false;
  let showCombined = false;
  const altUpShow = { ref: true, cur: true };
  const altDownShow = { ref: true, cur: true };
  let zoom = ZOOMS[0];
  // 2 = intro + reference (always visible); 3 location; 4 live spectrum; 5 energy; 6 altitude; 7 end
  let progress = 2;
  let restoring = false;
  let waterToggledOnce = false;
  let sliderMoved = false;          // the "try moving it" nudge shows until the reader does
  let land = null;                  // simplified Natural Earth land rings
  let hoverStationId = null;        // card under the pointer → lit on the globe
  let globeHits = [];               // [{ id, x, y }] after each draw, for clicks
  const beaconsSent = new Set();
  // Energy sweep: concentrations the reader has actually visited while the
  // energy section is open (the charts fill in from their own dragging).
  const visitedPpm = new Set();
  let solarConnected = false;
  // Per-chart series visibility (display-only legends).
  const demoShow = { co2Trace: true, co2: false, h2oTrace: false, h2o: false };
  const emitShow = { sun: true, ground: true };
  let emitMode = 'peak';            // 'peak' | 'avg' | 'noon'
  const SUN_DILUTION = 2.164e-5;    // (solar radius / 1 AU)^2: sunlight at the top of the atmosphere, overhead
  const T_GROUND_EQ = 299.15;       // equatorial-average surface, 26 °C
  const T_SUN = 5772;
  const T_GROUND = 288.15;          // the standard atmosphere's surface, 15 °C
  const DEMO_PATH_M = 100;          // the lab sample: 100 m of ground-level air
  const DEMO_CO2_PPM = 430;         // about today's air (NOAA Mauna Loa, 2026); user decision 2026-09-04
  const DEMO_PEAK_ABS = 1;          // the trace curves: strongest band lets a tenth through (transmittance 0.1)
  const DEMO_ABS_MAX = 3;           // a detector sees ~0.1 % at absorbance 3: beyond that, nothing
  let specMode = 'abs';             // 'abs' | 'trans' — shared by every spectral chart
  const ABS_MAX = 3;                // detector ceiling on the absorbance axis
  const modeButtons = Array.from(document.querySelectorAll('.mode-btn[data-mode]'));
  function syncModeButtons() {
    modeButtons.forEach((btn) => {
      const active = btn.getAttribute('data-mode') === specMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  const toAbs = (t) => { const o = new Float64Array(t.length); for (let i = 0; i < t.length; i++) o[i] = Math.min(ABS_MAX, -Math.log10(Math.max(t[i], 1e-300))); return o; };
  // shared absorbance frame: 0..3 with the detector ceiling shaded
  function drawAbsCeiling(ctx, frame, pad) {
    const yCeil = frame.yp(2.5);
    ctx.fillStyle = 'rgba(128,128,128,0.10)';
    ctx.fillRect(pad.left, pad.top, frame.cW, yCeil - pad.top);
    ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    const long = 'up here less than 0.3 % of the light is left — the detector reads nothing: clipped';
    const short = 'detector reads nothing here: clipped';
    ctx.fillText(ctx.measureText(long).width + 16 <= frame.cW ? long : short, pad.left + frame.cW - 8, pad.top + 12);
  }
  const solarShow = { co2: true, both: true, h2o: true, dry: false };
  const thermalShow = { co2: true, both: true, h2o: true, dry: false };
  const profShow = { sun: true, ground: true, co2: true, h2o: true };
  let showSun = false;
  let showGround = false;
  const SOLAR_CONST_WM2 = 1361; // TOA total solar irradiance, overhead sun
  const SIGMA_SB = 5.670374419e-8; // W m-2 K-4
  // Shape of sunlight at the top of the atmosphere, on the display bins.
  const binCenters = Array.from({ length: N_BINS }, (_, b) => binNu(b));
  const sunShape = solarShapeRelative(binCenters);
  let groundShape = null; // Planck at the profile's own surface T, set on load
  const SUN = () => cssVar('--series-sun') || '#e08a4a';
  const EMBER = () => cssVar('--series-ember') || '#c96a6a';

  const els = {};
  [
    'demoChart', 'demoChartContainer', 'demoTooltip', 'demoReadout', 'demoLoading', 'demoTitle', 'demoMeta', 'demoToggleCO2Trace',
    'emitChart', 'emitChartContainer', 'emitTooltip', 'emitToggleSun', 'emitToggleGround', 'emitModePeak', 'emitModeAvg', 'emitModeNoon', 'emitMeta', 'demoToggleCO2', 'demoToggleH2OTrace', 'demoToggleH2O',
    'co2Bar', 'co2Scope', 'co2BarScope', 'ppmSlider', 'ppmInput', 'refPill', 'refPillValue', 'sliderCallout',
    'refGrid', 'refCustomCard', 'refCustomInput', 'refCustomBtn', 'refChosen', 'refChosenValue', 'refPrompt',
    'profileGrid', 'profilePrompt', 'profileChosen', 'profileChosenName', 'globeCanvas', 'globeContainer',
    'specChart', 'specChartContainer', 'specChartTitle', 'specMeta', 'specTooltip', 'specReadout', 'specLoading',
    'specLegend', 'waterCallout', 'waterCalloutRow',
    'diffPanel', 'diffChart', 'diffChartContainer', 'diffChartTitle', 'diffMeta', 'diffTooltip', 'diffReadout',
    'resultStatement', 'resultStation', 'resultFrom', 'resultTo', 'resultGround', 'resultGroundSub', 'resultSun', 'resultSunSub',
    'toS5', 'toS6', 'toS7',
    'toggleCO2', 'toggleRef', 'toggleSun', 'toggleGround', 'toggleH2O', 'toggleCombined',
    'solarToggleCO2', 'solarToggleBoth', 'solarToggleH2O', 'solarToggleDry',
    'thermalToggleCO2', 'thermalToggleBoth', 'thermalToggleH2O', 'thermalToggleDry',
    'solarChart', 'solarChartContainer', 'solarTooltip', 'solarReadout',
    'thermalChart', 'thermalChartContainer', 'thermalTooltip', 'thermalReadout',
    'sampleAll', 'sampleHint', 'solarTable',
    'altUpChart', 'altUpChartContainer', 'altUpTooltip', 'altUpReadout', 'altUpToggleRef', 'altUpToggleCur',
    'altDownChart', 'altDownChartContainer', 'altDownTooltip', 'altDownReadout', 'altDownToggleRef', 'altDownToggleCur',
    'profChart', 'profChartContainer', 'profTooltip', 'profReadout', 'profToggleSun', 'profToggleGround', 'profToggleCO2', 'profToggleH2O',
    'bandTable', 'resetLab', 'tryAnother', 'tryAnotherRef', 'skipAhead', 'skipIntro', 'oprahTop', 'oprahBottom',
  ].forEach((id) => { els[id] = document.getElementById(id); });
  const zoomButtons = Array.from(document.querySelectorAll('.zoom-btn[data-zoom]'));  // mode buttons carry no data-zoom
  // one direction for the energy section's paired charts, one for the height pair;
  // each pair is two cards, one shown at a time, the switch repeated on both
  let energyDir = 'down';   // 'down' sunlight | 'up' ground heat
  let heightDir = 'up';     // 'up' climbing from the ground | 'down' from the top
  const dirButtons = Array.from(document.querySelectorAll('.dir-btn[data-dir]'));
  const hdirButtons = Array.from(document.querySelectorAll('.hdir-btn[data-hdir]'));
  function applyDirs() {
    const card = (id) => document.getElementById(id);
    if (card('solarCard')) card('solarCard').hidden = energyDir !== 'down';
    if (card('thermalCard')) card('thermalCard').hidden = energyDir !== 'up';
    if (card('altUpCard')) card('altUpCard').hidden = heightDir !== 'up';
    if (card('altDownCard')) card('altDownCard').hidden = heightDir !== 'down';
    dirButtons.forEach((b) => { const on = b.getAttribute('data-dir') === energyDir; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    hdirButtons.forEach((b) => { const on = b.getAttribute('data-hdir') === heightDir; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  }

  const sections = {
    s2: document.getElementById('reference'),
    s3: document.getElementById('water'),
    s4: document.getElementById('spectrum'),
    s4b: document.getElementById('spectrumLive'),
    s5: document.getElementById('solar'),
    s6: document.getElementById('altitude'),
    s7: document.getElementById('endcard'),
  };
  const SECTION_ORDER = [
    { key: 's2', idx: 2 },
    { key: 's3', idx: 3 },
    { key: 's4', idx: 4 },
    { key: 's4b', idx: 4 },
    { key: 's5', idx: 5 },
    { key: 's6', idx: 6 },
    { key: 's7', idx: 7 },
  ];
  const refCards = Array.from(document.querySelectorAll('.ref-card[data-ref-ppm]'));

  const GOLD = () => cssVar('--accent') || '#d4a855';
  const BLUE = () => cssVar('--series-obs') || '#5090f8';
  const GREEN = () => '#2eaa74';           // water vapour (bolder than the site's soft green)
  const NAIVE = () => '#9b59d0';           // CO₂ "if absorption simply added up"
  const NAIVE_H2O = () => '#1fa7c4';       // water vapour "if absorption simply added up"
  const MUTED = () => cssVar('--muted') || '#5a6880';
  const TEXTC = () => cssVar('--text') || '#e8e2d4';

  /* ── Derived spectra ── */
  // The live charts run through the chosen station; the intro chart through
  // the standard atmosphere.
  function vmr() { return vmrPpm * 1e-6; }
  function tAt(ppm, d = data) { return transmittance(d.co2Sum, W_G, ppm * 1e-6, N_BINS, N_G); }
  function tCur() { return tAt(vmrPpm); }
  function tRef() { return refPpm == null ? null : tAt(refPpm); }
  function tH2O() { return data ? transmittance(data.h2oSum, W_G, 1.0, N_BINS, N_G) : null; }

  /* ── Canvas helpers (site chart style) ── */
  function setupCanvas(container, canvas) {
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 280;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    return { ctx, W, H };
  }

  // Framed axes with wavenumber ticks labelled in both cm-1 and μm.
  function drawSpectralFrame(ctx, W, H, pad, xLo, xHi, yLo, yHi, yFmt, yUnit, yTicks = null, ypOverride = null) {
    const textColor = cssVar('--text-secondary') || '#a8a090';
    const gridColor = 'rgba(212,168,85,0.12)';
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const xp = (x) => pad.left + ((x - xLo) / Math.max(1e-9, xHi - xLo)) * cW;
    const yp = ypOverride
      ? (y) => pad.top + (1 - ypOverride(y)) * cH
      : (y) => pad.top + (1 - (y - yLo) / Math.max(1e-9, yHi - yLo)) * cH;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    const ticks = yTicks || [0, 1, 2, 3, 4].map((i) => yHi - (yHi - yLo) * (i / 4));
    ticks.forEach((v) => {
      const y = yp(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(`${yFmt(v)}${yUnit ? ' ' + yUnit : ''}`, pad.left - 6, y + 4);
    });
    // x ticks: pick a nice step for the visible span
    // at least five ticks; more when there is room for their three-row labels
    const span = xHi - xLo;
    const maxTicks = Math.max(5, Math.floor(cW / 70));
    const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000].find((st) => span / st <= maxTicks) || 1000;
    ctx.textAlign = 'center';
    // three ways of naming the same colour: wavenumber, wavelength, frequency —
    // units once in the left gutter, numbers only at the ticks so five fit on a phone
    const rowsY = [H - 30, H - 18, H - 6];
    ctx.textAlign = 'right';
    ['cm⁻¹', 'μm', 'THz'].forEach((u, i) => ctx.fillText(u, pad.left - 6, rowsY[i]));
    // the axis line and, at every tick, a faint gridline up the plot and a short mark below it
    const axisColor = cssVar('--border-strong') || 'rgba(212,168,85,0.42)';
    ctx.strokeStyle = axisColor;
    ctx.beginPath(); ctx.moveTo(pad.left, pad.top + cH); ctx.lineTo(pad.left + cW, pad.top + cH); ctx.stroke();
    for (let v = Math.ceil(xLo / step) * step; v <= xHi; v += step) {
      const x = xp(v);
      ctx.strokeStyle = gridColor;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + cH); ctx.stroke();
      ctx.strokeStyle = axisColor;
      ctx.beginPath(); ctx.moveTo(x, pad.top + cH); ctx.lineTo(x, pad.top + cH + 5); ctx.stroke();
    }
    ctx.fillStyle = textColor;
    for (let v = Math.ceil(xLo / step) * step; v <= xHi; v += step) {
      const um = 10000 / v;
      const thz = v * 0.0299792458;
      const rows = [String(v), um >= 10 ? um.toFixed(0) : um.toFixed(1), thz >= 100 ? thz.toFixed(0) : thz.toFixed(1)];
      const half = Math.max(...rows.map((t) => ctx.measureText(t).width)) / 2;
      let x = xp(v);
      ctx.textAlign = 'center';
      if (x + half > W - 2) { ctx.textAlign = 'right'; x = W - 2; } else if (x - half < pad.left + 2) { ctx.textAlign = 'left'; x = pad.left + 2; }
      rows.forEach((t, i) => ctx.fillText(t, x, rowsY[i]));
    }
    return { xp, yp, cW, cH };
  }

  function drawSeries(ctx, series, xp, yp, xLo, xHi, color, width = 1.4, dash = null) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (let b = 0; b < N_BINS; b++) {
      const nu = binNu(b);
      if (nu < xLo || nu > xHi) continue;
      if (!Number.isFinite(series[b])) { started = false; continue; }
      const x = xp(nu);
      const y = yp(series[b]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  /* ── Emission spectra: the sun and the ground, far-IR to UV, log axis ── */
  let emitLayout = null;
  let emitCache = null;
  function emitCurves() {
    if (emitCache) return emitCache;
    const lo = Math.log(100); const hi = Math.log(60000);      // 100 μm .. 167 nm
    const n = 700;
    const nu = Array.from({ length: n }, (_, i) => Math.exp(lo + (hi - lo) * i / (n - 1)));
    const sunNoon = planckExitance(nu, T_SUN).map((v) => v * SUN_DILUTION);
    emitCache = {
      nu,
      sun: solarShapeRelative(nu, T_SUN), ground: solarShapeRelative(nu, T_GROUND),
      sunNoon, sunAvg: sunNoon.map((v) => v / 4),          // spread over the whole sphere, day and night
      groundAvg: planckExitance(nu, T_GROUND), groundNoon: planckExitance(nu, T_GROUND_EQ),
    };
    return emitCache;
  }
  function drawEmitChart() {
    if (!els.emitChart) return;
    const c = emitCurves();
    const { ctx, W, H } = setupCanvas(els.emitChartContainer, els.emitChart);
    const pad = { top: 14, right: 16, bottom: 54, left: 52 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const lLo = Math.log(100); const lHi = Math.log(60000);
    const xp = (v) => pad.left + ((Math.log(v) - lLo) / (lHi - lLo)) * cW;
    const energy = emitMode !== 'peak';
    const noon = emitMode === 'noon';
    // energy view: log axis, W/m² per cm⁻¹, spanning the ground's peak down to the sun's tails
    const eLo = 1e-5; const eHi = 10;
    const yp = energy
      ? (v) => pad.top + (1 - (Math.log10(Math.max(v, eLo)) - Math.log10(eLo)) / (Math.log10(eHi) - Math.log10(eLo))) * cH
      : (v) => pad.top + (1 - v) * cH;
    const textColor = cssVar('--text-secondary') || '#a8a090';
    const gridColor = 'rgba(212,168,85,0.12)';
    const axisColor = cssVar('--border-strong') || 'rgba(212,168,85,0.42)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    // y grid
    ctx.strokeStyle = gridColor; ctx.fillStyle = textColor;
    const yTicks = energy ? [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1, 10] : [0, 0.25, 0.5, 0.75, 1];
    yTicks.forEach((v) => {
      ctx.beginPath(); ctx.moveTo(pad.left, yp(v)); ctx.lineTo(pad.left + cW, yp(v)); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(energy ? (v >= 1 ? String(v) : v.toFixed(Math.round(-Math.log10(v)))) : v.toFixed(2), pad.left - 6, yp(v) + 4);
    });
    // the visible band, painted in its colours, and the range the rest of the page covers
    const vLo = 1e7 / 780; const vHi = 1e7 / 380;
    for (let x = Math.ceil(xp(vLo)); x <= xp(vHi); x++) {
      const nu = Math.exp(lLo + ((x - pad.left) / cW) * (lHi - lLo));
      ctx.fillStyle = wavelengthToRgb(1e7 / nu) || 'transparent';
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x, pad.top, 1, cH);
    }
    ctx.globalAlpha = 1;
    const bx0 = xp(NU_MIN); const bx1 = xp(NU_MIN + N_BINS * BIN_W);
    ctx.fillStyle = 'rgba(128,128,128,0.08)';
    ctx.fillRect(bx0, pad.top, bx1 - bx0, cH);
    // the band's edges, marked with inward arrows so the extent is unmistakable
    ctx.strokeStyle = textColor; ctx.fillStyle = textColor; ctx.lineWidth = 1;
    const edge = (x, dir) => {
      ctx.beginPath(); ctx.moveTo(x, pad.top + 4); ctx.lineTo(x, pad.top + 30); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, pad.top + 17); ctx.lineTo(x + dir * 7, pad.top + 13); ctx.lineTo(x + dir * 7, pad.top + 21); ctx.closePath(); ctx.fill();
    };
    edge(bx0, 1); edge(bx1, -1);
    // label, wrapped onto two lines when the band is narrow (phones)
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center';
    const bandMid = (bx0 + bx1) / 2;
    const oneLine = 'the rest of this page lives here';
    if (ctx.measureText(oneLine).width + 24 <= bx1 - bx0) {
      ctx.fillText(oneLine, bandMid, pad.top + 12);
    } else {
      ctx.fillText('the rest of this', bandMid, pad.top + 12);
      ctx.fillText('page lives here', bandMid, pad.top + 24);
    }
    // the visible band's label sits at the bottom, clear of the sun's curve and the band label
    ctx.fillText('visible', (xp(vLo) + xp(vHi)) / 2, pad.top + cH - 6);
    // x axis: log ticks, three unit rows
    ctx.strokeStyle = axisColor;
    ctx.beginPath(); ctx.moveTo(pad.left, pad.top + cH); ctx.lineTo(pad.left + cW, pad.top + cH); ctx.stroke();
    const rowsY = [H - 30, H - 18, H - 6];
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = textColor; ctx.textAlign = 'right';
    ['cm⁻¹', 'μm', 'THz'].forEach((u, i) => ctx.fillText(u, pad.left - 6, rowsY[i]));
    [100, 300, 1000, 3000, 10000, 30000].forEach((v) => {
      const x = xp(v);
      ctx.strokeStyle = gridColor; ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + cH); ctx.stroke();
      ctx.strokeStyle = axisColor; ctx.beginPath(); ctx.moveTo(x, pad.top + cH); ctx.lineTo(x, pad.top + cH + 5); ctx.stroke();
      const um = 10000 / v; const thz = v * 0.0299792458;
      const rows = [String(v), um >= 10 ? um.toFixed(0) : um >= 1 ? um.toFixed(1) : um.toFixed(2), thz >= 100 ? thz.toFixed(0) : thz.toFixed(1)];
      const half = Math.max(...rows.map((t) => ctx.measureText(t).width)) / 2;
      let tx = x; ctx.textAlign = 'center';
      if (tx - half < pad.left + 2) { ctx.textAlign = 'left'; tx = pad.left + 2; }
      rows.forEach((t, i) => ctx.fillText(t, tx, rowsY[i]));
    });
    // the curves; through the visible band the sun's is painted in the colour of the light
    const drawCurve = (ys, baseColor, paint) => {
      ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
      let prev = null;
      for (let i = 0; i < c.nu.length; i++) {
        const x = xp(c.nu[i]); const y = yp(ys[i]);
        if (prev) {
          const col = paint ? wavelengthToRgb(1e7 / c.nu[i]) : null;
          ctx.strokeStyle = col || baseColor;
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(x, y); ctx.stroke();
        }
        prev = [x, y];
      }
    };
    const sunY = !energy ? c.sun : noon ? c.sunNoon : c.sunAvg;
    const groundY = !energy ? c.ground : noon ? c.groundNoon : c.groundAvg;
    if (emitShow.ground) drawCurve(groundY, EMBER(), false);
    if (emitShow.sun) drawCurve(sunY, SUN(), true);
    if (energy) {
      // the area under each curve: its total, from Stefan–Boltzmann
      const sunTotal = SIGMA_SB * Math.pow(T_SUN, 4) * SUN_DILUTION * (noon ? 1 : 0.25);
      const groundTotal = SIGMA_SB * Math.pow(noon ? T_GROUND_EQ : T_GROUND, 4);
      const annotate = (ys, total, color, who) => {
        let pi = 0; for (let i = 1; i < ys.length; i++) if (ys[i] > ys[pi]) pi = i;
        const x = xp(c.nu[pi]); const y = yp(ys[pi]);
        ctx.fillStyle = color; ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`${who}: ${total.toFixed(0)} W/m² in total`, x, y - 10);
      };
      if (emitShow.ground) annotate(groundY, groundTotal, EMBER(), 'ground');
      if (emitShow.sun) annotate(sunY, sunTotal, SUN(), 'sun');
    }
    emitLayout = { xp, lLo, lHi, c, pad, cW, sunY, groundY, energy };
    if (els.emitMeta) {
      els.emitMeta.textContent = !energy
        ? 'each scaled to its own peak · far infrared to ultraviolet · log axis'
        : noon
          ? 'W/m² per cm⁻¹ · sun overhead at the top of the atmosphere · ground at 26 °C · log axes'
          : 'W/m² per cm⁻¹ · sunlight averaged over the whole globe, day and night · ground at 15 °C · log axes';
    }
    if (els.emitToggleGround) els.emitToggleGround.textContent = noon ? 'the ground, 26 °C' : 'the ground, 15 °C';
    if (els.emitToggleSun) els.emitToggleSun.textContent = !energy ? 'the sun, 5772 K' : noon ? 'the sun, overhead' : 'the sun, global average';
    els.emitChartContainer.setAttribute('role', 'img');
    els.emitChartContainer.setAttribute('aria-label', !energy
      ? 'Emission spectra of the sun at 5772 kelvin and the ground at 15 degrees Celsius, each scaled to its own peak, on a logarithmic wavenumber axis from the far infrared to the ultraviolet, with the visible band marked.'
      : noon
        ? 'Spectral energy flux at Earth, watts per square metre per wavenumber on a logarithmic axis: the sun overhead at the top of the atmosphere, 1361 watts per square metre in total, and the ground at 26 degrees Celsius, 454 in total.'
        : 'Spectral energy flux at Earth, watts per square metre per wavenumber on a logarithmic axis: sunlight averaged over the whole globe, 340 watts per square metre in total, and the ground at 15 degrees Celsius, 391 in total.');
  }

  /* ── Opening demonstration chart: a lab sample, absorbance, trace vs typical ── */
  let demoLayout = null;
  let demoCache = null;
  function demoCurves() {
    if (demoCache) return demoCache;
    // the sample is the bottom slab of the standard atmosphere (one T, one p),
    // rescaled from its own thickness to DEMO_PATH_M
    const f = DEMO_PATH_M / stdData.slabThicknessM;
    const co2Scale = DEMO_CO2_PPM * 1e-6 * f;                 // per-unit-vmr grid × vmr × path
    const h2oScale = f;                                        // actual od at the slab's humidity × path
    const co2TraceScale = scaleForPeakAbsorbance(stdData.co2Slab, W_G, DEMO_PEAK_ABS, N_BINS, N_G);
    const h2oTraceScale = stdData.h2oSlab ? scaleForPeakAbsorbance(stdData.h2oSlab, W_G, DEMO_PEAK_ABS, N_BINS, N_G) : null;
    demoCache = {
      co2: sampleAbsorbance(stdData.co2Slab, W_G, co2Scale, N_BINS, N_G),
      co2Trace: sampleAbsorbance(stdData.co2Slab, W_G, co2TraceScale, N_BINS, N_G),
      h2o: stdData.h2oSlab ? sampleAbsorbance(stdData.h2oSlab, W_G, h2oScale, N_BINS, N_G) : null,
      h2oTrace: stdData.h2oSlab ? sampleAbsorbance(stdData.h2oSlab, W_G, h2oTraceScale, N_BINS, N_G) : null,
      co2TracePpm: (co2TraceScale / f) * 1e6,
      h2oTraceFraction: h2oTraceScale == null ? null : h2oTraceScale / f,   // × the slab's own humidity
    };
    // the slab's own humidity (layer mean, as compute_od takes it)
    const q = stdData.profile.levels.q_h2o_vmr;
    demoCache.h2oPpm = 1e6 * Math.sqrt(q[0] * q[1]);
    demoCache.h2oTracePpm = demoCache.h2oTraceFraction == null ? null : demoCache.h2oTraceFraction * demoCache.h2oPpm;
    // the legend says what each curve actually is
    const ppm = (v) => (v >= 100 ? `${v.toFixed(0)} ppm` : `${v.toFixed(1)} ppm`);
    if (els.demoToggleCO2Trace) els.demoToggleCO2Trace.textContent = `CO₂ ${ppm(demoCache.co2TracePpm)}`;
    if (els.demoToggleCO2) els.demoToggleCO2.textContent = `CO₂ ${DEMO_CO2_PPM} ppm`;
    if (els.demoToggleH2OTrace && demoCache.h2oTracePpm != null) els.demoToggleH2OTrace.textContent = `water vapour ${ppm(demoCache.h2oTracePpm)}`;
    if (els.demoToggleH2O) els.demoToggleH2O.textContent = `water vapour ${demoCache.h2oPpm.toFixed(0)} ppm`;
    return demoCache;
  }
  function drawDemoChart() {
    if (!stdData || !els.demoChart) return;
    const c = demoCurves();
    const { ctx, W, H } = setupCanvas(els.demoChartContainer, els.demoChart);
    const pad = { top: 14, right: 16, bottom: 54, left: 52 };
    const on = [
      demoShow.co2 ? c.co2 : null, demoShow.co2Trace ? c.co2Trace : null,
      demoShow.h2o ? c.h2o : null, demoShow.h2oTrace ? c.h2oTrace : null,
    ].filter(Boolean);
    const trans = specMode === 'trans';
    const toT = (arr) => { const o = new Float64Array(N_BINS); for (let bb = 0; bb < N_BINS; bb++) o[bb] = Math.pow(10, -arr[bb]); return o; };
    let frame;
    let yHi;
    if (trans) {
      yHi = 1;
      frame = drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, 0, 1, (v) => v.toFixed(2), '');
      ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('the floor: nothing left to absorb — clipped', pad.left + frame.cW - 8, frame.yp(0) - 5);
    } else {
      // y-axis: absorbance, scaled to what is switched on, capped where a
      // detector runs out of light
      let m = 0;
      on.forEach((arr) => { for (let bb = 0; bb < N_BINS; bb++) { const nu = binNu(bb); if (nu >= zoom.lo && nu <= zoom.hi && arr[bb] > m) m = arr[bb]; } });
      const clipped = m > DEMO_ABS_MAX;
      yHi = clipped ? DEMO_ABS_MAX : Math.max(0.05, Math.ceil(m * 20) / 20);
      const ticks = clipped ? [0, 0.5, 1, 1.5, 2, 2.5, 3] : [0, 0.25, 0.5, 0.75, 1].map((f) => f * yHi);
      frame = drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, 0, yHi, (v) => v.toFixed(2), '', ticks);
      if (clipped) drawAbsCeiling(ctx, frame, pad);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.left, pad.top, frame.cW, frame.cH); ctx.clip();
    const shown = (arr) => {
      if (trans) return toT(arr);
      const o = new Float64Array(N_BINS); for (let bb = 0; bb < N_BINS; bb++) o[bb] = Math.min(arr[bb], yHi); return o;
    };
    if (demoShow.h2o && c.h2o) drawSeries(ctx, shown(c.h2o), frame.xp, frame.yp, zoom.lo, zoom.hi, GREEN(), 1.4);
    if (demoShow.h2oTrace && c.h2oTrace) drawSeries(ctx, shown(c.h2oTrace), frame.xp, frame.yp, zoom.lo, zoom.hi, NAIVE_H2O(), 1.4);
    if (demoShow.co2 && c.co2) drawSeries(ctx, shown(c.co2), frame.xp, frame.yp, zoom.lo, zoom.hi, BLUE(), 1.6);
    if (demoShow.co2Trace) drawSeries(ctx, shown(c.co2Trace), frame.xp, frame.yp, zoom.lo, zoom.hi, NAIVE(), 1.6);
    ctx.restore();
    if (els.demoTitle) els.demoTitle.textContent = `Lab-sample ${trans ? 'transmittance' : 'absorbance'} — ${DEMO_PATH_M} m of ground-level air`;
    if (els.demoMeta) {
      els.demoMeta.textContent = trans
        ? 'transmittance · 1 = passes everything · 0 = passes nothing'
        : 'absorbance · 1 = a tenth gets through · 3 = a thousandth';
    }
    demoLayout = { xp: frame.xp, c };
    els.demoChartContainer.setAttribute('role', 'img');
    els.demoChartContainer.setAttribute('aria-label',
      `Absorbance of a ${DEMO_PATH_M} m sample of ground-level air between ${zoom.lo} and ${zoom.hi} inverse centimetres: CO₂ as a trace with its strongest band at transmittance 0.1 and at ${DEMO_CO2_PPM} parts per million, and water vapour as a trace and at a typical humidity.`);
    if (els.demoReadout) {
      els.demoReadout.textContent =
        `The sample: ${DEMO_PATH_M} m of air at ground-level pressure and temperature. ` +
        `The smaller amount of each gas is a trace, chosen so its strongest band lets just a tenth of the light through; ` +
        `the larger is about what you would find in the air today — ${DEMO_CO2_PPM} ppm of CO₂, and for water vapour the sample's typical ground-level humidity. ` +
        'Hover to read absorbance and the fraction of light that gets through. Legend entries are switches: click one to hide or show that curve.';
    }
  }

  /* ── Live spectrum chart ── */
  let specLayout = null;
  function drawSpecChart() {
    if (!data || !els.specChart) return;
    const { ctx, W, H } = setupCanvas(els.specChartContainer, els.specChart);
    const pad = { top: 14, right: 16, bottom: 54, left: 52 };
    const abs = specMode === 'abs';
    const yHi = abs ? ABS_MAX : 1;
    const frame = abs
      ? drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, 0, ABS_MAX, (v) => v.toFixed(2), '', [0, 0.5, 1, 1.5, 2, 2.5, 3])
      : drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, 0, 1, (v) => v.toFixed(2), '');
    if (abs) drawAbsCeiling(ctx, frame, pad);
    const cur = tCur();
    const ref = tRef();
    const h2o = data && (showH2O || showCombined) ? tH2O() : null;
    const shown = (t) => (abs ? toAbs(t) : t);
    // the source-spectrum overlays are relative shapes: stretch them to the axis
    const shape = (arr) => { if (!abs) return arr; const o = new Float64Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = arr[i] * yHi; return o; };
    if (showSun) {
      // faint filled area under the relative solar curve, drawn first as context
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = SUN();
      ctx.beginPath();
      let started = false;
      for (let b = 0; b < N_BINS; b++) {
        const nu = binNu(b);
        if (nu < zoom.lo || nu > zoom.hi) continue;
        const x = frame.xp(nu);
        const y = frame.yp(sunShape[b] * yHi);
        if (!started) { ctx.moveTo(x, frame.yp(0)); started = true; }
        ctx.lineTo(x, y);
      }
      if (started) {
        ctx.lineTo(frame.xp(Math.min(zoom.hi, NU_MIN + N_BINS * BIN_W)), frame.yp(0));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      drawSeries(ctx, shape(sunShape), frame.xp, frame.yp, zoom.lo, zoom.hi, SUN(), 1.1);
    }
    if (showGround && groundShape) {
      drawSeries(ctx, shape(groundShape), frame.xp, frame.yp, zoom.lo, zoom.hi, EMBER(), 1.2);
    }
    if (showH2O && h2o) drawSeries(ctx, shown(h2o), frame.xp, frame.yp, zoom.lo, zoom.hi, GREEN(), 1.3);
    if (showCombined && h2o) {
      drawSeries(ctx, shown(combineTransmittance(cur, h2o)), frame.xp, frame.yp, zoom.lo, zoom.hi, TEXTC(), 1.2);
    }
    if (ref && showRef) drawSeries(ctx, shown(ref), frame.xp, frame.yp, zoom.lo, zoom.hi, GOLD(), 1.4);
    if (showCO2) drawSeries(ctx, shown(cur), frame.xp, frame.yp, zoom.lo, zoom.hi, BLUE(), 1.4);
    specLayout = { xp: frame.xp, cur, ref, h2o: showH2O ? h2o : null };
    if (els.specMeta) {
      els.specMeta.textContent = abs
        ? 'absorbance · 1 = a tenth gets through · 3 = a thousandth'
        : '1 = passes everything · 0 = passes nothing';
    }
    els.specChartContainer.setAttribute('role', 'img');
    els.specChartContainer.setAttribute('aria-label',
      `Computed atmospheric transmittance between ${zoom.lo} and ${zoom.hi} inverse centimetres through ${scopeName()}.`);
    if (els.specReadout) {
      const parts = [`CO₂ at ${fmtPpm(vmrPpm)} ppm through ${scopeName()}`];
      if (refPpm != null) parts.push(`reference marked at ${fmtPpm(refPpm)} ppm`);
      if (showH2O) parts.push('water vapour shown at the humidity the balloons measured');
      els.specReadout.textContent = parts.join('  ·  ');
    }
    fillBandTable();
  }

  function scopeName() {
    return station ? `${station.name}'s measured atmosphere` : 'the chosen atmosphere';
  }

  /* ── Difference chart ── */
  let diffLayout = null;
  function drawDiffChart() {
    if (!data || refPpm == null || !els.diffChart) return;
    const { ctx, W, H } = setupCanvas(els.diffChartContainer, els.diffChart);
    const abs = specMode === 'abs';
    // in absorbance mode both curves are capped at the detector ceiling first,
    // so a change the detector could not see counts as no change
    const cur = abs ? toAbs(tCur()) : tCur();
    const ref = abs ? toAbs(tRef()) : tRef();
    const diff = new Float64Array(N_BINS);
    for (let b = 0; b < N_BINS; b++) diff[b] = cur[b] - ref[b];
    // a fixed axis, so the height of a change means the same at every slider
    // position; the zoom presets are there for detail
    const lim = abs ? ABS_MAX : 1;
    const pad = { top: 14, right: 16, bottom: 54, left: 52 };
    const frame = drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, -lim, lim, (v) => v.toFixed(2), '');
    // zero line
    ctx.strokeStyle = 'rgba(212,168,85,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, frame.yp(0));
    ctx.lineTo(pad.left + frame.cW, frame.yp(0));
    ctx.stroke();
    ctx.setLineDash([]);
    drawSeries(ctx, diff, frame.xp, frame.yp, zoom.lo, zoom.hi, BLUE(), 1.3);
    diffLayout = { xp: frame.xp, diff };
    // the chart must survive a screenshot without the page around it
    ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    if (abs) {
      ctx.fillText('+ more absorbed than at your reference', pad.left + 6, pad.top + 12);
      ctx.fillText('− less absorbed than at your reference', pad.left + 6, pad.top + frame.cH - 6);
    } else {
      ctx.fillText('+ more light passes than at your reference', pad.left + 6, pad.top + 12);
      ctx.fillText('− less light passes than at your reference', pad.left + 6, pad.top + frame.cH - 6);
    }
    const what = abs ? 'absorbance' : 'transmittance';
    if (els.diffChartTitle) {
      els.diffChartTitle.textContent = `Change in ${what}, ${fmtPpm(refPpm)} → ${fmtPpm(vmrPpm)} ppm, through ${station ? station.name : 'the chosen atmosphere'}`;
    }
    if (els.diffMeta) {
      els.diffMeta.textContent = abs
        ? 'slider minus reference · + = more absorbed · fixed ±3 axis · same zoom as above'
        : 'slider minus reference · + = more light passes · fixed ±1 axis · same zoom as above';
    }
    if (els.diffReadout) {
      els.diffReadout.textContent =
        `Each point is ${what} at ${fmtPpm(vmrPpm)} ppm minus ${what} at your reference, ${fmtPpm(refPpm)} ppm, at that wavelength. ` +
        (abs ? 'Absorbance is capped at 3 on both sides first, so where both are already past the ceiling the change reads as zero: the detector could not tell. ' : '') +
        'A flat line on zero means your change did nothing there.';
    }
  }

  /* ── The two heights: where the ground drops out of sight (climbing up), and
     where the top of the atmosphere drops out of sight (coming down) ── */
  let altLayout = { up: null, down: null };
  function altCurves() {
    const zTop = data.profile.layers.z_top_m[data.nLayers - 1];
    const refKey = `${stationId}:${refPpm}`;
    if (altRefCache.key !== refKey) altRefCache = { key: refKey, down: null, up: null };
    if (refPpm != null && !altRefCache.down) {
      altRefCache.down = emissionAltitude(data.co2, data.nLayers, N_BINS, N_G, W_G, refPpm * 1e-6, data.zMids, data.zSurface);
      altRefCache.up = groundHiddenAltitude(data.co2, data.nLayers, N_BINS, N_G, W_G, refPpm * 1e-6, data.zMids);
    }
    const curDown = emissionAltitude(data.co2, data.nLayers, N_BINS, N_G, W_G, vmr(), data.zMids, data.zSurface);
    const curUp = groundHiddenAltitude(data.co2, data.nLayers, N_BINS, N_G, W_G, vmr(), data.zMids);
    // transparent wavelengths: the ground never drops out of sight → clip at our
    // top of the atmosphere; the top never drops out of sight → the ground
    const clipUp = (arr) => { const o = new Float64Array(N_BINS); for (let b = 0; b < N_BINS; b++) o[b] = Number.isFinite(arr[b]) ? arr[b] : zTop; return o; };
    const clipDown = (arr) => { const o = new Float64Array(N_BINS); for (let b = 0; b < N_BINS; b++) o[b] = Number.isFinite(arr[b]) ? arr[b] : data.zSurface; return o; };
    return {
      zTop,
      up: { cur: clipUp(curUp), ref: altRefCache.up ? clipUp(altRefCache.up) : null },
      down: { cur: clipDown(curDown), ref: altRefCache.down ? clipDown(altRefCache.down) : null },
    };
  }
  function drawHeightChart(kind, curves, zTop) {
    const canvas = kind === 'up' ? els.altUpChart : els.altDownChart;
    const container = kind === 'up' ? els.altUpChartContainer : els.altDownChartContainer;
    const show = kind === 'up' ? altUpShow : altDownShow;
    if (!canvas || !container) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const lo = data.zSurface / 1000; const hi = zTop / 1000;
    const pad = { top: 14, right: 16, bottom: 54, left: 52 };
    const frame = drawSpectralFrame(ctx, W, H, pad, zoom.lo, zoom.hi, lo, hi, (v) => v.toFixed(0), 'km',
      [lo, lo + (hi - lo) * 0.25, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.75, hi]);
    // above the balloon data: standard-atmosphere climatology
    const zDataKm = data.zDataTop / 1000;
    ctx.fillStyle = 'rgba(128,128,128,0.10)';
    ctx.fillRect(pad.left, frame.yp(hi), frame.cW, Math.max(0, frame.yp(zDataKm) - frame.yp(hi)));
    ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('above balloon data — standard-atmosphere climatology', pad.left + 6, frame.yp(zDataKm) - 5);
    ctx.textAlign = 'right';
    ctx.fillText(kind === 'up'
      ? `at the top: the ground never drops out of sight — the air is transparent there`
      : `on the ground: the top of the atmosphere never drops out of sight — transparent`,
      pad.left + frame.cW - 8, kind === 'up' ? pad.top + 12 : frame.yp(lo) - 6);
    const km = (arr) => { const o = new Float64Array(N_BINS); for (let b = 0; b < N_BINS; b++) o[b] = arr[b] / 1000; return o; };
    if (show.ref && curves.ref) drawSeries(ctx, km(curves.ref), frame.xp, frame.yp, zoom.lo, zoom.hi, GOLD(), 1.5);
    if (show.cur) drawSeries(ctx, km(curves.cur), frame.xp, frame.yp, zoom.lo, zoom.hi, BLUE(), 1.5);
    altLayout[kind] = { cur: curves.cur, ref: curves.ref, zTop };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label', kind === 'up'
      ? 'The height above the ground at which the ground drops out of sight, wavelength by wavelength, at your reference and at the slider; where the air is transparent the curve sits at the top of the atmosphere.'
      : 'The depth below the top of the atmosphere at which the top drops out of sight, wavelength by wavelength, at your reference and at the slider; where the air is transparent the curve sits on the ground.');
    const readout = kind === 'up' ? els.altUpReadout : els.altDownReadout;
    if (readout) {
      readout.textContent = kind === 'up'
        ? `Climbing up from the ground at each colour: the height at which the light from the ground has been cut to 1/e — optical depth 1 — and the ground is effectively out of sight. Gold: at your reference, ${refPpm == null ? '—' : fmtPpm(refPpm) + ' ppm'}. Blue: at ${fmtPpm(vmrPpm)} ppm. CO₂ only.`
        : `Coming down from the top of the atmosphere at each colour: the height at which the top has been cut to 1/e — optical depth 1 — and is effectively out of sight. Gold: at your reference, ${refPpm == null ? '—' : fmtPpm(refPpm) + ' ppm'}. Blue: at ${fmtPpm(vmrPpm)} ppm. CO₂ only.`;
    }
  }
  function drawAltChart() {
    if (!data || !els.altUpChart) return;
    const c = altCurves();
    drawHeightChart('up', c.up, c.zTop);
    drawHeightChart('down', c.down, c.zTop);
  }

  /* ── Who absorbs what: each gas's take of the source's energy, in the beam's
     direction (sunlight down, ground heat up). The per-layer walk covers the
     shipped 400–8000 cm-1 range; the precomputed offline totals carry the full
     range, so CO₂'s (weak) out-of-range absorption is credited to CO₂ in full
     and water vapour gets the remainder of the offline total. ── */
  const takeCache = new Map();
  let takeWeights = { key: null, sunW: null, groundW: null, cover: null };
  function ensureTakeWeights() {
    if (!data) return null;
    if (takeWeights.key !== stationId) {
      const sunW = planckBinFraction(binCenters, BIN_W, 5772);
      const groundW = planckBinFraction(binCenters, BIN_W, data.tLevels[0]);
      takeWeights = {
        key: stationId, sunW, groundW,
        cover: { sun: sunW.reduce((a, v) => a + v, 0), ground: groundW.reduce((a, v) => a + v, 0) },
      };
    }
    return takeWeights;
  }
  function dryClientAbsorbed(ppm, binW) {
    const t = tAt(ppm);
    let a = 0;
    for (let b = 0; b < N_BINS; b++) a += binW[b] * (1 - t[b]);
    return a;
  }
  // { solar: { co2, h2o, total, dry }, thermal: { ... } } all in % of the source's total energy
  function takeAt(ppm) {
    const key = Number(ppm.toFixed(1));
    if (takeCache.has(key)) return takeCache.get(key);
    const w = ensureTakeWeights();
    if (!w || !data.energy) return null;
    const g = data.energy.ppm;
    const out = {};
    const blocks = [
      ['solar', data.energy.solar, w.sunW, true],
      ['thermal', data.energy.thermal, w.groundW, false],
    ];
    for (const [name, block, binW, downward] of blocks) {
      const walk = absorptionByLayer(data.co2, data.h2o, data.nLayers, N_BINS, N_G, W_G, ppm * 1e-6, binW, downward);
      const clientCo2 = walk.co2.reduce((a, v) => a + v, 0);
      const dryOffline = interpLogX(g, block.co2_only_pct, ppm);
      const total = interpLogX(g, block.with_h2o_pct, ppm);
      const outOfRange = Math.max(0, dryOffline - 100 * dryClientAbsorbed(ppm, binW));
      const co2 = Math.min(total, 100 * clientCo2 + outOfRange);
      out[name] = { co2, h2o: total - co2, total, dry: dryOffline };
    }
    takeCache.set(key, out);
    return out;
  }

  /* ── Where the extra absorption happens: per-layer change, by gas, by direction ── */
  let profLayout = null;
  let profCache = { key: null, sunRef: null, groundRef: null, sunW: null, groundW: null, cover: null };
  function drawProfileChart() {
    if (!data || refPpm == null || !els.profChart) return;
    const key = `${stationId}:${refPpm}`;
    if (profCache.key !== key) {
      const { sunW, groundW, cover } = ensureTakeWeights();
      profCache = {
        key, sunW, groundW, cover,
        sunRef: absorptionByLayer(data.co2, data.h2o, data.nLayers, N_BINS, N_G, W_G, refPpm * 1e-6, sunW, true),
        groundRef: absorptionByLayer(data.co2, data.h2o, data.nLayers, N_BINS, N_G, W_G, refPpm * 1e-6, groundW, false),
      };
    }
    const sunCur = absorptionByLayer(data.co2, data.h2o, data.nLayers, N_BINS, N_G, W_G, vmr(), profCache.sunW, true);
    const groundCur = absorptionByLayer(data.co2, data.h2o, data.nLayers, N_BINS, N_G, W_G, vmr(), profCache.groundW, false);
    const zb = data.profile.layers.z_bot_m;
    const zt = data.profile.layers.z_top_m;
    // change per km of altitude, in % of the source's total energy
    const perKm = (cur, ref) => {
      const out = new Float64Array(data.nLayers);
      for (let l = 0; l < data.nLayers; l++) out[l] = (100 * (cur[l] - ref[l])) / ((zt[l] - zb[l]) / 1000);
      return out;
    };
    const series = [
      { key: 'sunCo2', on: profShow.sun && profShow.co2, vals: perKm(sunCur.co2, profCache.sunRef.co2), color: BLUE(), dash: null },
      { key: 'sunH2o', on: profShow.sun && profShow.h2o, vals: perKm(sunCur.h2o, profCache.sunRef.h2o), color: GREEN(), dash: null },
      { key: 'gCo2', on: profShow.ground && profShow.co2, vals: perKm(groundCur.co2, profCache.groundRef.co2), color: BLUE(), dash: null },
      { key: 'gH2o', on: profShow.ground && profShow.h2o, vals: perKm(groundCur.h2o, profCache.groundRef.h2o), color: GREEN(), dash: null },
    ];
    const zTopKm = Math.max(data.zDataTop / 1000, 12);
    const { ctx, W, H } = setupCanvas(els.profChartContainer, els.profChart);
    const pad = { top: 26, right: 12, bottom: 34, left: 52 };
    const gap = 56;
    const cH = H - pad.top - pad.bottom;
    const zLo = data.zSurface / 1000;
    const yp = (zKm) => pad.top + (1 - (zKm - zLo) / (zTopKm - zLo)) * cH;
    const textColor = cssVar('--text-secondary') || '#a8a090';
    // two panels, one per direction, each with its own symmetric scale
    const panels = [
      { title: 'sunlight, travelling down', on: profShow.sun, keys: ['sunCo2', 'sunH2o'] },
      { title: 'ground heat, travelling up', on: profShow.ground, keys: ['gCo2', 'gH2o'] },
    ].filter((pn) => pn.on);
    const nP = Math.max(1, panels.length);
    const pW = (W - pad.left - pad.right - gap * (nP - 1)) / nP;
    const byKey = Object.fromEntries(series.map((sr) => [sr.key, sr]));
    const xps = {};
    ctx.font = '11px system-ui, sans-serif';
    // a signed square-root scale: the lowest layer's spike no longer swamps the rest
    const sq = (v) => Math.sign(v) * Math.sqrt(Math.abs(v));
    panels.forEach((pn, pi) => {
      const x0 = pad.left + pi * (pW + gap);
      let m = 1e-6;
      pn.keys.forEach((k) => {
        const sr = byKey[k];
        if (!sr.on) return;
        for (let l = 0; l < data.nLayers; l++) if (zt[l] / 1000 <= zTopKm) m = Math.max(m, Math.abs(sr.vals[l]));
      });
      const lim = m * 1.1;
      const xp = (v) => x0 + ((sq(v) + sq(lim)) / (2 * sq(lim))) * pW;
      xps[pi] = { xp, lim, x0 };
      // frame + grid
      ctx.strokeStyle = 'rgba(212,168,85,0.12)';
      ctx.lineWidth = 1;
      ctx.fillStyle = textColor;
      for (let i = 0; i <= 4; i++) {
        const z = zLo + ((zTopKm - zLo) * i) / 4;
        ctx.beginPath(); ctx.moveTo(x0, yp(z)); ctx.lineTo(x0 + pW, yp(z)); ctx.stroke();
        if (pi === 0) { ctx.textAlign = 'right'; ctx.fillText(`${z.toFixed(0)} km`, pad.left - 6, yp(z) + 4); }
      }
      ctx.textAlign = 'center';
      const dp = lim < 0.01 ? 4 : lim < 0.1 ? 3 : 2;
      [-lim, -lim / 4, 0, lim / 4, lim].forEach((v) => {
        const label = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}`;
        const half = ctx.measureText(label).width / 2;
        let tx = xp(v); ctx.textAlign = 'center';
        if (tx - half < x0) { ctx.textAlign = 'left'; tx = x0; } else if (tx + half > x0 + pW) { ctx.textAlign = 'right'; tx = x0 + pW; }
        ctx.fillText(label, tx, H - 18);
      });
      ctx.fillStyle = pi === 0 && profShow.sun ? SUN() : EMBER();
      ctx.fillText(pn.title, x0 + pW / 2, pad.top - 10);
      ctx.fillStyle = textColor;
      // zero line
      ctx.strokeStyle = 'rgba(212,168,85,0.45)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(xp(0), pad.top); ctx.lineTo(xp(0), pad.top + cH); ctx.stroke();
      ctx.setLineDash([]);
      // step profiles (constant within each layer)
      pn.keys.forEach((k) => {
        const sr = byKey[k];
        if (!sr.on) return;
        ctx.strokeStyle = sr.color;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (let l = 0; l < data.nLayers; l++) {
          if (zb[l] / 1000 > zTopKm) break;
          const x = xp(Math.max(-lim, Math.min(lim, sr.vals[l])));
          const y0 = yp(Math.max(zLo, zb[l] / 1000));
          const y1 = yp(Math.min(zTopKm, zt[l] / 1000));
          if (!started) { ctx.moveTo(x, y0); started = true; } else ctx.lineTo(x, y0);
          ctx.lineTo(x, y1);
        }
        ctx.stroke();
      });
    });
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.fillText(W < 560 ? 'change per km · % of the source · square-root scale' : 'change in energy absorbed per km · % of that source\'s total · each panel has its own square-root scale', pad.left + (W - pad.left - pad.right) / 2, H - 5);
    profLayout = { yp, zb, zt, series, zLo, zTopKm };
    els.profChartContainer.setAttribute('role', 'img');
    els.profChartContainer.setAttribute('aria-label',
      'Change in absorbed energy per kilometre of altitude between your reference and the slider, for sunlight travelling down and ground heat travelling up, split into the part absorbed by CO₂ and the part absorbed by water vapour.');
    if (els.profReadout) {
      const sum = (arr) => arr.reduce((a, v) => a + v, 0);
      const pct = (v) => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(3)}`;
      const dSunC = sum(sunCur.co2) - sum(profCache.sunRef.co2);
      const dSunH = sum(sunCur.h2o) - sum(profCache.sunRef.h2o);
      const dGC = sum(groundCur.co2) - sum(profCache.groundRef.co2);
      const dGH = sum(groundCur.h2o) - sum(profCache.groundRef.h2o);
      els.profReadout.textContent =
        `From ${fmtPpm(refPpm)} to ${fmtPpm(vmrPpm)} ppm, over the wavelengths this page computes ` +
        `(carrying ${(100 * profCache.cover.sun).toFixed(0)} % of the sun's energy and ${(100 * profCache.cover.ground).toFixed(0)} % of the ground's). ` +
        `Sunlight, downward: CO₂ absorbs ${pct(dSunC)} points more, water vapour ${pct(dSunH)}, net ${pct(dSunC + dSunH)}. ` +
        `Ground heat, upward: CO₂ ${pct(dGC)}, water vapour ${pct(dGH)}, net ${pct(dGC + dGH)}. ` +
        'Blue: the change in what CO₂ absorbs in each layer. Green: the change in what water vapour absorbs there.';
    }
  }

  /* ── Absorbed-energy charts, both directions (fill in from the sweep) ── */
  function totalsCfgs() {
    if (!data || !data.energy) return [];
    const tGround = data.energy.thermal.source_temperature_k;
    return [
      {
        block: data.energy.solar,
        container: els.solarChartContainer,
        canvas: els.solarChart,
        readout: els.solarReadout,
        show: solarShow,
        srcWm2: SOLAR_CONST_WM2,
        srcNote: 'overhead sun',
        aria: 'Share of incoming solar energy absorbed by the column versus CO₂ concentration, sampled at the concentrations you have visited.',
      },
      {
        block: data.energy.thermal,
        container: els.thermalChartContainer,
        canvas: els.thermalChart,
        readout: els.thermalReadout,
        show: thermalShow,
        srcWm2: SIGMA_SB * Math.pow(tGround, 4),
        srcNote: `ground radiating at its measured ${tGround.toFixed(0)} K`,
        aria: 'Share of the energy radiated by the ground that the column absorbs on the way up, versus CO₂ concentration, sampled at the concentrations you have visited.',
      },
    ];
  }

  function drawTotalsChart(cfg) {
    if (!cfg.canvas || !cfg.container) return;
    const s = cfg.block;
    const ppmGrid = data.energy.ppm;
    const { ctx, W, H } = setupCanvas(cfg.container, cfg.canvas);
    const yMax = Math.max(...s.with_h2o_pct, s.h2o_only_pct) * 1.15 || 1;
    const pad = { top: 16, right: 18, bottom: 36, left: 52 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const lLo = Math.log(PPM_MIN);
    const lHi = Math.log(PPM_MAX);
    const xp = (ppm) => pad.left + ((Math.log(ppm) - lLo) / (lHi - lLo)) * cW;
    const yp = (pct) => pad.top + (1 - pct / yMax) * cH;
    const textColor = cssVar('--text-secondary') || '#a8a090';
    ctx.strokeStyle = 'rgba(212,168,85,0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (cH / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(`${(yMax * (1 - i / 4)).toFixed(1)} %`, pad.left - 6, y + 4);
    }
    ctx.textAlign = 'center';
    [10, 30, 100, 300, 1000, 3000].forEach((v) => {
      ctx.fillText(String(v), xp(v), H - 8);
    });
    ctx.fillText('CO₂ (ppm)', pad.left + cW / 2, H - 22);

    // Curves through the computed grid once every point has been sampled.
    const curveThrough = (ys, color, dash, width = 1.5) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      ppmGrid.forEach((p, i) => {
        if (ys[i] == null) { started = false; return; }
        if (!started) { ctx.moveTo(xp(p), yp(ys[i])); started = true; } else ctx.lineTo(xp(p), yp(ys[i]));
      });
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    };
    const name = cfg.block === data.energy.solar ? 'solar' : 'thermal';
    if (solarConnected) {
      const takes = ppmGrid.map((p) => takeCache.get(Number(p.toFixed(1))));
      if (cfg.show.both) curveThrough(s.with_h2o_pct, TEXTC(), null);
      if (cfg.show.co2) curveThrough(takes.map((t) => (t ? t[name].co2 : null)), BLUE(), null);
      if (cfg.show.h2o) curveThrough(takes.map((t) => (t ? t[name].h2o : null)), GREEN(), null);
      if (cfg.show.dry) curveThrough(s.co2_only_pct, 'rgba(80,144,248,0.45)', null, 1.1);
    }

    // The sampled points (the reader's own, or all of them after "Sample all").
    const dot = (ppm, pct, color) => {
      if (pct == null) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xp(ppm), yp(pct), solarConnected ? 2 : 3, 0, Math.PI * 2);
      ctx.fill();
    };
    visitedPpm.forEach((ppm) => {
      const t = takeCache.get(Number(ppm.toFixed(1)));
      if (cfg.show.both) dot(ppm, interpLogX(ppmGrid, s.with_h2o_pct, ppm), TEXTC());
      if (cfg.show.co2 && t) dot(ppm, t[name].co2, BLUE());
      if (cfg.show.h2o && t) dot(ppm, t[name].h2o, GREEN());
      if (cfg.show.dry) dot(ppm, interpLogX(ppmGrid, s.co2_only_pct, ppm), 'rgba(80,144,248,0.45)');
    });

    // Marker for the slider's current position (and the reference, if set).
    ctx.strokeStyle = 'rgba(80,144,248,0.35)';
    ctx.beginPath(); ctx.moveTo(xp(vmrPpm), pad.top); ctx.lineTo(xp(vmrPpm), pad.top + cH); ctx.stroke();
    if (refPpm != null) {
      ctx.strokeStyle = 'rgba(212,168,85,0.35)';
      ctx.beginPath(); ctx.moveTo(xp(refPpm), pad.top); ctx.lineTo(xp(refPpm), pad.top + cH); ctx.stroke();
    }
    cfg.container.setAttribute('role', 'img');
    cfg.container.setAttribute('aria-label', cfg.aria);
    if (cfg.readout) {
      const t = takeAt(vmrPpm)[name];
      const wm2 = (pct) => (pct / 100 * cfg.srcWm2).toFixed(1);
      let text =
        `At ${fmtPpm(vmrPpm)} ppm: the column absorbs ${t.total.toFixed(2)} % (${wm2(t.total)} W/m²) — ` +
        `CO₂'s take ${t.co2.toFixed(2)} % (${wm2(t.co2)} W/m²), water vapour's take ${t.h2o.toFixed(2)} % (${wm2(t.h2o)} W/m²); ` +
        `for comparison, CO₂ in dry air would take ${t.dry.toFixed(2)} % — ${cfg.srcNote}.`;
      if (refPpm != null) {
        const r = takeAt(refPpm)[name];
        const f = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
        text += ` From your reference (${fmtPpm(refPpm)} ppm): total ${f(t.total - r.total)} points ` +
          `(${f((t.total - r.total) / 100 * cfg.srcWm2)} W/m²); CO₂'s take ${f(t.co2 - r.co2)}, water vapour's take ${f(t.h2o - r.h2o)}.`;
      }
      cfg.readout.textContent = text;
    }
  }

  function updateResultStatement() {
    if (!els.resultStatement || !data || !data.energy) return;
    if (refPpm == null) { els.resultStatement.hidden = true; return; }
    const t = takeAt(vmrPpm);
    const r = takeAt(refPpm);
    if (!t || !r) return;
    const f = (v, dp = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`;
    const tGround = data.energy.thermal.source_temperature_k;
    const groundWm2 = SIGMA_SB * Math.pow(tGround, 4);
    const dG = t.thermal.total - r.thermal.total;
    const dS = t.solar.total - r.solar.total;
    els.resultStatement.hidden = false;
    els.resultStation.textContent = `${station.name}'s measured atmosphere`;
    els.resultFrom.textContent = fmtPpm(refPpm);
    els.resultTo.textContent = fmtPpm(vmrPpm);
    els.resultGround.textContent = `${f(dG)} points`;
    els.resultGroundSub.textContent = `${r.thermal.total.toFixed(2)} % → ${t.thermal.total.toFixed(2)} % · ${f(dG / 100 * groundWm2, 1)} W/m² for a ground at ${tGround.toFixed(0)} K`;
    els.resultSun.textContent = `${f(dS)} points`;
    els.resultSunSub.textContent = `${r.solar.total.toFixed(2)} % → ${t.solar.total.toFixed(2)} % · ${f(dS / 100 * SOLAR_CONST_WM2, 1)} W/m² for an overhead sun`;
  }

  function drawTotalsCharts() {
    totalsCfgs().forEach(drawTotalsChart);
    updateResultStatement();
    updateSweepControls();
    fillSolarTable();
  }

  function updateSweepControls() {
    if (!data || !data.energy) return;
    if (els.sampleAll) els.sampleAll.hidden = solarConnected;
    if (els.sampleHint && !sampling) {
      els.sampleHint.textContent = solarConnected
        ? 'Every point sampled and connected. The slider still marks where you are.'
        : `Points sampled so far: ${visitedPpm.size}. Drag the slider to add more, or fill in every point at once.`;
    }
  }

  function fillSolarTable() {
    if (!els.solarTable || !data || !data.energy) return;
    const ppmGrid = data.energy.ppm;
    const s = data.energy.solar;
    const t = data.energy.thermal;
    const tbody = els.solarTable.querySelector('tbody');
    const rows = [];
    const cell = (v) => (v == null ? '—' : v.toFixed(2));
    for (let i = 0; i < ppmGrid.length; i += 8) {
      const k = takeCache.get(Number(ppmGrid[i].toFixed(1)));
      rows.push(`<tr><td>${fmtPpm(ppmGrid[i])}</td>` +
        `<td>${s.with_h2o_pct[i].toFixed(2)}</td><td>${cell(k && k.solar.co2)}</td><td>${cell(k && k.solar.h2o)}</td><td>${s.co2_only_pct[i].toFixed(2)}</td>` +
        `<td>${t.with_h2o_pct[i].toFixed(2)}</td><td>${cell(k && k.thermal.co2)}</td><td>${cell(k && k.thermal.h2o)}</td><td>${t.co2_only_pct[i].toFixed(2)}</td></tr>`);
    }
    tbody.innerHTML = rows.join('');
  }

  function recordSweep() {
    if (progress < 5 || !data || !data.energy) return;
    // quantize to the slider's own resolution so a slow drag doesn't count
    // hundreds of near-identical points
    const q = Math.round(sliderFromPpm(vmrPpm) * 100) / 100;
    const p = Number(ppmFromSlider(q).toFixed(1));
    if (!visitedPpm.has(p)) { visitedPpm.add(p); takeAt(p); }
  }

  // "Sample all": fill in every precomputed point on both charts and join them.
  let sampling = false;
  function sampleAll({ fromRestore = false } = {}) {
    if (!data || !data.energy || sampling) return;
    sampling = true;
    const grid = data.energy.ppm.map((p) => Number(p.toFixed(1)));
    const stationAtStart = stationId;
    let i = 0;
    if (els.sampleAll) els.sampleAll.disabled = true;
    const step = () => {
      if (stationId !== stationAtStart) { sampling = false; return; }
      const t0 = performance.now();
      while (i < grid.length && performance.now() - t0 < 40) {
        visitedPpm.add(grid[i]);
        takeAt(grid[i]);
        i++;
      }
      if (els.sampleHint) els.sampleHint.textContent = `Sampling every point… ${i} of ${grid.length}`;
      if (i < grid.length) { drawTotalsCharts(); setTimeout(step, 0); return; }
      sampling = false;
      solarConnected = true;
      if (els.sampleAll) els.sampleAll.disabled = false;
      beacon('04-solar-curve-built');
      drawTotalsCharts();
      pushState();
    };
    step();
  }

  // Sampling a point runs two full layer walks; do it once the slider has
  // paused, not on every step of a drag.
  let totalsTimer = null;
  function scheduleTotalsDraw() {
    if (totalsTimer) clearTimeout(totalsTimer);
    totalsTimer = setTimeout(() => {
      totalsTimer = null;
      recordSweep();
      drawTotalsCharts();
    }, 150);
  }

  // The altitude chart is the one expensive redraw (per-layer scans across all
  // bins and g-points); trailing-debounce it so slider drags stay fluid.
  let altRefCache = { key: null, down: null, up: null };
  let altDrawTimer = null;
  function scheduleAltDraw() {
    if (progress < 6) return;
    if (altDrawTimer) clearTimeout(altDrawTimer);
    altDrawTimer = setTimeout(() => {
      altDrawTimer = null;
      drawAltChart();
      drawProfileChart();
    }, 120);
  }

  function drawAll() {
    drawGlobe();
    drawEmitChart();
    drawDemoChart();
    if (progress >= 4 && data) {
      drawSpecChart();
      if (refPpm != null) drawDiffChart();
    }
    if (progress >= 5) scheduleTotalsDraw();
    scheduleAltDraw();
  }

  /* ── Band table fallback ── */
  function fillBandTable() {
    if (!els.bandTable || !data) return;
    const cur = tCur();
    const ref = tRef();
    const h2o = showH2O && data ? tH2O() : null;
    const head = els.bandTable.querySelector('thead tr');
    head.innerHTML = '<th scope="col">Region</th><th scope="col">cm⁻¹</th>' +
      `<th scope="col">CO₂ at ${fmtPpm(vmrPpm)} ppm</th>` +
      (ref ? `<th scope="col">CO₂ at ${fmtPpm(refPpm)} ppm (reference)</th>` : '') +
      (h2o ? '<th scope="col">H₂O (measured humidity)</th>' : '');
    const tbody = els.bandTable.querySelector('tbody');
    tbody.innerHTML = BANDS.map((band) => {
      const cells = [
        `<td>${band.label}</td>`,
        `<td>${band.lo}–${band.hi}</td>`,
        `<td>${bandMean(cur, NU_MIN, BIN_W, band.lo, band.hi).toFixed(3)}</td>`,
      ];
      if (ref) cells.push(`<td>${bandMean(ref, NU_MIN, BIN_W, band.lo, band.hi).toFixed(3)}</td>`);
      if (h2o) cells.push(`<td>${bandMean(h2o, NU_MIN, BIN_W, band.lo, band.hi).toFixed(3)}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    }).join('');
  }

  /* ── Section reveal ── */
  function revealUpTo(idx, { scroll = false, fromRestore = false } = {}) {
    // the live chart needs a reference; the energy and altitude sections
    // need a chosen station's data
    if (idx >= 3 && refPpm == null) idx = Math.min(idx, 2);
    if (idx >= 4 && !data) idx = Math.min(idx, 3);
    progress = Math.max(progress, idx);
    SECTION_ORDER.forEach(({ key, idx: i }) => {
      if (sections[key] && i <= progress) sections[key].hidden = false;
    });
    if (els.co2Bar) els.co2Bar.hidden = progress < 4;
    if (els.co2Scope) els.co2Scope.hidden = progress < 4;
    syncContinueButtons();
    if (scroll && !fromRestore) {
      const target = SECTION_ORDER.find((s) => s.idx === idx);
      if (target && sections[target.key]) {
        sections[target.key].scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      }
    }
    if (idx >= 4) {
      drawSpecChart();
      if (refPpm != null) drawDiffChart();
      showWaterCallout();
      setTimeout(updateSliderCallout, 50);
    }
    if (idx >= 5) drawTotalsCharts();
    if (idx >= 6) {
      beacon('05-emission-altitude-revealed');
      drawAltChart();
      drawProfileChart();
    }
    if (!fromRestore) pushState();
  }

  function syncContinueButtons() {
    if (els.toS5) els.toS5.hidden = progress >= 5;
    if (els.toS6) els.toS6.hidden = progress >= 6;
    if (els.toS7) els.toS7.hidden = progress >= 7;
  }

  /* ── The globe: where the five stations are ── */
  const GLOBE_CENTER = { lon: -10, lat: 41 };   // the chain runs Iceland → Mauritania
  function drawGlobe() {
    if (!els.globeCanvas || !els.globeContainer) return;
    const { ctx, W, H } = setupCanvas(els.globeContainer, els.globeCanvas);
    const R = Math.min(W, H) / 2 - 10;
    const cx = W / 2; const cy = H / 2;
    const rad = Math.PI / 180;
    const lat0 = GLOBE_CENTER.lat * rad; const lon0 = GLOBE_CENTER.lon * rad;
    const s0 = Math.sin(lat0); const c0 = Math.cos(lat0);
    // orthographic projection; points behind the limb are pushed onto it so
    // land that straddles the horizon still fills cleanly
    const proj = (lon, lat) => {
      const l = lon * rad; const f = lat * rad;
      const cosc = s0 * Math.sin(f) + c0 * Math.cos(f) * Math.cos(l - lon0);
      let x = Math.cos(f) * Math.sin(l - lon0);
      let y = c0 * Math.sin(f) - s0 * Math.cos(f) * Math.cos(l - lon0);
      if (cosc < 0) { const n = Math.hypot(x, y) || 1; x /= n; y /= n; }
      return { x: cx + R * x, y: cy - R * y, front: cosc >= 0 };
    };
    const ocean = cssVar('--bg-secondary') || '#0f2047';
    const landFill = cssVar('--surface') || '#152c4a';
    const line = cssVar('--border-strong') || 'rgba(212,168,85,0.42)';
    const grat = 'rgba(212,168,85,0.14)';
    // the disc
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = ocean; ctx.fill();
    ctx.clip();
    // land
    if (land) {
      ctx.fillStyle = landFill; ctx.strokeStyle = line; ctx.lineWidth = 0.8;
      land.rings.forEach((ring) => {
        if (!ring.some(([lo, la]) => proj(lo, la).front)) return;
        ctx.beginPath();
        ring.forEach(([lo, la], i) => { const q = proj(lo, la); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    }
    // graticule
    ctx.strokeStyle = grat; ctx.lineWidth = 1;
    for (let la = -75; la <= 75; la += 15) {
      ctx.beginPath(); let on = false;
      for (let lo = -180; lo <= 180; lo += 2) { const q = proj(lo, la); if (!q.front) { on = false; continue; } if (!on) { ctx.moveTo(q.x, q.y); on = true; } else ctx.lineTo(q.x, q.y); }
      ctx.stroke();
    }
    for (let lo = -180; lo < 180; lo += 15) {
      ctx.beginPath(); let on = false;
      for (let la = -90; la <= 90; la += 2) { const q = proj(lo, la); if (!q.front) { on = false; continue; } if (!on) { ctx.moveTo(q.x, q.y); on = true; } else ctx.lineTo(q.x, q.y); }
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = line; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    // the stations
    globeHits = [];
    ctx.font = '12px system-ui, sans-serif';
    manifest.stations.forEach((st) => {
      const q = proj(st.lon, st.lat);
      if (!q.front) return;
      const chosen = st.id === stationId;
      const lit = st.id === hoverStationId;
      globeHits.push({ id: st.id, x: q.x, y: q.y });
      if (chosen) {
        ctx.strokeStyle = GOLD(); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = chosen ? GOLD() : lit ? TEXTC() : BLUE();
      ctx.beginPath(); ctx.arc(q.x, q.y, chosen || lit ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = ocean; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = chosen ? GOLD() : cssVar('--text') || '#e8e2d4';
      ctx.font = `${chosen || lit ? 'bold ' : ''}12px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      const label = chosen ? `✓ ${st.name}` : st.name;
      ctx.fillText(label, q.x + 10, q.y + 4);
    });
    els.globeContainer.setAttribute('role', 'img');
    els.globeContainer.setAttribute('aria-label',
      `A globe centred on the North Atlantic showing the five weather-balloon stations: ${manifest.stations.map((st) => st.name).join(', ')}.` +
      (station ? ` ${station.name} is selected.` : ''));
  }

  async function loadLand() {
    try {
      land = await fetch(`${dataBase}/../land-110m.json`).then((r) => r.json());
    } catch (e) { land = null; }
    drawGlobe();
  }

  /* ── Location choice (blocking) ── */
  function renderProfileCards() {
    const gridEl = els.profileGrid;
    if (!gridEl) return;
    gridEl.innerHTML = '';
    shuffle(manifest.stations.slice()).forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'station-card' + (s.id === stationId ? ' active' : '');
      btn.dataset.stationId = s.id;
      btn.setAttribute('aria-pressed', s.id === stationId ? 'true' : 'false');
      const latDir = s.lat >= 0 ? 'N' : 'S';
      btn.innerHTML =
        '<span class="sc-card-text">' +
        `<span class="sc-since">${s.country}</span>` +
        `<span class="sc-name">${s.name}</span>` +
        `<span class="sc-caveat">${Math.abs(s.lat).toFixed(1)}°${latDir} · ${s.elev_m} m elevation · ` +
        `${s.n_soundings.toLocaleString()} balloon soundings, ${String(s.years).replace('-', '–')}</span>` +
        '</span>';
      btn.addEventListener('click', () => chooseProfile(s.id));
      btn.addEventListener('mouseenter', () => { hoverStationId = s.id; drawGlobe(); });
      btn.addEventListener('mouseleave', () => { hoverStationId = null; drawGlobe(); });
      btn.addEventListener('focus', () => { hoverStationId = s.id; drawGlobe(); });
      btn.addEventListener('blur', () => { hoverStationId = null; drawGlobe(); });
      gridEl.appendChild(btn);
    });
  }

  function updateProfileCards() {
    drawGlobe();
    if (!els.profileGrid) return;
    els.profileGrid.querySelectorAll('.station-card').forEach((btn) => {
      const active = btn.dataset.stationId === stationId;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function decodeGrid(buf, meta) {
    return dequantize(new Uint16Array(buf), meta.log10_lo, meta.log10_hi);
  }

  async function loadStandard() {
    const std = manifest.standard;
    if (!std) {
      if (els.demoLoading) els.demoLoading.textContent = 'The standard-atmosphere data is not in this build.';
      return;
    }
    const hasH2O = !!std.files['h2o_od.bin'];
    const [co2Buf, h2oBuf, profile] = await Promise.all([
      fetch(`${dataBase}/${std.id}/co2_k.bin`).then((r) => r.arrayBuffer()),
      hasH2O ? fetch(`${dataBase}/${std.id}/h2o_od.bin`).then((r) => r.arrayBuffer()) : Promise.resolve(null),
      fetch(`${dataBase}/${std.id}/profile.json`).then((r) => r.json()),
    ]);
    const co2 = decodeGrid(co2Buf, std.files['co2_k.bin']);
    const h2o = h2oBuf ? decodeGrid(h2oBuf, std.files['h2o_od.bin']) : null;
    const slab = N_BINS * N_G;   // layer 0 is the first [bin][g] block
    stdData = {
      co2Sum: columnSum(co2, std.n_layers, N_BINS, N_G),
      h2oSum: h2o ? columnSum(h2o, std.n_layers, N_BINS, N_G) : null,
      co2Slab: co2.subarray(0, slab),
      h2oSlab: h2o ? h2o.subarray(0, slab) : null,
      slabThicknessM: profile.layers.z_top_m[0] - profile.layers.z_bot_m[0],
      profile,
      nLayers: std.n_layers,
    };
    if (els.demoToggleH2O) els.demoToggleH2O.hidden = !h2o;
    if (els.demoToggleH2OTrace) els.demoToggleH2OTrace.hidden = !h2o;
    if (els.demoLoading) els.demoLoading.hidden = true;
    demoCache = null;
  }

  async function chooseProfile(id, { fromRestore = false } = {}) {
    const entry = manifest.stations.find((s) => s.id === id);
    if (!entry) return;
    stationId = id;
    station = entry;
    updateProfileCards();
    if (els.profileChosen) {
      els.profileChosen.hidden = false;
      els.profileChosenName.textContent = `${entry.name}, ${entry.country}`;
    }
    if (els.profilePrompt) els.profilePrompt.hidden = true;
    if (els.specLoading) els.specLoading.hidden = false;
    beacon('01-profile-selected');
    try {
      const [co2Buf, h2oBuf, profile, energy] = await Promise.all([
        fetch(`${dataBase}/${id}/co2_k.bin`).then((r) => r.arrayBuffer()),
        fetch(`${dataBase}/${id}/h2o_od.bin`).then((r) => r.arrayBuffer()),
        fetch(`${dataBase}/${id}/profile.json`).then((r) => r.json()),
        fetch(`${dataBase}/${id}/energy_curves.json`).then((r) => r.json()),
      ]);
      const co2 = decodeGrid(co2Buf, entry.files['co2_k.bin']);
      const h2o = decodeGrid(h2oBuf, entry.files['h2o_od.bin']);
      const nLayers = entry.n_layers;
      const zMids = profile.layers.z_bot_m.map((zb, i) => (zb + profile.layers.z_top_m[i]) / 2);
      data = {
        co2,
        h2o,
        co2Sum: columnSum(co2, nLayers, N_BINS, N_G),
        h2oSum: columnSum(h2o, nLayers, N_BINS, N_G),
        profile,
        nLayers,
        zMids,
        zLevels: profile.levels.z_m,
        tLevels: profile.levels.t_k,
        zSurface: profile.station.z_surface_m,
        zDataTop: profile.station.z_data_top_m,
        energy,
      };
      groundShape = solarShapeRelative(binCenters, profile.levels.t_k[0]);
    } finally {
      if (els.specLoading) els.specLoading.hidden = true;
    }
    // a new station invalidates the energy sweep and the altitude cache
    visitedPpm.clear();
    solarConnected = false;
    takeCache.clear();
    altRefCache = { key: null, down: null, up: null };
    applyStationToLiveChart();
    syncContinueButtons();
    if (!fromRestore) {
      // the live chart opens below, through this station; no scroll — the
      // reader is still looking at the globe and the cards (user, 2026-09-04)
      revealUpTo(4, { scroll: false });
      pushState();
    }
    drawAll();
  }

  // Labels that name the chosen station.
  function applyStationToLiveChart() {
    const hasStation = !!data;
    if (els.specChartTitle) {
      const what = specMode === 'abs' ? 'absorbance' : 'transmittance';
      els.specChartTitle.textContent = hasStation ? `Column ${what} — ${station.name}` : `Column ${what}`;
    }
    if (els.co2BarScope) els.co2BarScope.textContent = hasStation ? `through ${station.name}` : '';
  }

  /* ── Legend callout: points at the water-vapour switch until used once ── */
  function positionWaterCallout() {
    const c = els.waterCallout;
    const btn = els.toggleH2O;
    if (!c || !els.waterCalloutRow || els.waterCalloutRow.hidden || !btn || !els.specLegend) return;
    const wrap = els.specLegend;
    const wrapRect = wrap.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const center = btnRect.left + btnRect.width / 2 - wrapRect.left;
    const cW = c.offsetWidth;
    const left = Math.max(0, Math.min(wrapRect.width - cW, center - cW / 2));
    // the bubble flows under the legend (it covers nothing); only its horizontal
    // offset and the arrow follow the button
    c.style.marginLeft = `${left}px`;
    c.style.setProperty('--arrow-x', `${Math.max(14, Math.min(cW - 14, center - left))}px`);
  }

  // "Try moving the slider": shown while the live chart is near the top of the
  // screen and the reader has not yet moved the CO₂ amount off the reference
  function positionSliderCallout() {
    const c = els.sliderCallout;
    if (!c || c.hidden || !els.ppmSlider || !els.co2Bar) return;
    // viewport coordinates: just under the sticky bar, arrow up at the slider
    const barRect = els.co2Bar.getBoundingClientRect();
    const sRect = els.ppmSlider.getBoundingClientRect();
    const center = sRect.left + sRect.width / 2;
    const cW = c.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - cW - 8, center - cW / 2));
    c.style.setProperty('--callout-top', `${barRect.bottom + 10}px`);
    c.style.setProperty('--callout-left', `${left}px`);
    c.style.setProperty('--arrow-x', `${Math.max(14, Math.min(cW - 14, center - left))}px`);
  }
  function updateSliderCallout() {
    const c = els.sliderCallout;
    if (!c) return;
    let show = false;
    if (!sliderMoved && data && progress >= 4 && els.specChartContainer && !els.co2Bar.hidden) {
      const r = els.specChartContainer.getBoundingClientRect();
      show = r.top < window.innerHeight * 0.6 && r.bottom > 160;
    }
    if (c.hidden === !show) { if (show) positionSliderCallout(); return; }
    c.hidden = !show;
    if (show) requestAnimationFrame(positionSliderCallout);
  }
  function markSliderMoved() {
    if (sliderMoved) return;
    sliderMoved = true;
    if (els.sliderCallout) els.sliderCallout.hidden = true;
  }

  function showWaterCallout() {
    if (waterToggledOnce || !data || progress < 4 || !els.waterCalloutRow) return;
    els.waterCalloutRow.hidden = false;
    if (els.toggleH2O) els.toggleH2O.classList.add('pulse');
    requestAnimationFrame(positionWaterCallout);
  }

  function hideWaterCallout() {
    if (els.waterCalloutRow) els.waterCalloutRow.hidden = true;
    if (els.toggleH2O) els.toggleH2O.classList.remove('pulse');
  }

  /* ── Slider / reference ── */
  let rafPending = false;
  function requestRedraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawAll();
      pushState();
    });
  }

  function setPpm(ppm, { fromRestore = false } = {}) {
    vmrPpm = Math.min(PPM_MAX, Math.max(PPM_MIN, ppm));
    const pos = String(Math.round(sliderFromPpm(vmrPpm) * 1000));
    if (els.ppmSlider) { els.ppmSlider.value = pos; els.ppmSlider.setAttribute('aria-valuetext', `${fmtPpm(vmrPpm)} ppm`); }
    // don't overwrite a value the reader is in the middle of typing
    if (els.ppmInput && document.activeElement !== els.ppmInput) els.ppmInput.value = fmtPpm(vmrPpm);
    if (!fromRestore) requestRedraw();
  }

  /* ── Reference choice (blocking) ── */
  function syncRefCards() {
    let matched = false;
    refCards.forEach((btn) => {
      const active = refPpm != null && Number(btn.dataset.refPpm) === refPpm;
      matched = matched || active;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (els.refCustomCard) {
      const custom = refPpm != null && !matched;
      els.refCustomCard.classList.toggle('active', custom);
      els.refCustomCard.setAttribute('aria-pressed', custom ? 'true' : 'false');
      if (custom && els.refCustomInput && !els.refCustomInput.value) els.refCustomInput.value = fmtPpm(refPpm);
    }
  }

  function chooseReference(ppm, { fromRestore = false } = {}) {
    if (!Number.isFinite(ppm)) return;
    refPpm = Math.min(PPM_MAX, Math.max(PPM_MIN, ppm));
    syncRefCards();
    if (els.refChosen) {
      els.refChosen.hidden = false;
      els.refChosenValue.textContent = `${fmtPpm(refPpm)} ppm`;
    }
    if (els.refPrompt) els.refPrompt.hidden = true;
    if (els.refPillValue) els.refPillValue.textContent = `${fmtPpm(refPpm)} ppm`;
    if (els.toggleRef) {
      els.toggleRef.hidden = false;
      setToggleVisual(els.toggleRef, showRef, GOLD());
    }
    if (els.diffPanel) els.diffPanel.hidden = false;
    altRefCache = { key: null, down: null, up: null };
    beacon('02-reference-marked');
    syncContinueButtons();
    if (!fromRestore) {
      // the first time, the slider starts on the reference so the two curves
      // begin together; a later change of reference keeps the comparison amount
      if (!sliderMoved) setPpm(refPpm, { fromRestore: true });
      // reveal the next step in place — choices never scroll the page (user, 2026-09-04)
      if (progress < 3) revealUpTo(3, { scroll: false });
      drawAll();
      pushState();
    }
  }

  function chooseCustomReference() {
    if (!els.refCustomInput) return;
    const v = parseFloat(els.refCustomInput.value);
    if (!Number.isFinite(v)) { els.refCustomInput.focus(); return; }
    const clamped = Math.min(PPM_MAX, Math.max(PPM_MIN, v));
    els.refCustomInput.value = fmtPpm(clamped);
    chooseReference(clamped);
  }

  /* ── URL state ── */
  function pushState() {
    if (restoring) return;
    const params = new URLSearchParams();
    params.set('v', '2');
    if (stationId) params.set('s', stationId);
    params.set('c', fmtPpm(vmrPpm));
    if (refPpm != null) params.set('r', fmtPpm(refPpm));
    if (showH2O) params.set('w', '1');
    if (solarConnected) params.set('sc', '1');
    if (specMode === 'trans') params.set('m', 't');
    params.set('p', String(progress));
    const hash = '#' + params.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readState() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    if (hash && params.get('v') !== '2') return {};
    return {
      s: params.get('s'),
      c: parseFloat(params.get('c') || ''),
      r: parseFloat(params.get('r') || ''),
      w: params.get('w') === '1',
      sc: params.get('sc') === '1',
      m: params.get('m'),
      p: parseInt(params.get('p') || '', 10),
    };
  }

  /* ── Beacons ── */
  function beacon(name) {
    if (beaconsSent.has(name)) return;
    sendFeatureBeacon(`${funnelPrefix}/${name}`);
    beaconsSent.add(name);
  }

  /* ── Tooltips ── */
  // mouse and touch alike: a finger on the chart shows the readout
  function onPointer(canvas, handler) {
    canvas.addEventListener('mousemove', handler);
    const touch = (e) => { if (e.touches && e.touches[0]) handler(e.touches[0]); };
    canvas.addEventListener('touchstart', touch, { passive: true });
    canvas.addEventListener('touchmove', touch, { passive: true });
  }
  function spectralTooltip(canvas, tooltip, describe) {
    if (!canvas || !tooltip) return;
    onPointer(canvas, (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pad = 52;
      const cW = rect.width - pad - 16;
      if (x < pad || x > pad + cW) { tooltip.hidden = true; return; }
      const nu = zoom.lo + ((x - pad) / cW) * (zoom.hi - zoom.lo);
      const b = Math.min(N_BINS - 1, Math.max(0, Math.round((nu - NU_MIN) / BIN_W - 0.5)));
      const text = describe(b, nu);
      if (!text) { tooltip.hidden = true; return; }
      tooltip.textContent = text;
      tooltip.hidden = false;
      const ttW = tooltip.offsetWidth || 160;
      let left = x + 14;
      if (left + ttW > rect.width - 8) left = x - ttW - 14;
      tooltip.style.left = Math.max(4, left) + 'px';
      tooltip.style.top = '12px';
    });
    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  /* ── Reset ── */
  function reset() {
    stationId = null;
    station = null;
    data = null;
    refPpm = null;
    showCO2 = true;
    showRef = true;
    showSun = false;
    showGround = false;
    showH2O = false;
    showCombined = false;
    demoShow.co2Trace = true; demoShow.co2 = false; demoShow.h2oTrace = false; demoShow.h2o = false;
    emitShow.sun = true; emitShow.ground = true;
    emitMode = 'peak';
    [[els.emitModePeak, true], [els.emitModeAvg, false], [els.emitModeNoon, false]].forEach(([btn, on]) => {
      if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    });
    setToggleVisual(els.emitToggleSun, true, SUN());
    setToggleVisual(els.emitToggleGround, true, EMBER());
    solarShow.co2 = true; solarShow.both = true; solarShow.h2o = true; solarShow.dry = false;
    thermalShow.co2 = true; thermalShow.both = true; thermalShow.h2o = true; thermalShow.dry = false;
    altUpShow.ref = true; altUpShow.cur = true; altDownShow.ref = true; altDownShow.cur = true;
    profShow.sun = true; profShow.ground = true; profShow.co2 = true; profShow.h2o = true;
    zoom = ZOOMS[0];
    specMode = 'abs';
    syncModeButtons();
    energyDir = 'down'; heightDir = 'up';
    applyDirs();
    progress = 2;
    visitedPpm.clear();
    solarConnected = false;
    takeCache.clear();
    waterToggledOnce = false;
    sliderMoved = false;
    if (els.sliderCallout) els.sliderCallout.hidden = true;
    groundShape = null;
    altRefCache = { key: null, down: null, up: null };
    vmrPpm = ppmFromSlider(Math.random());
    setPpm(vmrPpm, { fromRestore: true });
    SECTION_ORDER.forEach(({ key, idx }) => { if (sections[key]) sections[key].hidden = idx > 2; });
    if (els.co2Bar) els.co2Bar.hidden = true;
    if (els.co2Scope) els.co2Scope.hidden = true;
    syncContinueButtons();
    if (els.profileChosen) els.profileChosen.hidden = true;
    if (els.profilePrompt) els.profilePrompt.hidden = false;
    if (els.refChosen) els.refChosen.hidden = true;
    if (els.refPrompt) els.refPrompt.hidden = false;
    if (els.refCustomInput) els.refCustomInput.value = '';
    syncRefCards();
    if (els.diffPanel) els.diffPanel.hidden = true;
    if (els.resultStatement) els.resultStatement.hidden = true;
    if (els.sampleAll) els.sampleAll.hidden = false;
    hideWaterCallout();
    applyStationToLiveChart();
    setToggleVisual(els.demoToggleCO2Trace, true, NAIVE());
    setToggleVisual(els.demoToggleCO2, false, BLUE());
    setToggleVisual(els.demoToggleH2OTrace, false, NAIVE_H2O());
    setToggleVisual(els.demoToggleH2O, false, GREEN());
    setToggleVisual(els.toggleCO2, true, BLUE());
    setToggleVisual(els.toggleRef, true, GOLD());
    setToggleVisual(els.toggleSun, false, SUN());
    setToggleVisual(els.solarToggleCO2, true, BLUE());
    setToggleVisual(els.solarToggleBoth, true, TEXTC());
    setToggleVisual(els.solarToggleH2O, true, GREEN());
    setToggleVisual(els.solarToggleDry, false, 'rgba(80,144,248,0.6)');
    setToggleVisual(els.thermalToggleCO2, true, BLUE());
    setToggleVisual(els.thermalToggleBoth, true, TEXTC());
    setToggleVisual(els.thermalToggleH2O, true, GREEN());
    setToggleVisual(els.thermalToggleDry, false, 'rgba(80,144,248,0.6)');
    setToggleVisual(els.altUpToggleRef, true, GOLD());
    setToggleVisual(els.altUpToggleCur, true, BLUE());
    setToggleVisual(els.altDownToggleRef, true, GOLD());
    setToggleVisual(els.altDownToggleCur, true, BLUE());
    setToggleVisual(els.profToggleSun, true, SUN());
    setToggleVisual(els.profToggleGround, true, EMBER());
    setToggleVisual(els.profToggleCO2, true, BLUE());
    setToggleVisual(els.profToggleH2O, true, GREEN());
    setToggleVisual(els.toggleGround, false, EMBER());
    setToggleVisual(els.toggleH2O, false, GREEN());
    setToggleVisual(els.toggleCombined, false, TEXTC());
    syncZoomButtons();
    renderProfileCards();
    drawDemoChart();
    pushState();
    window.scrollTo({ top: 0, behavior: scrollBehavior });
  }

  /* ── Wiring ── */
  function setToggleVisual(btn, on, color) {
    if (!btn) return;
    btn.classList.toggle('series-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.borderColor = on ? color : '';
    btn.style.color = on ? color : '';
  }

  // One zoom state, mirrored on every spectral chart's toolbar.
  function syncZoomButtons() {
    zoomButtons.forEach((btn) => {
      const active = btn.getAttribute('data-zoom') === zoom.key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function initialize() {
    renderProfileCards();
    setPpm(vmrPpm, { fromRestore: true });
    applyStationToLiveChart();

    if (els.ppmSlider) {
      els.ppmSlider.addEventListener('input', () => {
        markSliderMoved();
        setPpm(ppmFromSlider(Number(els.ppmSlider.value) / 1000));
      });
    }
    window.addEventListener('scroll', updateSliderCallout, { passive: true });
    window.addEventListener('resize', () => { updateSliderCallout(); positionSliderCallout(); });
    if (els.ppmInput) {
      const applyTyped = () => {
        const v = parseFloat(els.ppmInput.value);
        if (Number.isFinite(v)) { markSliderMoved(); setPpm(v); }
        els.ppmInput.value = fmtPpm(vmrPpm);
      };
      els.ppmInput.addEventListener('change', applyTyped);
      els.ppmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(); els.ppmInput.blur(); } });
    }
    refCards.forEach((btn) => {
      btn.addEventListener('click', () => chooseReference(Number(btn.dataset.refPpm)));
    });
    if (els.refCustomBtn) els.refCustomBtn.addEventListener('click', () => chooseCustomReference());
    if (els.refCustomInput) {
      els.refCustomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); chooseCustomReference(); }
      });
    }
    const scrollToReference = () => {
      const sec = document.getElementById('reference');
      if (sec) sec.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    };
    if (els.tryAnotherRef) els.tryAnotherRef.addEventListener('click', scrollToReference);
    if (els.sampleAll) els.sampleAll.addEventListener('click', () => sampleAll());
    // the hero's skip-ahead link: the URL hash carries lab state, so reveal by hand
    const skipIntro = (e) => { if (e) e.preventDefault(); revealUpTo(2, { scroll: true }); };
    if (els.skipAhead) els.skipAhead.addEventListener('click', skipIntro);
    if (els.skipIntro) els.skipIntro.addEventListener('click', skipIntro);
    if (els.toS5) els.toS5.addEventListener('click', () => revealUpTo(5, { scroll: true }));
    if (els.toS6) els.toS6.addEventListener('click', () => revealUpTo(6, { scroll: true }));
    if (els.toS7) els.toS7.addEventListener('click', () => revealUpTo(7, { scroll: true }));
    dirButtons.forEach((btn) => {
      btn.addEventListener('click', () => { energyDir = btn.getAttribute('data-dir') === 'up' ? 'up' : 'down'; applyDirs(); drawAll(); });
    });
    hdirButtons.forEach((btn) => {
      btn.addEventListener('click', () => { heightDir = btn.getAttribute('data-hdir') === 'down' ? 'down' : 'up'; applyDirs(); drawAltChart(); });
    });
    applyDirs();
    zoomButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        zoom = ZOOMS.find((z) => z.key === btn.getAttribute('data-zoom')) || ZOOMS[0];
        syncZoomButtons();
        drawAll();
      });
    });
    syncZoomButtons();

    const wireSeriesToggle = (btn, obj, key, colorFn, redraw) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        obj[key] = !obj[key];
        setToggleVisual(btn, obj[key], colorFn());
        redraw();
      });
      setToggleVisual(btn, obj[key], colorFn());
    };
    // one absorbance / transmittance mode for every spectral chart, switchable from any of them
    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        specMode = btn.getAttribute('data-mode') === 'trans' ? 'trans' : 'abs';
        syncModeButtons();
        applyStationToLiveChart();
        drawAll();
        pushState();
      });
    });
    syncModeButtons();
    const emitModeBtns = { peak: els.emitModePeak, avg: els.emitModeAvg, noon: els.emitModeNoon };
    const setEmitMode = (mode) => {
      emitMode = mode;
      Object.entries(emitModeBtns).forEach(([m, btn]) => {
        if (!btn) return;
        btn.classList.toggle('active', m === mode);
        btn.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
      });
      drawEmitChart();
    };
    Object.entries(emitModeBtns).forEach(([m, btn]) => { if (btn) btn.addEventListener('click', () => setEmitMode(m)); });
    wireSeriesToggle(els.emitToggleSun, emitShow, 'sun', SUN, () => drawEmitChart());
    wireSeriesToggle(els.emitToggleGround, emitShow, 'ground', EMBER, () => drawEmitChart());
    drawEmitChart();
    wireSeriesToggle(els.demoToggleCO2Trace, demoShow, 'co2Trace', NAIVE, () => drawDemoChart());
    wireSeriesToggle(els.demoToggleCO2, demoShow, 'co2', BLUE, () => drawDemoChart());
    wireSeriesToggle(els.demoToggleH2OTrace, demoShow, 'h2oTrace', NAIVE_H2O, () => drawDemoChart());
    wireSeriesToggle(els.demoToggleH2O, demoShow, 'h2o', GREEN, () => drawDemoChart());
    if (els.toggleCO2) {
      els.toggleCO2.addEventListener('click', () => {
        showCO2 = !showCO2;
        setToggleVisual(els.toggleCO2, showCO2, BLUE());
        drawSpecChart();
      });
      setToggleVisual(els.toggleCO2, true, BLUE());
    }
    if (els.toggleRef) {
      els.toggleRef.addEventListener('click', () => {
        showRef = !showRef;
        setToggleVisual(els.toggleRef, showRef, GOLD());
        drawSpecChart();
      });
    }
    if (els.toggleSun) {
      els.toggleSun.addEventListener('click', () => {
        showSun = !showSun;
        setToggleVisual(els.toggleSun, showSun, SUN());
        drawSpecChart();
      });
      setToggleVisual(els.toggleSun, false, SUN());
    }
    wireSeriesToggle(els.solarToggleCO2, solarShow, 'co2', BLUE, () => drawTotalsCharts());
    wireSeriesToggle(els.solarToggleBoth, solarShow, 'both', TEXTC, () => drawTotalsCharts());
    wireSeriesToggle(els.solarToggleH2O, solarShow, 'h2o', GREEN, () => drawTotalsCharts());
    wireSeriesToggle(els.solarToggleDry, solarShow, 'dry', () => 'rgba(80,144,248,0.6)', () => drawTotalsCharts());
    wireSeriesToggle(els.thermalToggleCO2, thermalShow, 'co2', BLUE, () => drawTotalsCharts());
    wireSeriesToggle(els.thermalToggleBoth, thermalShow, 'both', TEXTC, () => drawTotalsCharts());
    wireSeriesToggle(els.thermalToggleH2O, thermalShow, 'h2o', GREEN, () => drawTotalsCharts());
    wireSeriesToggle(els.thermalToggleDry, thermalShow, 'dry', () => 'rgba(80,144,248,0.6)', () => drawTotalsCharts());
    wireSeriesToggle(els.altUpToggleRef, altUpShow, 'ref', GOLD, () => drawAltChart());
    wireSeriesToggle(els.altUpToggleCur, altUpShow, 'cur', BLUE, () => drawAltChart());
    wireSeriesToggle(els.altDownToggleRef, altDownShow, 'ref', GOLD, () => drawAltChart());
    wireSeriesToggle(els.altDownToggleCur, altDownShow, 'cur', BLUE, () => drawAltChart());
    wireSeriesToggle(els.profToggleSun, profShow, 'sun', SUN, () => drawProfileChart());
    wireSeriesToggle(els.profToggleGround, profShow, 'ground', EMBER, () => drawProfileChart());
    wireSeriesToggle(els.profToggleCO2, profShow, 'co2', BLUE, () => drawProfileChart());
    wireSeriesToggle(els.profToggleH2O, profShow, 'h2o', GREEN, () => drawProfileChart());
    if (els.toggleGround) {
      els.toggleGround.addEventListener('click', () => {
        showGround = !showGround;
        setToggleVisual(els.toggleGround, showGround, EMBER());
        drawSpecChart();
      });
      setToggleVisual(els.toggleGround, false, EMBER());
    }
    if (els.toggleH2O) {
      els.toggleH2O.addEventListener('click', () => {
        showH2O = !showH2O;
        waterToggledOnce = true;
        hideWaterCallout();
        syncContinueButtons();
        setToggleVisual(els.toggleH2O, showH2O, GREEN());
        if (showH2O) beacon('03-h2o-overlaid');
        drawSpecChart();
        pushState();
      });
      setToggleVisual(els.toggleH2O, false, GREEN());
    }
    if (els.toggleCombined) {
      els.toggleCombined.addEventListener('click', () => {
        showCombined = !showCombined;
        setToggleVisual(els.toggleCombined, showCombined, TEXTC());
        drawSpecChart();
      });
      setToggleVisual(els.toggleCombined, false, TEXTC());
    }
    if (els.resetLab) els.resetLab.addEventListener('click', () => reset());
    // the Oprah caption alternates wrong ↔ right: nobody gets the last word
    if (els.oprahTop && els.oprahBottom) {
      const words = ['wrong', 'right'];
      let k = 0;
      const setWord = (w) => {
        els.oprahTop.textContent = `You can be ${w}! And you can be ${w}!`;
        els.oprahBottom.textContent = `Everybody can be ${w} at the same time!`;
      };
      if (prefersReducedMotion) {
        els.oprahTop.textContent = 'You can be wrong! And you can be right!';
        els.oprahBottom.textContent = 'Everybody can be both at the same time!';
      } else {
        setInterval(() => { k = (k + 1) % words.length; setWord(words[k]); }, 2000);
      }
    }
    if (els.globeCanvas) {
      const nearest = (e) => {
        const rect = els.globeCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left; const y = e.clientY - rect.top;
        let best = null; let bd = 16;
        globeHits.forEach((h) => { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } });
        return best;
      };
      els.globeCanvas.addEventListener('mousemove', (e) => {
        const h = nearest(e);
        const id = h ? h.id : null;
        els.globeCanvas.style.cursor = h ? 'pointer' : 'default';
        if (id !== hoverStationId) { hoverStationId = id; drawGlobe(); }
      });
      els.globeCanvas.addEventListener('mouseleave', () => { hoverStationId = null; drawGlobe(); });
      els.globeCanvas.addEventListener('click', (e) => { const h = nearest(e); if (h) chooseProfile(h.id); });
    }
    loadLand();
    if (els.tryAnother) {
      els.tryAnother.addEventListener('click', () => {
        const sec = document.getElementById('water');
        if (sec) sec.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      });
    }

    window.addEventListener('klymot:theme-toggled', () => { drawAll(); });
    const ro = new ResizeObserver(() => { drawAll(); positionWaterCallout(); });
    [els.globeContainer, els.emitChartContainer, els.demoChartContainer, els.specChartContainer, els.diffChartContainer,
      els.solarChartContainer, els.thermalChartContainer,
      els.altUpChartContainer, els.altDownChartContainer, els.profChartContainer]
      .forEach((c) => { if (c) ro.observe(c); });

    if (els.emitChart && els.emitTooltip) {
      onPointer(els.emitChart, (e) => {
        if (!emitLayout) { els.emitTooltip.hidden = true; return; }
        const rect = els.emitChart.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const { lLo, lHi, c, pad, cW } = emitLayout;
        if (x < pad.left || x > pad.left + cW) { els.emitTooltip.hidden = true; return; }
        const nu = Math.exp(lLo + ((x - pad.left) / cW) * (lHi - lLo));
        let i = 0; while (i < c.nu.length - 1 && c.nu[i] < nu) i++;
        const um = 10000 / nu;
        const parts = [`${nu.toFixed(0)} cm⁻¹ (${um >= 1 ? um.toFixed(1) + ' μm' : (1000 * um).toFixed(0) + ' nm'})`];
        const fmtE = (v) => (v >= 0.01 ? v.toFixed(3) : v >= 1e-6 ? v.toFixed(6) : v.toPrecision(2)) + ' W/m² per cm⁻¹';
        const { sunY, groundY, energy } = emitLayout;
        if (emitShow.sun) parts.push(energy ? `sun: ${fmtE(sunY[i])}` : `sun: ${sunY[i].toFixed(3)} of its peak`);
        if (emitShow.ground) parts.push(energy ? `ground: ${fmtE(groundY[i])}` : `ground: ${groundY[i].toFixed(3)} of its peak`);
        els.emitTooltip.textContent = parts.join('  ·  ');
        els.emitTooltip.hidden = false;
        const ttW = els.emitTooltip.offsetWidth || 160;
        let left = x + 14; if (left + ttW > rect.width - 8) left = x - ttW - 14;
        els.emitTooltip.style.left = Math.max(4, left) + 'px'; els.emitTooltip.style.top = '12px';
      });
      els.emitChart.addEventListener('mouseleave', () => { els.emitTooltip.hidden = true; });
    }
    spectralTooltip(els.demoChart, els.demoTooltip, (b, nu) => {
      if (!demoLayout) return null;
      const um = 10000 / nu;
      const c = demoLayout.c;
      const f = (A) => `${A.toFixed(A >= 10 ? 0 : 2)} (${A > 6 ? '<0.0001' : (100 * Math.pow(10, -A)).toFixed(A > 3 ? 3 : 1)} % through)`;
      const parts = [`${nu.toFixed(0)} cm⁻¹ (${um.toFixed(um >= 10 ? 0 : 1)} μm)`];
      if (demoShow.co2Trace) parts.push(`CO₂ trace: ${f(c.co2Trace[b])}`);
      if (demoShow.co2) parts.push(`CO₂ ${DEMO_CO2_PPM} ppm: ${f(c.co2[b])}`);
      if (demoShow.h2oTrace && c.h2oTrace) parts.push(`H₂O trace: ${f(c.h2oTrace[b])}`);
      if (demoShow.h2o && c.h2o) parts.push(`H₂O typical: ${f(c.h2o[b])}`);
      return parts.join('  ·  ');
    });
    spectralTooltip(els.specChart, els.specTooltip, (b, nu) => {
      if (!specLayout) return null;
      const um = 10000 / nu;
      const v = (t) => (specMode === 'abs' ? `A ${Math.min(ABS_MAX, -Math.log10(Math.max(t, 1e-300))).toFixed(2)} (${(100 * t).toFixed(t < 0.001 ? 3 : 1)} % through)` : t.toFixed(3));
      const parts = [`${nu.toFixed(0)} cm⁻¹ (${um.toFixed(um >= 10 ? 0 : 1)} μm)`,
        `CO₂ ${fmtPpm(vmrPpm)} ppm: ${v(specLayout.cur[b])}`];
      if (specLayout.ref) parts.push(`reference: ${v(specLayout.ref[b])}`);
      if (specLayout.h2o) parts.push(`H₂O: ${v(specLayout.h2o[b])}`);
      return parts.join('  ·  ');
    });
    spectralTooltip(els.diffChart, els.diffTooltip, (b, nu) => {
      if (!diffLayout) return null;
      const d = diffLayout.diff[b];
      return `${nu.toFixed(0)} cm⁻¹  difference ${(d >= 0 ? '+' : '') + d.toFixed(3)}`;
    });
    // ppm-axis tooltips (totals + relative charts): x is log-ppm, not wavenumber;
    // describe() gets the nearest computed grid point once everything is sampled
    function ppmAxisTooltip(canvas, tooltip, describe) {
      if (!canvas || !tooltip) return;
      onPointer(canvas, (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pad = 52;
        const cW = rect.width - pad - 18;
        if (x < pad || x > pad + cW) { tooltip.hidden = true; return; }
        let ppm = PPM_MIN * Math.pow(PPM_MAX / PPM_MIN, (x - pad) / cW);
        if (solarConnected && data && data.energy) {
          const g = data.energy.ppm;
          ppm = g.reduce((best, p) => (Math.abs(Math.log(p / ppm)) < Math.abs(Math.log(best / ppm)) ? p : best), g[0]);
        }
        const text = describe(ppm);
        if (!text) { tooltip.hidden = true; return; }
        tooltip.textContent = text;
        tooltip.hidden = false;
        const ttW = tooltip.offsetWidth || 160;
        let left = x + 14;
        if (left + ttW > rect.width - 8) left = x - ttW - 14;
        tooltip.style.left = Math.max(4, left) + 'px';
        tooltip.style.top = '12px';
      });
      canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    }
    const totalsDescribe = (blockOf) => (ppm) => {
      if (!data || !data.energy) return null;
      const s = blockOf();
      const g = data.energy.ppm;
      const name = s === data.energy.solar ? 'solar' : 'thermal';
      const t = takeCache.get(Number(ppm.toFixed(1)));
      return `${fmtPpm(ppm)} ppm  ·  total ${interpLogX(g, s.with_h2o_pct, ppm).toFixed(2)} %` +
        (t ? `  ·  CO₂'s take ${t[name].co2.toFixed(2)} %  ·  water's take ${t[name].h2o.toFixed(2)} %` : '  ·  (not sampled here yet)') +
        `  ·  CO₂ in dry air ${interpLogX(g, s.co2_only_pct, ppm).toFixed(2)} %`;
    };
    ppmAxisTooltip(els.solarChart, els.solarTooltip, totalsDescribe(() => data.energy.solar));
    ppmAxisTooltip(els.thermalChart, els.thermalTooltip, totalsDescribe(() => data.energy.thermal));
    // per-layer change chart: the y axis is altitude, so find the layer under the finger
    if (els.profChart && els.profTooltip) {
      onPointer(els.profChart, (e) => {
        if (!profLayout) { els.profTooltip.hidden = true; return; }
        const rect = els.profChart.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const { zLo, zTopKm, zb, zt, series } = profLayout;
        const pad = { top: 26, bottom: 34 };
        const cH = rect.height - pad.top - pad.bottom;
        const zKm = zLo + (1 - (y - pad.top) / cH) * (zTopKm - zLo);
        const l = zb.findIndex((z, i) => zKm >= z / 1000 && zKm < zt[i] / 1000);
        if (l < 0) { els.profTooltip.hidden = true; return; }
        const f = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)}`;
        const parts = [`${(zb[l] / 1000).toFixed(1)}–${(zt[l] / 1000).toFixed(1)} km`];
        const byKey = Object.fromEntries(series.map((sr) => [sr.key, sr]));
        if (profShow.sun) parts.push(`sunlight ↓ CO₂ ${f(byKey.sunCo2.vals[l])}${profShow.h2o ? `, H₂O ${f(byKey.sunH2o.vals[l])}` : ''}`);
        if (profShow.ground) parts.push(`ground heat ↑ CO₂ ${f(byKey.gCo2.vals[l])}${profShow.h2o ? `, H₂O ${f(byKey.gH2o.vals[l])}` : ''}`);
        els.profTooltip.textContent = parts.join('  ·  ') + '  (% per km)';
        els.profTooltip.hidden = false;
        els.profTooltip.style.left = '60px';
        els.profTooltip.style.top = `${Math.max(4, y - 30)}px`;
      });
      els.profChart.addEventListener('mouseleave', () => { els.profTooltip.hidden = true; });
    }
    const heightTip = (kind) => (b, nu) => {
      const L = altLayout[kind];
      if (!L) return null;
      const f = (v) => (v >= L.zTop - 1 && kind === 'up' ? 'never (transparent)' : v <= data.zSurface + 1 && kind === 'down' ? 'never (transparent)' : `${(v / 1000).toFixed(1)} km`);
      const parts = [`${nu.toFixed(0)} cm⁻¹`, `at ${fmtPpm(vmrPpm)} ppm: ${f(L.cur[b])}`];
      if (L.ref) parts.push(`reference: ${f(L.ref[b])}`);
      return parts.join('  ·  ');
    };
    spectralTooltip(els.altUpChart, els.altUpTooltip, heightTip('up'));
    spectralTooltip(els.altDownChart, els.altDownTooltip, heightTip('down'));

    // Load the standard atmosphere (the opening chart needs it at once), then
    // restore any state from the URL.
    restoring = true;
    const st = readState();
    if (Number.isFinite(st.c)) setPpm(st.c, { fromRestore: true });
    if (st.m === 't') { specMode = 'trans'; syncModeButtons(); }
    restoring = false;
    loadStandard().then(async () => {
      drawDemoChart();
      if (st.s && manifest.stations.some((s) => s.id === st.s)) {
        await chooseProfile(st.s, { fromRestore: true });
      }
      if (Number.isFinite(st.r)) chooseReference(st.r, { fromRestore: true });
      if (Number.isFinite(st.c) && Number.isFinite(st.r) && Math.abs(st.c - st.r) > 0.05) sliderMoved = true;
      if (st.w && data && els.toggleH2O) els.toggleH2O.click();
      if (st.sc && data) sampleAll({ fromRestore: true });
      if (st.w) waterToggledOnce = true;
      const p = Number.isFinite(st.p) ? st.p : (st.s ? 4 : refPpm != null ? 3 : 2);
      revealUpTo(Math.max(2, p), { fromRestore: true });
      drawAll();
      pushState();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
}
