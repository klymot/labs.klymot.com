import { describe, it, expect } from 'vitest';
import {
  buildDepthGrid, buildLatitudeGrid, createModel, createConvergenceDriver,
  metzgerBulkDensity, metzgerPorosity, metzgerConductivity,
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
  });

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
  });
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
