// Transient heat-conduction model of a rotating, airless body's surface
// temperature, driven purely by solar heating — no atmosphere, no internal
// heat source. Built to test how the time-averaged surface temperature of a
// bare rotating body depends on rotation period, independent of any
// greenhouse-gas effect.
//
// Scope, deliberately:
//  - No atmosphere: pure radiative + conductive surface energy balance.
//  - No internal heat source. The deep/core boundary carries no imposed
//    flux or fixed temperature — it is initialized to a starting value and
//    left to evolve purely by conduction from above. "Does geothermal heat
//    change the answer" is a *separate*, later hypothesis to test using
//    this same validated model (by adding a flux term), not something
//    baked into this version.
//  - Zonal (east-west) conduction is neglected: regolith's thermal
//    diffusivity is low enough that the diffusion length over one rotation
//    period is negligible next to the surface distance between longitudes
//    with meaningfully different insolation. A single co-rotating column
//    per latitude band, stepped through time, reproduces the full diurnal
//    cycle at every longitude by rotational symmetry — no need to
//    represent multiple longitude columns at all.
//  - Meridional (north-south) conduction IS modeled: latitude sets up a
//    persistent, non-oscillating gradient (equator warmer than poles),
//    unlike the diurnal east-west gradient which reverses every rotation
//    before conduction can move heat any distance.
//  - Both hemispheres are modeled explicitly (no assumed symmetry), and
//    obliquity is a real input, because a near-zero obliquity is specific
//    to the Moon — a reader exploring Earth-like parameters needs real
//    seasonal asymmetry, and hard-coding a symmetry shortcut now would be
//    a structural change to undo later.
//
// Grid: latitude bands (pole to pole) x depth shells (surface to center).
// Depth shells use geometric growth near the surface (to resolve the thin
// diurnal thermal skin depth) and switch to mass-conserving spacing near
// the center, terminating in one full-ball innermost cell — this avoids
// ever representing a vanishing-volume wedge cell at the coordinate
// singularity at r=0.

const STEFAN_BOLTZMANN = 5.670374419e-8; // W / (m^2 K^4)

// Second conductivity model, offered as an explicit alternative to the
// simple constant-per-layer model above. Source: Metzger, Zacny & Morrison,
// "Thermal Extraction of Volatiles from Lunar and Asteroid Regolith in
// Axisymmetric Crank-Nicolson Modeling" (ASCE J. Aerospace Engineering),
// dry-regolith fit (their Eq. 26), plus a bulk-density-vs-depth profile
// (Carrier, Mitchell & Mahmood, fit to Apollo 15-17 core/drill samples,
// as reproduced in the Lunar Sourcebook, Fig. 9.15) used to convert depth
// into the porosity that equation needs. Unlike the simple model, this
// makes conductivity a continuous function of both depth AND local
// temperature rather than two flat constants split at a fixed thickness —
// so it has to be recomputed every step rather than precomputed once.
const METZGER_GRAIN_DENSITY = 3100; // kg/m^3, average lunar mineral density

export function metzgerBulkDensity(depthBelowSurfaceM) {
  const zCm = depthBelowSurfaceM * 100;
  const rhoGCm3 = (1.92 * (zCm + 12.2)) / (zCm + 18); // g/cm^3
  return rhoGCm3 * 1000; // kg/m^3
}

export function metzgerPorosity(depthBelowSurfaceM) {
  return 1 - metzgerBulkDensity(depthBelowSurfaceM) / METZGER_GRAIN_DENSITY;
}

export function metzgerConductivity(porosity, T) {
  const mWmK = 20.036 * Math.exp(-5.116 * porosity) * (1 + 0.2723 * Math.exp(2.256 * porosity) * Math.pow(T / 350, 3));
  return mWmK / 1000; // W/(m*K)
}

/**
 * Build the depth grid: an array of shell OUTER radii, from the surface
 * (r[0] === radius) down to the center (r[N] === 0). Shell j spans
 * [r[j+1], r[j]].
 *
 * @param {number} radius - body radius, m
 * @param {number} regolithThickness - m
 * @param {number} surfaceCellThickness - thickness of the very first (outermost) cell, m
 * @param {number} growthRatio - geometric growth ratio for successive shell thicknesses
 * @param {number} coreCellCount - approx number of mass-conserving shells near the center
 */
export function buildDepthGrid(radius, regolithThickness, surfaceCellThickness = 0.001, growthRatio = 1.6, coreCellCount = 12) {
  const radii = [radius];
  let r = radius;
  let thickness = surfaceCellThickness;

  // Geometric growth from the surface inward. This single sequence covers
  // both regolith and bulk material — the material properties (not the
  // grid) change at regolithThickness; the grid only needs to be fine near
  // the surface, where the diurnal wave lives, regardless of which
  // material a given cell is in.
  //
  // Stop the pure-geometric phase once remaining depth gets small enough
  // that we want to switch to mass-conserving spacing near the center
  // (defined as the last ~1% of the radius, generously enough to contain
  // several shells before the innermost ball cell).
  const massConservingStart = radius * 0.01;
  while (r - thickness > massConservingStart) {
    r -= thickness;
    radii.push(r);
    thickness *= growthRatio;
  }

  // Mass-conserving phase: choose each shell's thickness so shell volume
  // (which shrinks as r^2 for fixed thickness) stays roughly constant,
  // by growing thickness as r shrinks. Target volume = the volume of the
  // last geometric shell, at the representative solid angle of a full
  // sphere (we normalize by full-sphere solid angle here; per-latitude-band
  // volumes are computed later from these same radii).
  const lastShellOuter = radii[radii.length - 1];
  const targetVolume = (4 / 3) * Math.PI * (Math.pow(lastShellOuter, 3) - Math.pow(lastShellOuter - thickness, 3));
  // Once the remaining radius drops below this, stop subdividing and merge
  // whatever's left into one final ball cell — going finer than the surface
  // cell's own resolution adds no useful accuracy, and (critically) trying
  // to bisect a target volume against an ever-shrinking rOuter eventually
  // hits floating-point noise, producing cascading near-zero-thickness
  // shells that collapse the stable timestep to ~0 (this genuinely happened
  // in testing: thicknesses down to 1e-45 m, stableTimestep ~1e-72 s).
  const minRemainingRadius = Math.max(surfaceCellThickness, r * 1e-6);
  let remaining = r;
  for (let i = 0; i < coreCellCount && remaining > minRemainingRadius; i++) {
    // If the target shell volume would consume the whole remaining ball (or
    // more), stop subdividing entirely rather than asking bisection to find
    // a dr infinitesimally short of r — 40 iterations of bisection only
    // resolve dr to ~1e-12 relative precision, which leaves a non-zero but
    // physically meaningless sliver (this is exactly what produced the
    // degenerate 1e-45 m shells before the earlier fix).
    const wholeRemainingVolume = (4 / 3) * Math.PI * Math.pow(r, 3);
    if (wholeRemainingVolume <= targetVolume) break;

    // Solve dr from: (4/3)pi[(r)^3 - (r-dr)^3] = targetVolume, dr < remaining
    const solveDr = (rOuter) => {
      let lo = 0, hi = rOuter;
      for (let iter = 0; iter < 40; iter++) {
        const mid = (lo + hi) / 2;
        const vol = (4 / 3) * Math.PI * (Math.pow(rOuter, 3) - Math.pow(rOuter - mid, 3));
        if (vol < targetVolume) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const dr = Math.min(solveDr(r), remaining);
    if (dr < minRemainingRadius) break; // would produce a degenerate sliver — merge into the final ball cell instead
    r -= dr;
    radii.push(r);
    remaining = r;
  }

  if (radii[radii.length - 1] > 0) radii.push(0); // final innermost ball cell reaches the true center
  return radii;
}

/**
 * Build latitude band edges (degrees), pole to pole, uniform width.
 * @param {number} nBands
 */
export function buildLatitudeGrid(nBands) {
  const edges = [];
  for (let i = 0; i <= nBands; i++) edges.push(-90 + (180 * i) / nBands);
  return edges;
}

function latBandSolidAngleFraction(latLoDeg, latHiDeg) {
  const s1 = Math.sin((latLoDeg * Math.PI) / 180);
  const s2 = Math.sin((latHiDeg * Math.PI) / 180);
  return (s2 - s1) / 2; // fraction of full sphere's solid angle (integrates to 1 over -90..90)
}

/**
 * Construct a model instance: precomputes grid geometry, cell heat
 * capacities, and inter-cell conductances, given physical parameters.
 *
 * params:
 *  radius (m), albedo (0-1), solarConstant (W/m^2), obliquityDeg,
 *  rotationPeriodSec (sun-relative, i.e. the day/night cycle length),
 *  orbitalPeriodSec (sets the declination cycle; defaults to rotationPeriodSec
 *    for a tidally-locked body where they're equal, but is a separate input
 *    so a fast hypothetical rotation doesn't also compress the season cycle),
 *  conductivityModel ('simple', default, or 'metzger' — see the module-level
 *    comment on metzgerConductivity),
 *  regolithThickness (m), regolithK (W/(m K)), regolithRho (kg/m^3), regolithC (J/(kg K)),
 *    — regolithThickness/regolithK/bulkK/bulkRho unused when conductivityModel is 'metzger'
 *    (regolithC is still used, as the single specific-heat value throughout)
 *  bulkK, bulkRho, bulkC,
 *  nLatBands, surfaceCellThickness, growthRatio, coreCellCount,
 *  emissivity (default 0.95, typical of silicate regolith)
 */
export function createModel(params) {
  const p = {
    emissivity: 0.95,
    conductivityModel: 'simple',
    surfaceCellThickness: 0.001,
    growthRatio: 1.6,
    coreCellCount: 12,
    nLatBands: 60,
    orbitalPeriodSec: params.rotationPeriodSec,
    ...params,
  };

  const depthRadii = buildDepthGrid(p.radius, p.regolithThickness, p.surfaceCellThickness, p.growthRatio, p.coreCellCount);
  const latEdges = buildLatitudeGrid(p.nLatBands);
  const nDepth = depthRadii.length - 1; // number of shells
  const nLat = p.nLatBands;

  // Per-latitude-band solid-angle fraction and band-center latitude (radians).
  const latFraction = new Float64Array(nLat);
  const latCenterRad = new Float64Array(nLat);
  for (let i = 0; i < nLat; i++) {
    latFraction[i] = latBandSolidAngleFraction(latEdges[i], latEdges[i + 1]);
    latCenterRad[i] = ((latEdges[i] + latEdges[i + 1]) / 2) * Math.PI / 180;
  }

  // Material properties per depth shell. conductivityModel:'simple' uses a
  // flat regolith/bulk step (regolithThickness apart); 'metzger' derives
  // porosity from depth via the same profile every shell, and conductivity
  // from that porosity AND local temperature, recomputed every step below
  // rather than fixed here — see shellPorosity and radialConductanceNow /
  // meridionalConductanceNow.
  const useMetzger = p.conductivityModel === 'metzger';
  const shellPorosity = new Float64Array(nDepth);
  const shellK = new Float64Array(nDepth); // only used when !useMetzger
  const shellRho = new Float64Array(nDepth);
  const shellC = new Float64Array(nDepth);
  for (let j = 0; j < nDepth; j++) {
    const depthBelowSurface = p.radius - (depthRadii[j] + depthRadii[j + 1]) / 2;
    shellPorosity[j] = metzgerPorosity(depthBelowSurface);
    const inRegolith = depthBelowSurface < p.regolithThickness;
    shellK[j] = inRegolith ? p.regolithK : p.bulkK;
    if (useMetzger) {
      // Metzger's own depth-density profile replaces the simple model's
      // flat regolith/bulk density step, since density is the same
      // physical quantity his conductivity fit's porosity comes from —
      // using a different, inconsistent density for heat capacity would be
      // incoherent. Specific heat isn't part of Metzger's conductivity
      // work, so it stays one representative value rather than a two-layer
      // step with no governing regolithThickness boundary in this mode.
      shellRho[j] = metzgerBulkDensity(depthBelowSurface);
      shellC[j] = p.regolithC;
    } else {
      shellRho[j] = inRegolith ? p.regolithRho : p.bulkRho;
      shellC[j] = inRegolith ? p.regolithC : p.bulkC;
    }
  }

  // Cell volumes and heat capacities: cellVolume[i][j], heatCapacity[i][j] (J/K).
  const cellVolume = [];
  const heatCapacity = [];
  for (let i = 0; i < nLat; i++) {
    cellVolume.push(new Float64Array(nDepth));
    heatCapacity.push(new Float64Array(nDepth));
    for (let j = 0; j < nDepth; j++) {
      const rOuter = depthRadii[j], rInner = depthRadii[j + 1];
      const fullShellVolume = (4 / 3) * Math.PI * (Math.pow(rOuter, 3) - Math.pow(rInner, 3));
      const v = fullShellVolume * latFraction[i];
      cellVolume[i][j] = v;
      heatCapacity[i][j] = v * shellRho[j] * shellC[j];
    }
  }

  // Radial conductances between shell j and j+1 (same latitude band), W/K per
  // unit temperature difference. Face area is the band's area at the shared
  // radius; conductivity is the thickness-weighted harmonic mean of the two
  // shells' conductivities (correct for series conduction across dissimilar
  // materials).
  //
  // conductivityModel:'simple' has fixed-per-shell k, so this is precomputed
  // once, same as always. 'metzger' has temperature-dependent k, so only the
  // temperature-INDEPENDENT geometry is precomputed here; radialConductanceNow
  // combines it with fresh k values every call.
  const radialGeom = [];
  const radialConductance = useMetzger ? null : [];
  for (let i = 0; i < nLat; i++) {
    const geomArr = [];
    const arr = useMetzger ? null : new Float64Array(nDepth - 1);
    for (let j = 0; j < nDepth - 1; j++) {
      const rFace = depthRadii[j + 1];
      const faceArea = 2 * Math.PI * rFace * rFace * (Math.sin(latEdges[i + 1] * Math.PI / 180) - Math.sin(latEdges[i] * Math.PI / 180));
      const dr1 = depthRadii[j] - depthRadii[j + 1];
      const dr2 = depthRadii[j + 1] - depthRadii[j + 2];
      const dTotal = dr1 / 2 + dr2 / 2;
      geomArr.push({ faceArea, dr1, dr2, dTotal });
      if (!useMetzger) {
        const k1 = shellK[j], k2 = shellK[j + 1];
        const kHarmonic = dTotal / ((dr1 / 2) / k1 + (dr2 / 2) / k2);
        arr[j] = (kHarmonic * faceArea) / dTotal;
      }
    }
    radialGeom.push(geomArr);
    if (!useMetzger) radialConductance.push(arr);
  }

  function radialConductanceNow(i, j, T) {
    const g = radialGeom[i][j];
    const k1 = metzgerConductivity(shellPorosity[j], T[i][j]);
    const k2 = metzgerConductivity(shellPorosity[j + 1], T[i][j + 1]);
    const kHarmonic = g.dTotal / ((g.dr1 / 2) / k1 + (g.dr2 / 2) / k2);
    return (kHarmonic * g.faceArea) / g.dTotal;
  }

  // Meridional conductances between latitude band i and i+1 (same depth
  // shell j). Face is the cone at the shared colatitude boundary, from
  // rInner to rOuter of shell j. Both cells share the same depth (and so,
  // for 'metzger', the same porosity) — they can still differ in
  // temperature (equator vs. pole), so meridionalConductanceNow averages
  // the two cells' local k rather than needing a harmonic mean across
  // dissimilar materials the way the radial case does.
  const meridionalGeom = [];
  const meridionalConductance = useMetzger ? null : [];
  for (let i = 0; i < nLat - 1; i++) {
    const geomArr = new Array(nDepth);
    const arr = useMetzger ? null : new Float64Array(nDepth);
    const thetaBoundaryDeg = latEdges[i + 1];
    const sinThetaBoundary = Math.cos((thetaBoundaryDeg * Math.PI) / 180); // colatitude sin = cos(latitude)
    for (let j = 0; j < nDepth; j++) {
      const rOuter = depthRadii[j], rInner = depthRadii[j + 1];
      const faceArea = Math.PI * sinThetaBoundary * (rOuter * rOuter - rInner * rInner);
      const rMid = (rOuter + rInner) / 2;
      const dLat = ((latEdges[i + 1] + (i + 2 <= nLat ? latEdges[i + 2] : latEdges[i + 1])) / 2 -
                    (latEdges[i] + latEdges[i + 1]) / 2) * Math.PI / 180;
      const dist = Math.max(rMid * Math.abs(dLat), 1e-6);
      geomArr[j] = { faceArea, dist };
      if (!useMetzger) arr[j] = (shellK[j] * faceArea) / dist;
    }
    meridionalGeom.push(geomArr);
    if (!useMetzger) meridionalConductance.push(arr);
  }

  function meridionalConductanceNow(i, j, T) {
    const g = meridionalGeom[i][j];
    const k1 = metzgerConductivity(shellPorosity[j], T[i][j]);
    const k2 = metzgerConductivity(shellPorosity[j], T[i + 1][j]);
    return ((k1 + k2) / 2 * g.faceArea) / g.dist;
  }

  // Outer-face area per latitude band (for solar + radiative surface terms).
  const outerFaceArea = new Float64Array(nLat);
  for (let i = 0; i < nLat; i++) {
    outerFaceArea[i] = 2 * Math.PI * p.radius * p.radius * (Math.sin(latEdges[i + 1] * Math.PI / 180) - Math.sin(latEdges[i] * Math.PI / 180));
  }

  // Temperature field: T[i][j], initialized uniformly (caller can override).
  let T = [];
  for (let i = 0; i < nLat; i++) T.push(new Float64Array(nDepth).fill(200));

  function setUniformTemperature(kelvin) {
    for (let i = 0; i < nLat; i++) T[i].fill(kelvin);
  }

  /** Solar flux incident on latitude band i's outer face at simulated time t (s), before albedo. */
  function incidentFlux(latRad, tSec) {
    const hourAngle = (2 * Math.PI * tSec) / p.rotationPeriodSec;
    const obliquityRad = (p.obliquityDeg * Math.PI) / 180;
    const seasonPhase = (2 * Math.PI * tSec) / p.orbitalPeriodSec;
    const declination = obliquityRad * Math.sin(seasonPhase);
    const cosZenith = Math.sin(latRad) * Math.sin(declination) + Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);
    return Math.max(0, cosZenith) * p.solarConstant;
  }

  /** One explicit forward-Euler timestep of length dt (s). Mutates T in place. */
  function step(dt, tSec) {
    const dTdt = [];
    for (let i = 0; i < nLat; i++) dTdt.push(new Float64Array(nDepth));

    // Radial conduction.
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nDepth - 1; j++) {
        const g = useMetzger ? radialConductanceNow(i, j, T) : radialConductance[i][j];
        const q = g * (T[i][j + 1] - T[i][j]); // + = into cell j from below
        dTdt[i][j] += q;
        dTdt[i][j + 1] -= q;
      }
    }
    // Meridional conduction.
    for (let i = 0; i < nLat - 1; i++) {
      for (let j = 0; j < nDepth; j++) {
        const g = useMetzger ? meridionalConductanceNow(i, j, T) : meridionalConductance[i][j];
        const q = g * (T[i + 1][j] - T[i][j]);
        dTdt[i][j] += q;
        dTdt[i + 1][j] -= q;
      }
    }
    // Surface radiative + solar balance, applied to the outermost shell (j=0) of each band.
    for (let i = 0; i < nLat; i++) {
      const absorbed = (1 - p.albedo) * incidentFlux(latCenterRad[i], tSec) * outerFaceArea[i];
      const emitted = p.emissivity * STEFAN_BOLTZMANN * Math.pow(T[i][0], 4) * outerFaceArea[i];
      dTdt[i][0] += absorbed - emitted;
    }

    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nDepth; j++) {
        T[i][j] += (dTdt[i][j] / heatCapacity[i][j]) * dt;
      }
    }
  }

  /**
   * Conservative explicit stability limit (approximate — thinnest/hottest
   * cell governs). Radiative loss (εσT⁴) is nonlinear, but for stability
   * purposes it acts like an extra conductance of magnitude 4εσT³ — this is
   * *not* negligible next to conduction: at typical lunar dayside
   * temperatures it's several times larger than the conduction term for the
   * thin surface cell. Without it, an explicit step can overshoot the
   * radiative equilibrium and blow up in a handful of steps (this was
   * observed directly in testing — T went to -Infinity/NaN within 7 steps
   * using a conduction-only stability estimate).
   *
   * Because T changes over the run (and radiative conductance grows with
   * T³), this should be recomputed periodically against the *current*
   * field rather than trusted from an initial guess — an extra margin
   * (referenceMaxTempMargin) is added on top of the current hottest cell to
   * cover further heating before the next recompute.
   */
  function stableTimestep(safety = 0.4, referenceMaxTempMargin = 50) {
    let minTau = Infinity;
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nDepth; j++) {
        let gSum = 0;
        if (j > 0) gSum += useMetzger ? radialConductanceNow(i, j - 1, T) : radialConductance[i][j - 1];
        if (j < nDepth - 1) gSum += useMetzger ? radialConductanceNow(i, j, T) : radialConductance[i][j];
        if (i > 0) gSum += useMetzger ? meridionalConductanceNow(i - 1, j, T) : meridionalConductance[i - 1][j];
        if (i < nLat - 1) gSum += useMetzger ? meridionalConductanceNow(i, j, T) : meridionalConductance[i][j];
        if (j === 0) {
          const refT = T[i][0] + referenceMaxTempMargin;
          gSum += 4 * p.emissivity * STEFAN_BOLTZMANN * Math.pow(refT, 3) * outerFaceArea[i];
        }
        if (gSum <= 0) continue;
        const tau = heatCapacity[i][j] / gSum;
        if (tau < minTau) minTau = tau;
      }
    }
    return minTau * safety;
  }

  return {
    params: p,
    depthRadii,
    latEdges,
    latCenterRad,
    nLat,
    nDepth,
    heatCapacity,
    get T() { return T; },
    setUniformTemperature,
    setTemperatureField(field) { T = field; },
    incidentFlux,
    step,
    stableTimestep,
  };
}

/**
 * Accelerated convergence toward periodic steady state.
 *
 * Same model, same equations, same domain throughout — this only changes
 * *how* the periodic steady state of that model is found, not the model
 * itself, so a run using acceleration and a run using brute-force
 * time-marching converge to the same answer; acceleration just gets there
 * in far fewer simulated rotation periods.
 *
 * Strategy: run a handful of real rotation periods ("heal"), sample each
 * cell's temperature at the same phase each period, and once there are
 * three successive samples, use Aitken's delta-squared extrapolation to
 * estimate each cell's asymptotic value and jump partway there (damped,
 * to avoid overshoot if the trend isn't cleanly exponential yet — e.g. the
 * near-surface cells, which are already near their own periodic steady
 * state almost immediately and whose "trend" is mostly noise). Repeat.
 *
 * Call runOneBatch() from a requestAnimationFrame loop (or similar) so the
 * page can render the live state after every batch — the convergence
 * process itself is the "watch it evolve" visualization, not a separate
 * animation layered on top.
 */
export function createConvergenceDriver(model, options = {}) {
  const periodsPerHeal = options.periodsPerHeal ?? 4;
  const jumpDamping = options.jumpDamping ?? 0.85;
  // Recompute every step, not once at driver creation. Radiative
  // conductance grows with T^3, and a body starting from an arbitrary
  // uniform temperature (or one that just got an extrapolation jump) can
  // heat up substantially within a single period — especially for short
  // rotation periods — so a timestep sized for the *current* temperature
  // can go unstable well before the period ends if it isn't re-checked.
  const dtRecomputeEvery = options.dtRecomputeEvery ?? 1;
  let tSec = 0;
  let periodsCompleted = 0;
  let phaseSamples = [];

  function cloneField(T) {
    return T.map((row) => Float64Array.from(row));
  }

  function runOnePeriod() {
    const period = model.params.rotationPeriodSec;
    let dt = model.stableTimestep();
    let elapsed = 0;
    let stepIndex = 0;
    while (elapsed < period) {
      if (stepIndex % dtRecomputeEvery === 0) dt = model.stableTimestep();
      const thisDt = Math.min(dt, period - elapsed);
      model.step(thisDt, tSec);
      tSec += thisDt;
      elapsed += thisDt;
      stepIndex += 1;
    }
    periodsCompleted += 1;
    phaseSamples.push(cloneField(model.T));
    if (phaseSamples.length > 3) phaseSamples.shift();
  }

  function extrapolateAndJump() {
    if (phaseSamples.length < 3) return false;
    const [T0, T1, T2] = phaseSamples;
    const current = model.T;
    let anyJump = false;
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        const a = T0[i][j], b = T1[i][j], c = T2[i][j];
        const denom = c - 2 * b + a;
        if (Math.abs(denom) > 1e-9) {
          const extrap = c - ((c - b) * (c - b)) / denom;
          current[i][j] = b + jumpDamping * (extrap - b);
          anyJump = true;
        }
      }
    }
    phaseSamples = [];
    return anyJump;
  }

  function runOneBatch() {
    for (let k = 0; k < periodsPerHeal; k++) runOnePeriod();
    const jumped = extrapolateAndJump();
    return { periodsCompleted, jumped, tSec };
  }

  // Chunked stepping for interactive/animated use: advances roughly
  // `targetChunkSec` of simulated time in small physics steps, calling
  // onStep(tSec) after every individual step (so a caller can record fine-
  // grained history — e.g. for reconstructing the spinning globe — even
  // during the accelerated convergence phase, not just during a final
  // clean-sampling pass). Extrapolation is applied automatically at the
  // same cadence as runOneBatch (every periodsPerHeal periods), so
  // repeated stepChunk() calls converge identically to runOneBatch(), just
  // in caller-controlled increments small enough to yield back to the
  // browser between them for visible animation.
  let elapsedInPeriod = 0;
  function stepChunk(targetChunkSec, onStep) {
    let chunkElapsed = 0;
    let periodJustCompleted = false;
    while (chunkElapsed < targetChunkSec) {
      const dt = model.stableTimestep();
      const period = model.params.rotationPeriodSec;
      const thisDt = Math.min(dt, period - elapsedInPeriod, targetChunkSec - chunkElapsed);
      model.step(thisDt, tSec);
      tSec += thisDt;
      chunkElapsed += thisDt;
      elapsedInPeriod += thisDt;
      if (onStep) onStep(tSec);
      if (elapsedInPeriod >= period - 1e-6) {
        elapsedInPeriod = 0;
        periodsCompleted += 1;
        periodJustCompleted = true;
        phaseSamples.push(cloneField(model.T));
        if (phaseSamples.length > 3) phaseSamples.shift();
        if (periodsCompleted % periodsPerHeal === 0) extrapolateAndJump();
      }
    }
    return { periodsCompleted, periodJustCompleted, tSec };
  }

  return {
    runOnePeriod,
    runOneBatch,
    stepChunk,
    get periodsCompleted() { return periodsCompleted; },
    get tSec() { return tSec; },
    get dt() { return dt; },
  };
}

/**
 * Reconstructs the full spinning-globe temperature map from the single
 * co-rotating column this model actually simulates. By rotational
 * symmetry (see the module doc comment), every longitude's temperature
 * history is just a time-shifted copy of the one simulated column's — so
 * the surface temperature "now" at longitude λ is exactly what the column
 * showed (rotationPeriod × λ/360) seconds ago. This records a rolling
 * window of the column's surface state (slightly more than one rotation
 * period) and interpolates lookups against it, rather than the model ever
 * needing to represent multiple longitudes directly.
 */
export function createSurfaceHistoryRecorder(model, windowPeriods = 1.15) {
  const windowSec = model.params.rotationPeriodSec * windowPeriods;
  const samples = []; // { tSec, surface: Float64Array(nLat) }

  function record(tSec) {
    const surface = new Float64Array(model.nLat);
    for (let i = 0; i < model.nLat; i++) surface[i] = model.T[i][0];
    samples.push({ tSec, surface });
    const cutoff = tSec - windowSec;
    while (samples.length > 2 && samples[1].tSec < cutoff) samples.shift();
  }

  function lookupSecondsAgo(latIndex, secondsAgo) {
    if (samples.length === 0) return null;
    const targetT = samples[samples.length - 1].tSec - secondsAgo;
    if (targetT <= samples[0].tSec) return samples[0].surface[latIndex];
    for (let k = samples.length - 1; k > 0; k--) {
      if (samples[k - 1].tSec <= targetT && targetT <= samples[k].tSec) {
        const a = samples[k - 1], b = samples[k];
        const f = (targetT - a.tSec) / (b.tSec - a.tSec || 1);
        return a.surface[latIndex] + f * (b.surface[latIndex] - a.surface[latIndex]);
      }
    }
    return samples[samples.length - 1].surface[latIndex];
  }

  // Sign convention: longitude increasing eastward, in the direction of
  // rotation, so a point at longitude λ is "λ/360 of a rotation behind"
  // the simulated column's current state. Verify against the rendered
  // sun direction when wiring up the globe — flip the sign here if the
  // subsolar point doesn't line up with the sun icon.
  function temperatureAtLongitude(latIndex, longitudeDeg) {
    const normalized = ((longitudeDeg % 360) + 360) % 360;
    const secondsAgo = (normalized / 360) * model.params.rotationPeriodSec;
    return lookupSecondsAgo(latIndex, secondsAgo);
  }

  return {
    record,
    lookupSecondsAgo,
    temperatureAtLongitude,
    get latestTSec() { return samples.length ? samples[samples.length - 1].tSec : 0; },
  };
}
