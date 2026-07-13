// The Thermometer Shop — simulation model.
//
// One deliberately-synthetic day of air temperature, fed through real
// instrument and exposure response models. The WEATHER here is invented (a
// seeded, physically-driven diurnal cycle — the page says so plainly); the
// INSTRUMENT and EXPOSURE parameters are not: every time constant, tolerance,
// resolution, and bias mechanism is taken from the published ranges cited on
// each product card and in the page's Data Sources section.
//
// Why synthetic weather at all: no real site ever ran an 18th-century
// poleward-wall thermometer, a Stevenson screen, and an aspirated PRT side
// by side in identical air. A simulation is the only way to hold the air fixed
// while varying only the instrument — which is the one question this lab
// isolates. Everything the reader compares (recorded Tmax, Tmin, midpoint,
// true integrated mean) is computed from the same underlying air series.
//
// Everything is seeded and deterministic: the same (latitude, day, cloud,
// seed) always reproduces the same weather, so shared links replay exactly.

// ── Seeded RNG ───────────────────────────────────────────────────────────
// mulberry32: small, fast, good-enough PRNG for weather noise. Not crypto.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a on a string — used to derive stable per-cart-item RNG streams from
// the run seed plus the item's identity, so re-running with the same seed
// gives each unit the same manufacturing draw, but two identical units in
// different cart slots get different draws.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Box-Muller: one standard normal per call, consuming two uniforms.
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Solar geometry ───────────────────────────────────────────────────────
// Standard declination + hour-angle formulae. Azimuth measured from north,
// clockwise (0 = north, 90 = east, 180 = south). Time is local solar time:
// hour 12 = sun highest. Good to a degree or so — far tighter than anything
// else in this model needs.
const DEG = Math.PI / 180;

export function solarDeclinationDeg(dayOfYear) {
  return 23.44 * Math.sin(DEG * ((360 / 365) * (dayOfYear + 284)));
}

export function solarPosition(latDeg, dayOfYear, solarHour) {
  const decl = solarDeclinationDeg(dayOfYear) * DEG;
  const lat = latDeg * DEG;
  const hourAngle = (solarHour - 12) * 15 * DEG;
  const sinElev =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinElev)));
  // Azimuth from north, clockwise; guard the acos argument and resolve the
  // afternoon/morning ambiguity with the hour angle's sign.
  const cosAz =
    (Math.sin(decl) - Math.sin(lat) * sinElev) /
    (Math.cos(lat) * Math.cos(elev) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / DEG;
  if (hourAngle > 0) az = 360 - az;
  return { elevationDeg: elev / DEG, azimuthDeg: az, sinElev };
}

// ── Locations ────────────────────────────────────────────────────────────
// Only the latitude enters the simulation (sun geometry + a plausible
// seasonal baseline for that latitude). The names locate the latitude on a
// map for the reader — this is NOT a simulation of these cities' actual
// climate or weather, and the page says so. Listed pole to pole, north to
// south: a fixed mechanical order, since location is an explorable control
// the reader is invited to sweep, not a blocking choice.
export const LOCATIONS = [
  { id: 'longyearbyen', label: 'Longyearbyen latitude (78° N)', latDeg: 78.2 },
  { id: 'fairbanks', label: 'Fairbanks latitude (65° N)', latDeg: 64.8 },
  { id: 'reykjavik', label: 'Reykjavík latitude (64° N)', latDeg: 64.1 },
  { id: 'dublin', label: 'Dublin latitude (53° N)', latDeg: 53.3 },
  { id: 'madrid', label: 'Madrid latitude (40° N)', latDeg: 40.4 },
  { id: 'cairo', label: 'Cairo latitude (30° N)', latDeg: 30.0 },
  { id: 'singapore', label: 'Singapore latitude (1° N)', latDeg: 1.3 },
  { id: 'nairobi', label: 'Nairobi latitude (1° S)', latDeg: -1.3 },
  { id: 'sydney', label: 'Sydney latitude (34° S)', latDeg: -33.9 },
  { id: 'ushuaia', label: 'Ushuaia latitude (55° S)', latDeg: -54.8 },
];

// ── Wind regimes ─────────────────────────────────────────────────────────
// Wind enters as a preset the reader picks, Beaufort-flavoured, each with a
// stated mean speed and gustiness. It is held at that regime for the whole
// day (no synoptic evolution), with seeded gust texture around the mean.
// Ventilation drives real, cited mechanisms: a naturally-ventilated screen's
// lag and radiation errors grow toward calm and shrink in strong wind (WMO
// CIMO Guide; van der Meulen & Brandsma 2008), the wall pocket flushes
// faster in wind, and the aspirated shield barely cares — its fan dominates,
// which is its documented design point.
export const WIND_REGIMES = [
  { id: 'calm', label: 'Calm', detail: 'under 0.5 m/s', mps: 0.4, gustFrac: 0.3 },
  { id: 'light', label: 'Light breeze', detail: '≈2.5 m/s, gusts 3.5', mps: 2.5, gustFrac: 0.35 },
  { id: 'moderate', label: 'Moderate breeze', detail: '≈5.5 m/s, gusts 8', mps: 5.5, gustFrac: 0.4 },
  { id: 'strong', label: 'Strong breeze', detail: '≈11 m/s, gusts 15', mps: 11, gustFrac: 0.45 },
  { id: 'gale', label: 'Gale', detail: '≈18 m/s, gusts 25', mps: 18, gustFrac: 0.5 },
  { id: 'hurricane', label: 'Hurricane', detail: '≈35 m/s, gusts 50', mps: 35, gustFrac: 0.6 },
];
export function getWindRegime(id) {
  return WIND_REGIMES.find((w) => w.id === id) || null;
}

// Reference speed the "moderate breeze" specs are quoted at; ventilation
// factors below scale relative to it, clamped so no regime extrapolates
// beyond what the cited intercomparisons cover.
const WIND_REF_MPS = 5.5;
function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ── Synthetic climate baseline ───────────────────────────────────────────
// A generic, maritime-ish seasonal baseline driven by latitude alone:
// annual-mean temperature falls off toward the poles, seasonal amplitude
// grows, and the seasonal phase flips hemisphere. Deliberately simple and
// admitted as such — it exists to give the diurnal simulation a plausible
// starting temperature, not to reconstruct any real place's climate.
export function seasonalBaselineC(latDeg, dayOfYear) {
  const absLat = Math.abs(latDeg);
  // Zonal-mean-shaped annual mean (≈27 °C at the equator, ≈−16 °C at the
  // poles) with a maritime-ish seasonal swing growing poleward.
  const annualMean = -16 + 43 * Math.cos(absLat * DEG);
  const amplitude = 1.5 + 13 * Math.pow(Math.sin(absLat * DEG), 2);
  // Peak warmth lags the solstice by ~30 days (day ~202 in the north).
  const phase = 2 * Math.PI * ((dayOfYear - 202) / 365);
  const northSeason = Math.cos(phase);
  return annualMean + amplitude * (latDeg >= 0 ? northSeason : -northSeason);
}

// ── The simulated day ────────────────────────────────────────────────────
// Time step: 10 s. Two spin-up days are run first so the kept (third) day
// starts from a settled state; every array returned covers that one kept
// day, midnight to midnight local solar time.
export const DT_SECONDS = 10;
export const STEPS_PER_DAY = Math.round((24 * 3600) / DT_SECONDS);
const SPINUP_DAYS = 2;

const SOLAR_CONSTANT = 1361; // W/m², same value the airless-body lab uses
const CLEAR_SKY_TRANSMISSION = 0.75;

// Kasten & Czeplak (1980): global irradiance under cloud fraction c falls
// off as (1 − 0.75·c^3.4) of the clear-sky value — their published
// coefficients, used as published.
export function cloudTransmission(cloudFraction) {
  return 1 - 0.75 * Math.pow(cloudFraction, 3.4);
}

/**
 * Simulate the underlying air temperature for one day.
 *
 * The air model is a single-reservoir surface energy balance: absorbed
 * shortwave in, cloud-modulated longwave cooling out, relaxation toward the
 * seasonal baseline (standing in for advection and the deep ground), plus
 * two seeded stochastic processes that give the air its real short-term
 * texture — a two-state cloud gate (is the sun disc covered right now?)
 * whose occupancy matches the chosen cloud fraction, and an
 * Ornstein–Uhlenbeck turbulence term whose amplitude scales with daytime
 * convection. Without that texture, sampling schedules and time constants
 * would have nothing to disagree about.
 *
 * Returns { timeHours, airC, sun, trueMeanC, trueMaxC, trueMinC, ... }.
 */
export function simulateDay({ latDeg, dayOfYear, cloudFraction, seed, windMps = WIND_REF_MPS, gustFrac = 0.4 }) {
  const rng = mulberry32(seed >>> 0);
  const baseline = seasonalBaselineC(latDeg, dayOfYear);
  // Wind's two effects on the air itself: stronger wind couples the layer
  // harder to the baseline (advection — smaller diurnal swing), and it
  // mechanically mixes away the free-convective temperature flicker that
  // makes light-wind sunny afternoons jittery.
  const windCalmness = WIND_REF_MPS / Math.max(windMps, 0.5);
  const restoreFactor = clampNum(Math.pow(windCalmness, 0.4), 0.45, 1.8);
  const sigmaFactor = clampNum(Math.pow(WIND_REF_MPS / Math.max(windMps, 1), 0.3), 0.55, 1.5);

  // Tuning constants for the energy balance. C_EFF is the effective heat
  // capacity of the responding air/surface layer per m²; LW0 the clear-sky
  // net longwave loss; TAU_RESTORE the advective/ground relaxation time.
  // Together they set a clear-sky midlatitude diurnal range of roughly
  // 8–12 °C, shrinking under overcast — magnitudes in the range of real
  // screen-level cycles, which is all a synthetic day needs.
  const C_EFF = 5e5; // J/(m²·K)
  const SW_ABSORPTION = 0.62; // fraction of global irradiance heating the layer
  const TAU_RESTORE = 3 * 3600 * restoreFactor; // s

  // Longwave: real T⁴ emission against a cloud-dependent sky. The layer
  // emits εσT⁴ at its own temperature; the sky radiates back the Swinbank
  // (1963) clear-sky downwelling evaluated at the seasonal baseline (the
  // boundary layer aloft does not cool with the surface layer overnight),
  // enhanced under cloud — so clear nights cool toward a radiative
  // equilibrium well below the baseline while overcast nights barely can.
  const SIGMA = 5.670374419e-8;
  const EMISSIVITY = 0.97;
  const baselineK = baseline + 273.15;
  const lDown =
    5.31e-13 * Math.pow(baselineK, 6) * (1 + 0.22 * cloudFraction * cloudFraction);

  // Stable-night decoupling: on calm nights turbulent exchange with the
  // boundary layer largely shuts down, so the restore weakens and radiative
  // cooling can dig a real nocturnal minimum; wind (mechanical mixing) and
  // daylight (convection) keep the coupling strong. This is the regime
  // where shelter differences bite hardest in the field intercomparisons.
  const calmExcess = clampNum(Math.pow(windCalmness, 0.7) - 1, 0, 2);

  // Cloud gate: two-state telegraph process, mean occupancy = cloudFraction,
  // decorrelation ~12 min. Under c=0 the sun is never covered; under c=1
  // always. Broken-sky settings switch — which is exactly what makes
  // partly-cloudy afternoons jittery.
  const GATE_TAU = 12 * 60; // s
  let gateCovered = rng() < cloudFraction;

  // OU turbulence on the air temperature itself: decorrelation ~4 min,
  // amplitude growing with instantaneous insolation (daytime convective
  // gustiness) from a small nighttime floor.
  const OU_TAU = 4 * 60; // s
  const OU_SIGMA_NIGHT = 0.06; // °C standard deviation floor
  const OU_SIGMA_DAY = 0.38 * sigmaFactor; // °C additional at full overhead sun
  let ou = 0;

  // Gust texture: a second OU process modulating the wind around its mean
  // (decorrelation ~90 s), so naturally-ventilated shelters see their
  // ventilation flicker the way gusts really make it.
  const GUST_TAU = 90; // s
  let ouWind = 0;

  const totalSteps = STEPS_PER_DAY * (SPINUP_DAYS + 1);
  const keepFrom = STEPS_PER_DAY * SPINUP_DAYS;

  const timeHours = new Float64Array(STEPS_PER_DAY);
  const airC = new Float64Array(STEPS_PER_DAY);
  const ghi = new Float64Array(STEPS_PER_DAY); // global horizontal irradiance
  const dni = new Float64Array(STEPS_PER_DAY); // direct normal irradiance
  const sunElevDeg = new Float64Array(STEPS_PER_DAY);
  const sunAzDeg = new Float64Array(STEPS_PER_DAY);
  const windSeries = new Float64Array(STEPS_PER_DAY); // instantaneous m/s

  let T = baseline;
  const cTrans = cloudTransmission(cloudFraction);

  for (let i = 0; i < totalSteps; i++) {
    const solarHour = ((i % STEPS_PER_DAY) * DT_SECONDS) / 3600;
    const sun = solarPosition(latDeg, dayOfYear, solarHour);
    const sinE = Math.max(0, sun.sinElev);

    // Evolve the cloud gate (exact exponential switching probabilities so
    // occupancy stays at cloudFraction regardless of dt).
    const pSwitch = 1 - Math.exp(-DT_SECONDS / GATE_TAU);
    if (rng() < pSwitch) gateCovered = rng() < cloudFraction;

    // Irradiance decomposition. Total follows Kasten–Czeplak on the smooth
    // cloud fraction; the direct beam additionally gates on whether the sun
    // disc is covered right now, and its clear-sky strength uses the Meinel
    // airmass attenuation — without it, low-sun beam (exactly what strikes
    // a poleward wall on high-latitude mornings) would be badly overstated.
    const clearGhi = SOLAR_CONSTANT * CLEAR_SKY_TRANSMISSION * sinE;
    const totalGhi = clearGhi * cTrans;
    let currentDni = 0;
    if (!gateCovered && sinE > 0) {
      const airmass = 1 / Math.max(sinE, 0.02);
      currentDni = SOLAR_CONSTANT * Math.pow(0.7, Math.pow(airmass, 0.678));
    }

    // Energy balance step.
    const lwLoss = EMISSIVITY * SIGMA * Math.pow(T + 273.15, 4) - lDown;
    const maxGhiNow = SOLAR_CONSTANT * CLEAR_SKY_TRANSMISSION;
    const nightness = 1 - Math.min(1, totalGhi / (0.1 * maxGhiNow));
    const tauNow = TAU_RESTORE * (1 + 2.2 * nightness * calmExcess);
    const dTdt =
      (SW_ABSORPTION * totalGhi - lwLoss) / C_EFF - (T - baseline) / tauNow;
    T += dTdt * DT_SECONDS;

    // OU turbulence (added on output, evolved here).
    const sigma = OU_SIGMA_NIGHT + OU_SIGMA_DAY * sinE * (gateCovered ? 0.55 : 1);
    ou += (-ou / OU_TAU) * DT_SECONDS + sigma * Math.sqrt((2 * DT_SECONDS) / OU_TAU) * gaussian(rng);

    // Gust process (relative wind fluctuation, floored so wind never quite
    // dies even in a "gusty calm").
    ouWind += (-ouWind / GUST_TAU) * DT_SECONDS + gustFrac * Math.sqrt((2 * DT_SECONDS) / GUST_TAU) * gaussian(rng);

    if (i >= keepFrom) {
      const j = i - keepFrom;
      timeHours[j] = solarHour;
      airC[j] = T + ou;
      ghi[j] = totalGhi;
      dni[j] = currentDni;
      sunElevDeg[j] = sun.elevationDeg;
      sunAzDeg[j] = sun.azimuthDeg;
      windSeries[j] = windMps * Math.max(0.15, 1 + ouWind);
    }
  }

  let sum = 0;
  let trueMaxC = -Infinity;
  let trueMinC = Infinity;
  for (let j = 0; j < STEPS_PER_DAY; j++) {
    sum += airC[j];
    if (airC[j] > trueMaxC) trueMaxC = airC[j];
    if (airC[j] < trueMinC) trueMinC = airC[j];
  }
  // True median of the day's samples — the other defensible one-number
  // summary of "the day's temperature", alongside the integrated mean.
  const sorted = Float64Array.from(airC).sort();
  const trueMedianC = (sorted[STEPS_PER_DAY / 2 - 1] + sorted[STEPS_PER_DAY / 2]) / 2;

  return {
    latDeg,
    windMps,
    timeHours,
    airC,
    ghi,
    dni,
    sunElevDeg,
    sunAzDeg,
    windSeries,
    trueMeanC: sum / STEPS_PER_DAY,
    trueMedianC,
    trueMaxC,
    trueMinC,
  };
}

// ── Exposures ────────────────────────────────────────────────────────────
// Each exposure turns the true air series into the air the instrument
// actually sits in. All three are first-order low-pass responses (their own
// thermal lag) plus the radiation/ventilation errors documented for that
// exposure class. A fixed moderate breeze is assumed throughout — wind is
// not a control in this lab, and the card copy says which assumption is
// baked in.
//
// Magnitudes:
// - Stevenson screen: lag ~2.5–15 min depending on wind (WMO CIMO Guide,
//   Harrison 2015); daytime radiation excess a few tenths °C at full sun,
//   small nighttime deficit (van der Meulen & Brandsma 2008 intercomparison).
// - Aspirated shield: forced ventilation holds lag to ~1 min and radiation
//   error near zero (USCRN design targets, Diamond et al. 2013).
// - Poleward-facing wall: pre-screen exposure per Parker (1994) — the sensor
//   couples to a massive wall (hours-scale lag), sees restricted sky (less
//   nighttime radiative cooling), reflected/diffuse light, and — whenever
//   the sun's azimuth swings into the wall-facing half of the sky — direct
//   beam. The wall faces the building's shaded side, as historical
//   observers chose it: north in the northern hemisphere, SOUTH in the
//   southern (a fixed north wall would put the southern hemisphere's
//   "shade" exposure in full midday sun — the opposite of the practice
//   Parker documents). Its direct-beam loading is computed geometrically
//   from the sun's actual position, not assumed: whether a poleward wall
//   ever sees sun still depends on where and when you are.
//
// Wall/1780s mechanistic constants (coupling fractions, solar gain per kW,
// stiction) are this lab's estimates chosen so the resulting behaviour sits
// inside the ranges the cited works document — the works publish outcomes,
// not these constants. The page says so.
export const EXPOSURES = [
  {
    id: 'stevenson',
    label: 'Stevenson screen',
    short: 'Stevenson',
    cardLine:
      'Louvred wooden box, naturally ventilated — its behaviour follows the wind you choose.',
    blurb:
      'Louvred wooden box on legs, naturally ventilated — adopted worldwide from the late 1800s to give thermometers a standardised, shaded, ventilated home. Documented behaviour: a sun-scaled daytime excess and a small nighttime deficit relative to the passing air, both largest in calm and shrinking as the wind you choose picks up.',
    citation: 'WMO CIMO Guide (WMO-No. 8); van der Meulen & Brandsma (2008)',
    tauSeconds: 8 * 60,
    dayRadiationErrorC: 0.35, // at full overhead sun, moderate breeze
    nightRadiationErrorC: -0.12,
  },
  {
    id: 'aspirated',
    label: 'Mechanically aspirated shield',
    short: 'Aspirated',
    cardLine:
      'A fan drives constant airflow over the sensor — designed to be indifferent to the outside wind.',
    blurb:
      'A fan pulls a constant airstream over the sensor, a design intended to minimise radiation error, hold the exposure lag to about a minute, and make the shelter indifferent to the outside wind. Documented behaviour in field intercomparisons matches that intent. This lab assumes the fan never loses power — in any weather you pick.',
    citation: 'Diamond et al. (2013), USCRN; WMO CIMO Guide',
    tauSeconds: 60,
    dayRadiationErrorC: 0.03,
    nightRadiationErrorC: -0.01,
  },
  {
    id: 'northwall',
    label: 'Poleward-facing wall / window recess',
    short: 'Wall',
    cardLine:
      'Pre-screen practice: hangs at the building’s shaded side, part-coupled to its thermal mass.',
    blurb:
      'How temperatures were taken before screens: the thermometer hangs at the building’s shaded side — a north-facing wall or window in the northern hemisphere, south-facing in the southern. Documented behaviour: the sensor part-couples to the building’s thermal mass, sees less sky at night, and receives whatever direct sun that wall’s orientation actually admits at your latitude and season — computed here from the sun’s real path, not assumed. Wind flushes the recess: its lags and excesses shrink as the wind you choose picks up.',
    citation: 'Parker (1994)',
    tauSeconds: 6 * 60, // lag of the air pocket at the wall itself
    wallTauSeconds: 4.5 * 3600, // thermal mass of the wall the sensor couples to
    wallCoupling: 0.38, // fraction of sensor environment set by the wall
    wallAbsorption: 0.6, // fraction of wall-incident beam absorbed
    wallSolarGainC_perKW: 6.5, // °C wall excess per kW/m² absorbed beam, at equilibrium
    nightSkyRestrictionC: 0.5, // reduced nighttime cooling vs open exposure
  },
];

// The poleward wall's azimuth factor: cos(sun azimuth from the wall
// normal), where the wall normal points true north at northern latitudes
// and true south at southern ones — the building's shaded side, the side
// historical observers actually chose. Exported for the tests.
export function wallAzimuthFactor(latDeg, sunAzDeg) {
  const azFromNorth = Math.cos(sunAzDeg * DEG);
  return latDeg >= 0 ? azFromNorth : -azFromNorth;
}

// Compute the exposure-environment temperature series for one exposure.
//
// Every filter here runs a full warm-up pass over the (periodic) day before
// the recorded pass, so the kept series starts from the filter's settled
// state rather than an arbitrary midnight initialisation — without this,
// the wall's hours-long memory would start amnesiac at midnight and leak a
// spurious transient into wall-exposure Tmin.
function exposureSeries(day, exposure) {
  const n = day.airC.length;
  const out = new Float64Array(n);
  const maxGhi = SOLAR_CONSTANT * CLEAR_SKY_TRANSMISSION;

  // Ventilation factors relative to the moderate-breeze reference the specs
  // are quoted at. The aspirated shield ignores the wind — its fan sets the
  // airflow — which is exactly its documented design point. Naturally
  // ventilated exposures respond to the instantaneous (gusty) wind: lags
  // stretch and radiation errors grow toward calm, and both shrink in
  // strong wind, clamped to the ranges the cited intercomparisons cover.
  const windAt = (i) => Math.max(day.windSeries ? day.windSeries[i] : WIND_REF_MPS, 0.3);

  if (exposure.id === 'northwall') {
    // Wall temperature: first-order response to (air + absorbed solar gain
    // + restricted-sky nighttime warmth). Direct beam on the vertical
    // poleward wall: DNI · cos(elev) · wallAzimuthFactor, when positive.
    let wall = day.airC[0];
    let pocket = day.airC[0];
    const aWall = 1 - Math.exp(-DT_SECONDS / exposure.wallTauSeconds);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const w = windAt(i);
        const calm = WIND_REF_MPS / w;
        const elev = day.sunElevDeg[i] * DEG;
        const azFac = wallAzimuthFactor(day.latDeg, day.sunAzDeg[i]);
        const beamOnWall =
          day.sunElevDeg[i] > 0 && azFac > 0
            ? day.dni[i] * Math.cos(elev) * azFac
            : 0;
        // Wind flushes the wall's solar excess and its restricted-sky
        // nighttime warmth away faster (stronger convective coupling).
        const solarGainC =
          exposure.wallSolarGainC_perKW * clampNum(Math.pow(calm, 0.5), 0.35, 2.2) *
          (exposure.wallAbsorption * beamOnWall) / 1000;
        const nightWarmC =
          exposure.nightSkyRestrictionC * clampNum(Math.pow(calm, 0.3), 0.6, 1.5) *
          (1 - Math.min(1, day.ghi[i] / (0.15 * maxGhi)));
        const wallTarget = day.airC[i] + solarGainC + nightWarmC;
        wall += aWall * (wallTarget - wall);
        const pocketTau = clampNum(exposure.tauSeconds * Math.pow(calm, 0.4), 90, 1200);
        const aPocket = 1 - Math.exp(-DT_SECONDS / pocketTau);
        const envTarget =
          (1 - exposure.wallCoupling) * day.airC[i] + exposure.wallCoupling * wall;
        pocket += aPocket * (envTarget - pocket);
        if (pass === 1) out[i] = pocket;
      }
    }
    return out;
  }

  // Screen-type exposures: lag plus insolation-scaled radiation error. The
  // aspirated shield's fan fixes its ventilation; the Stevenson screen's
  // lag and radiation errors follow the instantaneous wind.
  const windSensitive = exposure.id !== 'aspirated';
  let env = day.airC[0];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const calm = windSensitive ? WIND_REF_MPS / windAt(i) : 1;
      const tau = windSensitive
        ? clampNum(exposure.tauSeconds * Math.pow(calm, 0.5), 120, 1500)
        : exposure.tauSeconds;
      const a = 1 - Math.exp(-DT_SECONDS / tau);
      const radFactor = windSensitive ? clampNum(Math.pow(calm, 0.7), 0.15, 3) : 1;
      const sunLoad = Math.min(1, day.ghi[i] / maxGhi);
      const radErr =
        (exposure.dayRadiationErrorC * radFactor) * sunLoad +
        (exposure.nightRadiationErrorC * radFactor) * (1 - Math.min(1, day.ghi[i] / (0.15 * maxGhi)));
      env += a * (day.airC[i] + radErr - env);
      if (pass === 1) out[i] = env;
    }
  }
  return out;
}

// ── Instruments ──────────────────────────────────────────────────────────
// Every parameter here is the product card's spec, and every spec cites its
// source. Tolerances are the maximum permitted scale error for that class
// of instrument; at checkout each unit draws its actual error uniformly
// within its tolerance (seeded — you know the tolerance you bought, not the
// error you got, same as a real purchase). Resolution is the finest step
// the instrument is read/recorded to. registration describes how the daily
// extremes are captured:
// - 'ligRegister': mechanical min/max indexes riding the liquid column,
//   read and reset once daily (at local midnight here, so every cart item
//   covers the identical 24 h — observation-time effects are deliberately
//   out of scope). stictionC is the push needed to move the index.
// - 'spot': instantaneous electronic samples every sampleSeconds; daily
//   extremes are the extreme samples.
// - 'average': electronic samples averaged over averageSeconds blocks;
//   daily extremes are the extreme block means (WMO's current Tmax/Tmin
//   definition uses 1-min means; USCRN publishes 5-min means).
export const CATALOGUE = [
  {
    id: 'lig1780',
    name: 'Six-pattern min/max, late 1700s',
    era: 'c. 1780',
    kind: 'Liquid-in-glass',
    tauSeconds: 240,
    toleranceC: 1.0,
    resolutionC: 0.5,
    stictionC: 0.1,
    registration: 'ligRegister',
    blurb:
      'A single U-tube spirit/mercury instrument with steel indexes pushed by the liquid — the first practical self-registering min/max design (James Six, 1782). Pre-standardisation manufacture: wide bore variations and hand-drawn scales.',
    specs: [
      { label: 'Response time', value: '≈4 min in moving air' },
      { label: 'Tolerance', value: '±1.0 °C (pre-standardisation)' },
      { label: 'Resolution', value: 'read to the nearest 0.5 °C' },
      { label: 'Index friction', value: '≈0.1 °C of push to move' },
      { label: 'Measurement method', value: 'mechanical min/max indexes, read & reset once daily' },
    ],
    citation: 'Middleton (1966); Austin & McConnell (1980) — exact figures are this lab’s estimates consistent with those histories',
  },
  {
    id: 'lig1880',
    name: 'Standard-pattern LiG pair, late 1800s',
    era: 'c. 1880',
    kind: 'Liquid-in-glass',
    tauSeconds: 150,
    toleranceC: 0.3,
    resolutionC: 0.25,
    stictionC: 0.05,
    registration: 'ligRegister',
    blurb:
      'The classic observatory pair: sheathed mercury maximum (constriction bore) and spirit minimum (dumbbell index), certificate-calibrated against a standard — the pattern that populated the world’s new Stevenson screens.',
    specs: [
      { label: 'Response time', value: '≈2.5 min in moving air' },
      { label: 'Tolerance', value: '±0.3 °C (certificate)' },
      { label: 'Resolution', value: 'read to the nearest 0.25 °C' },
      { label: 'Index friction', value: '≈0.05 °C of push to move' },
      { label: 'Measurement method', value: 'mechanical min/max indexes, read & reset once daily' },
    ],
    citation: 'Middleton (1966); WMO CIMO Guide',
  },
  {
    id: 'lig1960',
    name: 'Calibrated met-service LiG pair, mid 1900s',
    era: 'c. 1960',
    kind: 'Liquid-in-glass',
    tauSeconds: 90,
    toleranceC: 0.15,
    resolutionC: 0.1,
    stictionC: 0.02,
    registration: 'ligRegister',
    blurb:
      'National-met-service sheathed pattern with regular calibration checks — the instrument behind most 20th-century climate records. Same mechanical min/max principle as its ancestors, with tighter tolerances and finer readings.',
    specs: [
      { label: 'Response time', value: '≈1.5 min in moving air' },
      { label: 'Tolerance', value: '±0.15 °C (maintained)' },
      { label: 'Resolution', value: 'read to the nearest 0.1 °C' },
      { label: 'Index friction', value: '≈0.02 °C of push to move' },
      { label: 'Measurement method', value: 'mechanical min/max indexes, read & reset once daily' },
    ],
    citation: 'WMO CIMO Guide (WMO-No. 8), Vol. I Ch. 2',
  },
  {
    id: 'prtSheathed',
    name: 'Sheathed PRT probe, 1-min spot samples',
    era: 'c. 1985',
    kind: 'Platinum resistance',
    tauSeconds: 80,
    toleranceC: 0.15,
    resolutionC: 0.1,
    registration: 'spot',
    sampleSeconds: 60,
    blurb:
      'First-generation automatic-station probe: a PT100 element inside a stainless sheath, which sets its response time. The logger keeps whichever instantaneous sample was highest and lowest.',
    specs: [
      { label: 'Response time', value: '≈80 s (sheath-dominated)' },
      { label: 'Tolerance', value: '±0.15 °C at 0 °C (Class A)' },
      { label: 'Resolution', value: 'logged to 0.1 °C' },
      { label: 'Sampling', value: 'instantaneous sample every 60 s' },
      { label: 'Daily max/min', value: 'highest/lowest single sample' },
    ],
    citation: 'IEC 60751 Class A; WMO CIMO Guide',
  },
  {
    id: 'prtFast',
    name: 'Fast PRT, 1-min averages',
    era: 'c. 2010',
    kind: 'Platinum resistance',
    tauSeconds: 20,
    toleranceC: 0.05,
    resolutionC: 0.1,
    registration: 'average',
    sampleSeconds: 10,
    averageSeconds: 60,
    blurb:
      'A small, low-mass element with the logger reporting one-minute means — the WMO’s current definition of daily max and min uses the highest and lowest of these one-minute values.',
    specs: [
      { label: 'Response time', value: '≈20 s' },
      { label: 'Tolerance', value: '±0.05 °C (calibrated)' },
      { label: 'Resolution', value: 'logged to 0.1 °C' },
      { label: 'Sampling', value: '10 s samples → 1-min means' },
      { label: 'Daily max/min', value: 'highest/lowest 1-min mean' },
    ],
    citation: 'WMO CIMO Guide (WMO-No. 8), Vol. I Ch. 2',
  },
  {
    id: 'prtUscrn',
    name: 'Reference-network PRT, 5-min averages',
    era: 'c. 2005',
    kind: 'Platinum resistance',
    tauSeconds: 20,
    toleranceC: 0.05,
    resolutionC: 0.1,
    registration: 'average',
    sampleSeconds: 10,
    averageSeconds: 300,
    blurb:
      'The US Climate Reference Network pattern: fast elements, but the published record is five-minute means — block averages instead of instantaneous readings.',
    specs: [
      { label: 'Response time', value: '≈20 s' },
      { label: 'Tolerance', value: '±0.05 °C (calibrated)' },
      { label: 'Resolution', value: 'logged to 0.1 °C' },
      { label: 'Sampling', value: '10 s samples → 5-min means' },
      { label: 'Daily max/min', value: 'highest/lowest 5-min mean' },
    ],
    citation: 'Diamond et al. (2013), USCRN',
  },
];

export function getInstrument(id) {
  return CATALOGUE.find((c) => c.id === id) || null;
}
export function getExposure(id) {
  return EXPOSURES.find((e) => e.id === id) || null;
}

// Round a reading to the instrument's resolution.
function roundToResolution(valueC, resolutionC) {
  return Math.round(valueC / resolutionC) * resolutionC;
}

// ── Running one cart item ────────────────────────────────────────────────
/**
 * Feed the day through one instrument+exposure combination.
 *
 * itemKey should be stable per cart slot (e.g. `${seed}:${slot}:${ids}`) so
 * the unit's manufacturing draw is reproducible for a shared link but
 * distinct between two identical units in different slots.
 *
 * Returns recorded stats plus the full instrument-temperature series (for
 * the day chart).
 */
export function runCartItem(day, instrument, exposure, itemKey) {
  const env = exposureSeries(day, exposure);
  const n = env.length;

  // Instrument first-order lag over the exposure environment, with the
  // same warm-up pass as the exposures so the register opens at midnight
  // on a settled reading, not an initialisation artifact. Inside naturally
  // ventilated shelters the in-shelter airflow follows the outside wind, so
  // the instrument's own "in moving air" time constant stretches modestly
  // in calm and tightens in wind; the aspirated shield's fan fixes it.
  const instrSeries = new Float64Array(n);
  let Ti = env[0];
  const windFactor =
    exposure.id === 'aspirated'
      ? 1
      : Math.min(1.6, Math.max(0.7, Math.pow(5.5 / Math.max(day.windMps || 5.5, 0.5), 0.25)));
  const a = 1 - Math.exp(-DT_SECONDS / (instrument.tauSeconds * windFactor));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      Ti += a * (env[i] - Ti);
      if (pass === 1) instrSeries[i] = Ti;
    }
  }

  // Manufacturing draw: this unit's scale error, uniform within tolerance.
  const itemRng = mulberry32(hashString(itemKey));
  const calOffsetC = (itemRng() * 2 - 1) * instrument.toleranceC;

  let rawMax;
  let rawMin;
  if (instrument.registration === 'ligRegister') {
    // Mechanical indexes with stiction: the register only moves when the
    // column pushes it by more than the friction threshold.
    let regMax = instrSeries[0];
    let regMin = instrSeries[0];
    for (let i = 1; i < n; i++) {
      if (instrSeries[i] > regMax + instrument.stictionC) regMax = instrSeries[i];
      if (instrSeries[i] < regMin - instrument.stictionC) regMin = instrSeries[i];
    }
    rawMax = regMax;
    rawMin = regMin;
  } else if (instrument.registration === 'spot') {
    const stride = Math.round(instrument.sampleSeconds / DT_SECONDS);
    rawMax = -Infinity;
    rawMin = Infinity;
    for (let i = 0; i < n; i += stride) {
      if (instrSeries[i] > rawMax) rawMax = instrSeries[i];
      if (instrSeries[i] < rawMin) rawMin = instrSeries[i];
    }
  } else {
    // 'average': block means of sampleSeconds samples over averageSeconds.
    const sampleStride = Math.round(instrument.sampleSeconds / DT_SECONDS);
    const blockSteps = Math.round(instrument.averageSeconds / DT_SECONDS);
    rawMax = -Infinity;
    rawMin = Infinity;
    for (let b = 0; b + blockSteps <= n; b += blockSteps) {
      let s = 0;
      let count = 0;
      for (let i = b; i < b + blockSteps; i += sampleStride) {
        s += instrSeries[i];
        count++;
      }
      const mean = s / count;
      if (mean > rawMax) rawMax = mean;
      if (mean < rawMin) rawMin = mean;
    }
  }

  const recordedTmaxC = roundToResolution(rawMax + calOffsetC, instrument.resolutionC);
  const recordedTminC = roundToResolution(rawMin + calOffsetC, instrument.resolutionC);

  return {
    instrumentId: instrument.id,
    exposureId: exposure.id,
    instrSeries,
    // Never displayed on the receipt — you know the tolerance you bought,
    // not the error you got. Kept for the tests.
    calOffsetC,
    recordedTmaxC,
    recordedTminC,
    midpointC: (recordedTmaxC + recordedTminC) / 2,
  };
}

// ── Checkout ─────────────────────────────────────────────────────────────
/**
 * Run the full order: one simulated day, every cart item fed the same air.
 * items: [{ instrumentId, exposureId }], 2–4 of them.
 *
 * unitSeed (optional, defaults to seed) drives the manufacturing draws
 * SEPARATELY from the weather: re-rolling the weather number must not
 * silently hand the reader newly-manufactured units, or sky variability
 * and unit variability become indistinguishable. The page keeps unitSeed
 * fixed per visit (and in the share link) while the weather re-rolls.
 */
export function runCheckout({ latDeg, dayOfYear, cloudFraction, seed, unitSeed, windId = 'moderate', items }) {
  const regime = getWindRegime(windId) || getWindRegime('moderate');
  const day = simulateDay({
    latDeg,
    dayOfYear,
    cloudFraction,
    seed,
    windMps: regime.mps,
    gustFrac: regime.gustFrac,
  });
  const effectiveUnitSeed = unitSeed === undefined ? seed : unitSeed;
  const results = items.map((item, slot) => {
    const instrument = getInstrument(item.instrumentId);
    const exposure = getExposure(item.exposureId);
    if (!instrument || !exposure) {
      throw new Error(`Unknown catalogue item: ${item.instrumentId}/${item.exposureId}`);
    }
    const itemKey = `${effectiveUnitSeed}:${slot}:${item.instrumentId}:${item.exposureId}`;
    return runCartItem(day, instrument, exposure, itemKey);
  });
  return { day, results };
}
