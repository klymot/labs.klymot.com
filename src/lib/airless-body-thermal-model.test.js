import { describe, it, expect } from 'vitest';
import {
  buildDepthGrid, buildLatitudeGrid, createModel, createConvergenceDriver,
  metzgerBulkDensity, metzgerPorosity, metzgerConductivity,
  hemingwaySpecificHeat, DEFAULT_ORBITAL_PERIOD_SEC,
} from './airless-body-thermal-model.js';

const MOON_RADIUS = 1737400; // m

describe('buildDepthGrid', () => {
  it('starts at the surface and ends at the center', () => {
    const grid = buildDepthGrid(MOON_RADIUS, 2, 0.001, 1.6, 12);
    expect(grid[0]).toBe(MOON_RADIUS);
    expect(grid[grid.length - 1]).toBe(0);
  });

  it('is strictly decreasing (no zero-thickness or inverted shells)', () => {
    const grid = buildDepthGrid(MOON_RADIUS, 2, 0.001, 1.6, 12);
    for (let i = 1; i < grid.length; i++) {
      expect(grid[i]).toBeLessThan(grid[i - 1]);
    }
  });

  it('keeps the first cell thin, matching the requested surface cell thickness', () => {
    const grid = buildDepthGrid(MOON_RADIUS, 2, 0.001, 1.6, 12);
    expect(MOON_RADIUS - grid[1]).toBeCloseTo(0.001, 6);
  });
});

describe('buildLatitudeGrid', () => {
  it('spans -90 to 90 with the requested number of bands', () => {
    const edges = buildLatitudeGrid(10);
    expect(edges.length).toBe(11);
    expect(edges[0]).toBe(-90);
    expect(edges[edges.length - 1]).toBe(90);
  });
});

function moonParams(overrides = {}) {
  return {
    radius: MOON_RADIUS,
    albedo: 0.11,
    solarConstant: 1361,
    obliquityDeg: 1.54,
    rotationPeriodSec: 29.5 * 86400,
    regolithThickness: 2,
    regolithK: 0.0007,
    regolithRho: 1200,
    regolithC: 650,
    bulkK: 2,
    bulkRho: 3300,
    bulkC: 800,
    nLatBands: 12,
    coreCellCount: 6,
    ...overrides,
  };
}

describe('createModel', () => {
  it('latitude band solid-angle fractions sum to 1', () => {
    const model = createModel(moonParams());
    // Reconstruct fractions from heat capacities is indirect; instead check
    // outer-face areas sum to the full sphere's surface area.
    let totalArea = 0;
    for (let i = 0; i < model.nLat; i++) {
      const rOuter = model.depthRadii[0];
      const frac = (Math.sin(model.latEdges[i + 1] * Math.PI / 180) - Math.sin(model.latEdges[i] * Math.PI / 180)) / 2;
      totalArea += 4 * Math.PI * rOuter * rOuter * frac;
    }
    expect(totalArea).toBeCloseTo(4 * Math.PI * MOON_RADIUS * MOON_RADIUS, -3);
  });

  it('conserves total thermal energy under pure conduction with no solar input and no radiative loss', () => {
    // Zero out solar and radiative terms by using zero solar constant and
    // zero emissivity, isolating pure conduction, which must conserve
    // total heat capacity-weighted temperature (a closed system).
    const model = createModel(moonParams({ solarConstant: 0, nLatBands: 6, coreCellCount: 4 }));
    model.params.emissivity = 0;
    // Non-uniform initial condition so conduction actually has something to do.
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        model.T[i][j] = 200 + 10 * Math.sin(i) + 5 * Math.cos(j);
      }
    }
    const totalEnergyBefore = sumEnergy(model);
    const dt = model.stableTimestep();
    for (let s = 0; s < 500; s++) model.step(dt, s * dt);
    const totalEnergyAfter = sumEnergy(model);
    const relError = Math.abs(totalEnergyAfter - totalEnergyBefore) / Math.abs(totalEnergyBefore);
    expect(relError).toBeLessThan(1e-6);
  });

  it('does not produce NaN or non-physical temperatures under normal Moon-like parameters', () => {
    const model = createModel(moonParams({ nLatBands: 8, coreCellCount: 4 }));
    model.setUniformTemperature(250);
    const dt = model.stableTimestep();
    for (let s = 0; s < 2000; s++) {
      model.step(dt, s * dt);
    }
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
        expect(model.T[i][j]).toBeGreaterThan(0);
      }
    }
  });
});

describe('createConvergenceDriver', () => {
  it('advances periodsCompleted and keeps temperatures finite over several batches', () => {
    const model = createModel(moonParams({ nLatBands: 6, coreCellCount: 4 }));
    model.setUniformTemperature(250);
    const driver = createConvergenceDriver(model, { periodsPerHeal: 2 });
    for (let b = 0; b < 3; b++) driver.runOneBatch();
    expect(driver.periodsCompleted).toBe(6);
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
      }
    }
  }, 10000);

  it('keeps all temperatures finite and within a sane physical range over a long run (Aitken jump-rejection regression)', () => {
    // Regression test for a latent instability in extrapolateAndJump()'s
    // Aitken delta-squared jump: once a cell's period-over-period trend goes
    // nearly linear (tiny genuine curvature — e.g. a deep cell whose
    // temperature hasn't started changing yet, or one that's already nearly
    // converged), the second difference (c - 2b + a) can decay into
    // floating-point noise while still exceeding the near-zero-denom guard,
    // producing a wildly unphysical extrapolated jump that then poisons
    // neighboring cells via conduction. A finer grid (more depth shells, so
    // more deep, slow-to-respond cells) gives this failure mode room to
    // appear; without the proportionality/sane-range guards on the jump,
    // this exact configuration goes non-physical (a core cell overshooting
    // to roughly -6 K) within the very first acceleration batch.
    const model = createModel(moonParams({ nLatBands: 8, coreCellCount: 8 }));
    model.setUniformTemperature(250);
    const driver = createConvergenceDriver(model, { periodsPerHeal: 3 });

    const totalPeriods = 12;
    const batches = Math.ceil(totalPeriods / 3);
    for (let b = 0; b < batches; b++) {
      driver.runOneBatch();
      for (let i = 0; i < model.nLat; i++) {
        for (let j = 0; j < model.nDepth; j++) {
          const t = model.T[i][j];
          expect(Number.isFinite(t)).toBe(true);
          expect(t).toBeGreaterThan(1);
          expect(t).toBeLessThan(1000);
        }
      }
    }
  }, 20000);

  it('stepChunk advances periods and fires onStep for every physics step', () => {
    const model = createModel(moonParams({ nLatBands: 6, coreCellCount: 4 }));
    model.setUniformTemperature(250);
    const driver = createConvergenceDriver(model, { periodsPerHeal: 2 });
    let stepCount = 0;
    let lastTSec = 0;
    const period = model.params.rotationPeriodSec;
    const chunkSec = period / 20;
    for (let i = 0; i < 20 * 6; i++) {
      const result = driver.stepChunk(chunkSec, (tSec) => {
        stepCount += 1;
        lastTSec = tSec;
      });
    }
    expect(driver.periodsCompleted).toBe(6);
    expect(stepCount).toBeGreaterThan(0);
    expect(lastTSec).toBeCloseTo(driver.tSec, 0);
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
      }
    }
  }, 10000);
});

describe('Metzger conductivity model', () => {
  it('bulk density decreases toward the surface and approaches ~1920 kg/m^3 at depth', () => {
    expect(metzgerBulkDensity(0)).toBeCloseTo(1301, 0); // 1.92*12.2/18 g/cm^3 * 1000
    expect(metzgerBulkDensity(50)).toBeGreaterThan(1900); // z=5000cm, near the asymptote
    expect(metzgerBulkDensity(50)).toBeLessThan(1920);
  });

  it('porosity stays within the physically sane 0-1 range and decreases with depth', () => {
    const surface = metzgerPorosity(0);
    const deep = metzgerPorosity(10);
    expect(surface).toBeGreaterThan(0);
    expect(surface).toBeLessThan(1);
    expect(deep).toBeLessThan(surface);
  });

  it('conductivity is positive and increases with temperature (radiative contribution across pores)', () => {
    const v = metzgerPorosity(0.1);
    const kCold = metzgerConductivity(v, 100);
    const kHot = metzgerConductivity(v, 350);
    expect(kCold).toBeGreaterThan(0);
    expect(kHot).toBeGreaterThan(kCold);
  });

  it('conserves energy under pure conduction with no solar input and no radiative loss', () => {
    const model = createModel(moonParams({
      solarConstant: 0, nLatBands: 6, coreCellCount: 4, conductivityModel: 'metzger',
    }));
    model.params.emissivity = 0;
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        model.T[i][j] = 200 + 10 * Math.sin(i) + 5 * Math.cos(j);
      }
    }
    const totalEnergyBefore = sumEnergy(model);
    const dt = model.stableTimestep();
    for (let s = 0; s < 500; s++) model.step(dt, s * dt);
    const totalEnergyAfter = sumEnergy(model);
    const relError = Math.abs(totalEnergyAfter - totalEnergyBefore) / Math.abs(totalEnergyBefore);
    expect(relError).toBeLessThan(1e-6);
  });

  it('does not produce NaN or non-physical temperatures under normal Moon-like parameters', () => {
    const model = createModel(moonParams({ nLatBands: 8, coreCellCount: 4, conductivityModel: 'metzger' }));
    model.setUniformTemperature(250);
    const dt = model.stableTimestep();
    for (let s = 0; s < 2000; s++) {
      model.step(dt, s * dt);
    }
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
        expect(model.T[i][j]).toBeGreaterThan(0);
      }
    }
  });
});

function sumEnergy(model) {
  let total = 0;
  for (let i = 0; i < model.nLat; i++) {
    for (let j = 0; j < model.nDepth; j++) {
      total += model.heatCapacity[i][j] * model.T[i][j];
    }
  }
  return total;
}

describe('hemingwaySpecificHeat', () => {
  it('matches the published calorimetry at spot temperatures', () => {
    // Hemingway, Robie & Wilson (1973) Apollo sample values, via the
    // Hayne et al. (2017) Eq. A6 polynomial: ~250 J/(kg K) near 90 K,
    // ~770 near 300 K, ~850 near 350 K.
    expect(hemingwaySpecificHeat(90)).toBeGreaterThan(240);
    expect(hemingwaySpecificHeat(90)).toBeLessThan(270);
    expect(hemingwaySpecificHeat(300)).toBeGreaterThan(750);
    expect(hemingwaySpecificHeat(300)).toBeLessThan(790);
    expect(hemingwaySpecificHeat(350)).toBeGreaterThan(830);
    expect(hemingwaySpecificHeat(350)).toBeLessThan(870);
  });

  it('increases monotonically over the lunar temperature range and stays positive below it', () => {
    let prev = hemingwaySpecificHeat(40);
    expect(prev).toBeGreaterThan(0);
    for (let t = 50; t <= 400; t += 10) {
      const c = hemingwaySpecificHeat(t);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
    expect(hemingwaySpecificHeat(1)).toBeGreaterThan(0);
  });
});

describe('temperature-dependent specific heat mode', () => {
  it('does not produce NaN or non-physical temperatures (simple conductivity)', () => {
    const model = createModel(moonParams({ nLatBands: 8, coreCellCount: 4, specificHeatModel: 'hemingway1973' }));
    model.setUniformTemperature(250);
    for (let s = 0, t = 0; s < 2000; s++) {
      const dt = model.stableTimestep();
      model.step(dt, t);
      t += dt;
    }
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
        expect(model.T[i][j]).toBeGreaterThan(0);
      }
    }
  });

  it('does not produce NaN or non-physical temperatures (metzger conductivity)', () => {
    const model = createModel(moonParams({
      nLatBands: 8, coreCellCount: 4,
      conductivityModel: 'metzger', specificHeatModel: 'hemingway1973',
    }));
    model.setUniformTemperature(250);
    for (let s = 0, t = 0; s < 2000; s++) {
      const dt = model.stableTimestep();
      model.step(dt, t);
      t += dt;
    }
    for (let i = 0; i < model.nLat; i++) {
      for (let j = 0; j < model.nDepth; j++) {
        expect(Number.isFinite(model.T[i][j])).toBe(true);
        expect(model.T[i][j]).toBeGreaterThan(0);
      }
    }
  });

  it('cold cells respond faster than under constant specific heat (smaller heat capacity at low T)', () => {
    // At 100 K the polynomial gives ~290 J/(kg K) vs the constant 650 —
    // the same conducted heat should move a cold cell's temperature more.
    // Verified indirectly: the stability-limited timestep, which scales
    // with heat capacity, must be smaller for a uniformly cold body in
    // hemingway mode than in constant mode.
    const cold = 100;
    const constant = createModel(moonParams({ nLatBands: 6, coreCellCount: 4 }));
    const hemingway = createModel(moonParams({ nLatBands: 6, coreCellCount: 4, specificHeatModel: 'hemingway1973' }));
    constant.setUniformTemperature(cold);
    hemingway.setUniformTemperature(cold);
    expect(hemingway.stableTimestep()).toBeLessThan(constant.stableTimestep());
  });

  it('rejects an unknown specificHeatModel', () => {
    expect(() => createModel(moonParams({ specificHeatModel: 'nope' }))).toThrow();
  });
});

describe('seasonal (orbital) cycle', () => {
  it('defaults the declination cycle to one Earth year, independent of rotation period', () => {
    const model = createModel(moonParams({ rotationPeriodSec: 24 * 3600 }));
    expect(model.params.orbitalPeriodSec).toBe(DEFAULT_ORBITAL_PERIOD_SEC);
    expect(DEFAULT_ORBITAL_PERIOD_SEC).toBeCloseTo(365.25 * 86400, 6);
  });

  it('declination does not cycle with the solar day: noon flux at mid-latitude differs across the year', () => {
    // With the old rotation-tied default the subsolar latitude wobbled once
    // per day in phase with local noon, so noon flux repeated identically
    // every period. With a real year it should differ between a noon near
    // one solstice and a noon near the other, half a year apart.
    const model = createModel(moonParams());
    const latRad = (45 * Math.PI) / 180;
    const quarterYear = DEFAULT_ORBITAL_PERIOD_SEC / 4;
    const period = model.params.rotationPeriodSec;
    // Noon instants (multiples of the rotation period) nearest a quarter and
    // three quarters through the orbital year (max +/- declination).
    const noonNearSolstice1 = Math.round(quarterYear / period) * period;
    const noonNearSolstice2 = Math.round((3 * quarterYear) / period) * period;
    const f1 = model.incidentFlux(latRad, noonNearSolstice1);
    const f2 = model.incidentFlux(latRad, noonNearSolstice2);
    expect(Math.abs(f1 - f2)).toBeGreaterThan(1); // W/m^2 — clearly nonzero
  });
});

describe('minStepsPerRotation temporal floor', () => {
  it('caps the stable timestep for fast rotations and leaves slow rotations stability-limited', () => {
    const fast = createModel(moonParams({ rotationPeriodSec: 3600, minStepsPerRotation: 4000, nLatBands: 6, coreCellCount: 4 }));
    fast.setUniformTemperature(250);
    expect(fast.stableTimestep()).toBeLessThanOrEqual(3600 / 4000 + 1e-9);

    const slowCapped = createModel(moonParams({ minStepsPerRotation: 4000, nLatBands: 6, coreCellCount: 4 }));
    const slowUncapped = createModel(moonParams({ nLatBands: 6, coreCellCount: 4 }));
    slowCapped.setUniformTemperature(250);
    slowUncapped.setUniformTemperature(250);
    // 29.5 d / 4000 is far above this grid's stability limit, so the cap
    // must not change the slow rotation's timestep at all.
    expect(slowCapped.stableTimestep()).toBeCloseTo(slowUncapped.stableTimestep(), 9);
  });
});
