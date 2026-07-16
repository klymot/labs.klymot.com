// Shared interactive driver for the two Error Bars labs (Temperature and
// Sunshine). The pages are deliberate siblings — same skeleton, different
// variable — so everything except markup text and data loading lives here,
// configured per page. Both pages provide the same DOM element ids; the
// temperature page additionally has the dataset-version (QCU/QCF) blocking
// choice, enabled via config.datasets.
//
// Bias rules honoured here (see STYLE-GUIDE.md):
// - site cards, dataset cards, and target cards render in random order;
// - which series gets which colour, and legend order, are randomized per
//   visit and never stored in the URL;
// - the initial aggregation and coverage level are randomized per visit;
// - nothing about the difference is shown before the reader constructs it.

import { sendFeatureBeacon } from './analytics.js';
import { cssVar, clamp } from './lab-utils.js';
import { createSectionTracker } from './lab-sections.js';
import { MONTHS, niceStep } from '../../public/js/chart-fns.js';
import {
  COVERAGE_LEVELS,
  buildHistogram,
  differences,
  empiricalBand,
  summarizeDiffs,
  transferCoverage,
} from './error-bars-stats.js';

const BU_2020_SPRITE = {
  url: 'https://www.klymot.com/assets/bu_2020_sprite.png',
  cell: 32,
  cols: 128,
  rows: 219,
  zoom: 2,
};

export function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function fmtBu(v) {
  return v == null ? '—' : `${v.toFixed(v < 10 ? 1 : 0)}%`;
}

export function bu2020TileStyle(idx) {
  if (idx == null) return '';
  const { url, cell, cols, rows, zoom } = BU_2020_SPRITE;
  const display = cell * zoom;
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  return [
    `width:${display}px`,
    `height:${display}px`,
    `background-image:url('${url}')`,
    `background-size:${cols * display}px ${rows * display}px`,
    `background-position:${-(col * display)}px ${-(row * display)}px`,
    'background-repeat:no-repeat',
  ].join(';');
}

/* Fractional-year x position for a pair key ("YYYY", "YYYY-MM",
 * "YYYY-MM-DD", or "YYYY-SEASON"). */
const SEASON_X = { DJF: 0.125, MAM: 0.375, JJA: 0.625, SON: 0.875 };
export function keyToX(key) {
  const year = Number(key.slice(0, 4));
  if (key.length === 4) return year + 0.5;
  const rest = key.slice(5);
  if (SEASON_X[rest] != null) return year + SEASON_X[rest];
  const month = Number(key.slice(5, 7));
  if (key.length === 7) return year + (month - 0.5) / 12;
  const day = Number(key.slice(8, 10));
  return year + (month - 1) / 12 + (day - 0.5) / 366;
}

/**
 * @param {{
 *   beacons: {siteSelected: string, datasetSelected?: string,
 *             differenceBuilt: string, bandFrozen: string,
 *             transferRevealed: string},   — funnel step names incl. numbers
 *   funnelPrefix: string,                  — e.g. 'labs/error-bars-temperature'
 *   sites: Array<object>,                  — pool; each needs id/name + card fields
 *   datasets?: Array<{key: string, label: string, desc: string}>,
 *   aggregations: Array<{key: string, label: string}>,
 *   unit: string,                          — y-axis / readout unit, e.g. '°C'
 *   valueDecimals: number,
 *   diffDecimals: number,
 *   seriesNames: {measured: string, modelled: string},
 *   cardHtml: (site) => string,            — inner HTML for a site card
 *   siteInfoHtml: (site) => string,        — pills under the grid
 *   loadPairs: (site, datasetKey) => Promise<{[aggKey]: Array<{key,a,b}>}>,
 *   sectionIds: Array<{id: string, headingId: string|null}>,
 * }} config
 */
export function initErrorBarsLab(config) {
  const AGG_KEYS = config.aggregations.map((a) => a.key);
  const hasDatasets = Boolean(config.datasets && config.datasets.length);
  // The available record versions can vary by site: a normal station offers
  // QCU/QCF, a composite offers Spliced/Raw. Falls back to the global set.
  const datasetsForSite = (site) =>
    (site && config.datasetsForSite && config.datasetsForSite(site)) || config.datasets || [];

  /* ── State ─────────────────────────────────────────────────────────── */
  let siteId = null;          // blocking choice 1
  let datasetKey = null;      // blocking choice 2 (temperature only)
  let agg = null;             // non-blocking, randomized initial value
  let subset = 'all';         // non-blocking time-of-year filter (see below)
  let coverage = null;        // non-blocking, randomized initial value
  let pairsByAgg = null;      // for the calibration site
  let differenceBuilt = false;
  let frozen = null;          // {agg, coverage, lo, hi, n}
  let targetId = null;
  let revealed = false;
  let targetPairsByAgg = null;
  let scorecard = [];         // [{siteId, inside, n, fraction}]
  const pairsCache = new Map();

  const sentBeacons = new Set();
  let sectionTracker = null;
  let restoring = false;

  // Randomized per visit, never stored: which series gets which colour and
  // which is listed first in keys/tooltips.
  const colorVars = shuffleArray(['--accent', '--series-obs']);
  const seriesOrder = shuffleArray(['measured', 'modelled']);
  const seriesColor = {
    measured: () => cssVar(colorVars[0]) || '#d4a855',
    modelled: () => cssVar(colorVars[1]) || '#5090f8',
  };
  const BAND_LEGEND_COLOR = 'rgba(80,144,248,0.8)';

  // Legend toggles (display-only, both series start visible).
  const seriesVisible = { measured: true, modelled: true };
  const transferVisible = { modelled: true, band: true, measured: true };

  function legendButton(kind, label, color, visible) {
    return `<button type="button" class="legend-btn${visible ? '' : ' series-off'}" data-series-toggle="${kind}"` +
      (visible ? ` style="border-color:${color};color:${color}"` : '') +
      `>${label}</button>`;
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

  const els = {};
  [
    'siteGrid', 'siteInfo', 'sitePrompt',
    'datasetGrid', 'datasetChosenBanner', 'datasetChosenLabel', 'datasetPrompt',
    'pairedChart', 'pairedChartContainer', 'pairedChartTitle', 'pairedTooltip', 'pairedChartLoading', 'pairedKey',
    'readoutSpan', 'readoutPeriods', 'readoutAgg',
    'subsetRow', 'subsetButtons',
    'buildDifference', 'buildDifferenceHint',
    'diffChart', 'diffChartContainer', 'diffChartTitle', 'diffTooltip', 'diffKey',
    'histChart', 'histChartContainer', 'histChartTitle', 'histTooltip',
    'diffN', 'diffMean', 'diffMedian', 'bandRange',
    'freezeBand', 'freezeBandHint', 'frozenBanner', 'frozenLabel',
    'targetGrid', 'targetPrompt',
    'transferChart', 'transferChartContainer', 'transferChartTitle', 'transferTooltip', 'transferChartLoading', 'transferKey',
    'revealMeasured', 'revealMeasuredHint', 'transferTally',
    'scorecardBody', 'pairsTable', 'resetLab',
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const sections = {
    dataset: document.getElementById('dataset'),
    explore: document.getElementById('explore'),
    diffPrompt: document.getElementById('diff-prompt'),
    difference: document.getElementById('difference'),
    transfer: document.getElementById('transfer'),
  };

  function siteById(id) {
    return config.sites.find((s) => s.id === id) || null;
  }

  // Loop-based extent — daily aggregations can hold tens of thousands of
  // values, more than Math.min(...values) can safely take as arguments.
  function extentOf(values) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo, hi };
  }

  function fmtVal(v) {
    return v.toFixed(config.valueDecimals);
  }

  function fmtDiff(v) {
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(config.diffDecimals)}`;
  }

  function aggLabel(key) {
    const a = config.aggregations.find((x) => x.key === key);
    return a ? a.label : key;
  }

  /* ── Time-of-year subset filter ────────────────────────────────────── */
  // Pooling every month or season into one distribution treats times of
  // year with different typical difference sizes as interchangeable. The
  // filter lets the reader build everything — series view, distribution,
  // band, and transfer test — from a single calendar month (daily/monthly
  // averaging) or season (seasonal averaging) instead. 'all' = pooled.
  const SEASON_KEYS = ['DJF', 'MAM', 'JJA', 'SON'];
  // Meteorological quarters map to opposite seasons across the equator, so the
  // familiar season name for a DJF/MAM/JJA/SON block depends on the station's
  // hemisphere. Keyed by month-block; the southern set is the northern one
  // shifted half a year.
  const SEASON_NAMES_NORTH = { DJF: 'winter', MAM: 'spring', JJA: 'summer', SON: 'autumn' };
  const SEASON_NAMES_SOUTH = { DJF: 'summer', MAM: 'autumn', JJA: 'winter', SON: 'spring' };
  const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function seasonName(key) {
    const site = siteById(siteId);
    const lat = site && site.lat;
    if (typeof lat !== 'number') return null;
    return (lat < 0 ? SEASON_NAMES_SOUTH : SEASON_NAMES_NORTH)[key] || null;
  }

  function subsetOptionsFor(aggKey) {
    if (aggKey === 'annual') return ['all'];
    const specific = aggKey === 'seasonal'
      ? [...SEASON_KEYS]
      : MONTHS.map((_, i) => `m${i + 1}`);
    // Pooling every month/season into one distribution ('all') mixes times of
    // year that disagree with the model by different amounts. A lab can opt out
    // of offering that pooled view with poolTimeOfYear: false, leaving only the
    // like-with-like single-month/season comparisons; annual stays whole-year.
    return config.poolTimeOfYear === false ? specific : ['all', ...specific];
  }

  function subsetLabel(key) {
    if (key === 'all') return 'All';
    if (key.startsWith('m')) return MONTHS[Number(key.slice(1)) - 1];
    return key;
  }

  // Toggle-button label: seasons carry their hemisphere name ("DJF (winter)");
  // months stay compact ("Jun"). Prose/aria use the plain subsetLabel to avoid
  // nesting parens (e.g. "seasonal (DJF)" not "seasonal (DJF (winter))").
  function subsetButtonLabel(key) {
    const name = key === 'all' || key.startsWith('m') ? null : seasonName(key);
    return name ? `${subsetLabel(key)} (${name})` : subsetLabel(key);
  }

  function matchesSubset(pairKey, aggKey, subsetKey) {
    if (subsetKey === 'all') return true;
    if (aggKey === 'seasonal') return pairKey.slice(5) === subsetKey;
    return Number(pairKey.slice(5, 7)) === Number(subsetKey.slice(1));
  }

  function filterPairs(pairs, aggKey, subsetKey) {
    if (!pairs || subsetKey === 'all') return pairs;
    return pairs.filter((p) => matchesSubset(p.key, aggKey, subsetKey));
  }

  // e.g. "monthly", "monthly (Jun)", "seasonal (DJF)"
  function aggSubsetLabel(aggKey, subsetKey) {
    const base = aggLabel(aggKey).toLowerCase();
    return subsetKey === 'all' ? base : `${base} (${subsetLabel(subsetKey)})`;
  }

  function currentPairs() {
    if (!pairsByAgg) return null;
    return filterPairs(pairsByAgg[agg] || [], agg, subset);
  }

  /* ── Zoom / pan view state ─────────────────────────────────────────── */
  // One shared x-view for the paired and difference charts (they show the
  // same axis and stay in sync), one for the transfer chart. A view of null
  // means "full extent". Zooming is presentation only — the distribution,
  // band, and tally always use the full overlap.
  const MIN_VIEW_SPAN_YEARS = 1;
  let viewCal = null;
  let viewTransfer = null;

  function seriesExtentX(pairs) {
    if (!pairs || !pairs.length) return null;
    return { lo: keyToX(pairs[0].key), hi: keyToX(pairs[pairs.length - 1].key) };
  }

  function extentXFor(which) {
    return seriesExtentX(which === 'cal' ? currentPairs() : targetPairs());
  }

  function clampView(view, ext) {
    const extSpan = ext.hi - ext.lo;
    const span = Math.min(Math.max(view.hi - view.lo, Math.min(MIN_VIEW_SPAN_YEARS, extSpan)), extSpan);
    const lo = clamp(view.lo, ext.lo, ext.hi - span);
    return { lo, hi: lo + span };
  }

  function resolveView(rawView, ext) {
    if (!ext) return null;
    if (!rawView) return ext;
    const v = clampView(rawView, ext);
    return v.hi - v.lo >= ext.hi - ext.lo - 1e-9 ? ext : v;
  }

  function setView(which, view, { fromRestore = false } = {}) {
    const ext = extentXFor(which);
    if (!ext) return;
    let next = view ? clampView(view, ext) : null;
    if (next && next.hi - next.lo >= ext.hi - ext.lo - 1e-9) next = null;
    if (which === 'cal') {
      viewCal = next;
      drawPairedChart();
      drawDiffChart();
    } else {
      viewTransfer = next;
      drawTransferChart();
    }
    if (!fromRestore) schedulePushState();
  }

  function navChart(which, action) {
    const ext = extentXFor(which);
    if (!ext) return;
    if (action === 'reset') { setView(which, null); return; }
    const cur = resolveView(which === 'cal' ? viewCal : viewTransfer, ext);
    const span = cur.hi - cur.lo;
    const mid = (cur.lo + cur.hi) / 2;
    if (action === 'zoom-in') {
      const s = span / 1.25;
      setView(which, { lo: mid - s / 2, hi: mid + s / 2 });
    } else if (action === 'zoom-out') {
      const s = span * 1.25;
      setView(which, { lo: mid - s / 2, hi: mid + s / 2 });
    } else if (action === 'pan-left') {
      setView(which, { lo: cur.lo - span * 0.25, hi: cur.hi - span * 0.25 });
    } else if (action === 'pan-right') {
      setView(which, { lo: cur.lo + span * 0.25, hi: cur.hi + span * 0.25 });
    }
  }

  function visibleWithin(pairs, view, gapX) {
    const out = pairs.filter((p) => {
      const x = keyToX(p.key);
      return x >= view.lo - gapX && x <= view.hi + gapX;
    });
    return out.length ? out : pairs;
  }

  function wireDragPan(canvas, which, getLayout, tooltip) {
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      const layout = getLayout();
      const ext = extentXFor(which);
      if (!layout || !layout.view || !ext) return;
      if (layout.view.hi - layout.view.lo >= ext.hi - ext.lo - 1e-9) return; // not zoomed
      drag = {
        startPx: e.clientX,
        startView: { ...layout.view },
        pxPerYear: layout.cW / (layout.view.hi - layout.view.lo),
      };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      tooltip.hidden = true;
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dYears = (drag.startPx - e.clientX) / drag.pxPerYear;
      setView(which, {
        lo: drag.startView.lo + dYears,
        hi: drag.startView.hi + dYears,
      });
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  /* ── URL state ─────────────────────────────────────────────────────── */
  function readStateFromUrl() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    if (hash && params.get('v') !== '1') return {};
    const c = parseFloat(params.get('c') || '');
    const fc = parseFloat(params.get('fc') || '');
    const parseView = (raw) => {
      if (!raw) return null;
      const [lo, hi] = raw.split('~').map(parseFloat);
      return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { lo, hi } : null;
    };
    return {
      vx: parseView(params.get('vx')),
      tvx: parseView(params.get('tvx')),
      sub: params.get('sub') || null,
      fsu: params.get('fsu') || null,
      s: params.get('s') || null,
      d: params.get('d') || null,
      a: params.get('a') || null,
      c: Number.isFinite(c) ? c : null,
      df: params.get('df') === '1',
      fa: params.get('fa') || null,
      fc: Number.isFinite(fc) ? fc : null,
      t: params.get('t') || null,
      r: params.get('r') === '1',
      sec: params.get('sec') || null,
    };
  }

  function pushStateToUrl() {
    if (restoring) return;
    const params = new URLSearchParams();
    params.set('v', '1');
    if (siteId) params.set('s', siteId);
    if (hasDatasets && datasetKey) params.set('d', datasetKey);
    if (agg) params.set('a', agg);
    if (subset !== 'all') params.set('sub', subset);
    if (coverage != null) params.set('c', String(coverage));
    if (differenceBuilt) params.set('df', '1');
    if (frozen) {
      params.set('fa', frozen.agg);
      params.set('fc', String(frozen.coverage));
      if (frozen.subset !== 'all') params.set('fsu', frozen.subset);
    }
    if (targetId) params.set('t', targetId);
    if (revealed) params.set('r', '1');
    if (sectionTracker && sectionTracker.getCurrentSectionId()) {
      params.set('sec', sectionTracker.getCurrentSectionId());
    }
    if (viewCal) params.set('vx', `${viewCal.lo.toFixed(2)}~${viewCal.hi.toFixed(2)}`);
    if (viewTransfer) params.set('tvx', `${viewTransfer.lo.toFixed(2)}~${viewTransfer.hi.toFixed(2)}`);
    const hash = '#' + params.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  // Dragging a zoomed chart generates state changes far faster than the URL
  // needs them.
  let pushStateTimer = null;
  function schedulePushState() {
    if (pushStateTimer) clearTimeout(pushStateTimer);
    pushStateTimer = setTimeout(() => { pushStateTimer = null; pushStateToUrl(); }, 200);
  }

  /* ── Generic canvas helpers ────────────────────────────────────────── */
  function setupCanvas(container, canvas) {
    const W = container.clientWidth || 600;
    const H = container.clientHeight || 260;
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

  function yearTickStep(minX, maxX) {
    const span = Math.max(1, maxX - minX);
    const rawStep = Math.ceil(span / 6);
    return [1, 2, 5, 10, 20, 25, 50, 100].find((step) => step >= rawStep) || 100;
  }

  function drawFrame(ctx, W, H, pad, xLo, xHi, yLo, yHi, yUnit) {
    const textColor = cssVar('--text-secondary') || '#a8a090';
    const gridColor = 'rgba(212,168,85,0.12)';
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const xp = (x) => pad.left + ((x - xLo) / Math.max(1e-9, xHi - xLo)) * cW;
    const yp = (y) => pad.top + (1 - (y - yLo) / Math.max(1e-9, yHi - yLo)) * cH;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (cH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();
      const v = yHi - (yHi - yLo) * (i / 4);
      ctx.textAlign = 'right';
      ctx.fillText(`${v.toFixed(1)}${yUnit ? ' ' + yUnit : ''}`, pad.left - 6, y + 4);
    }
    ctx.textAlign = 'center';
    const step = yearTickStep(xLo, xHi);
    for (let yr = Math.ceil(xLo / step) * step; yr <= xHi; yr += step) {
      ctx.fillText(String(yr), xp(yr), H - 8);
    }
    return { xp, yp, cW, cH };
  }

  // Polyline with gaps whenever consecutive points are further apart than
  // ~1.5 aggregation steps.
  function drawSeries(ctx, pts, xp, yp, color, gapX, width = 1.4) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let prevX = null;
    pts.forEach((p) => {
      if (prevX === null || p.x - prevX > gapX) ctx.moveTo(xp(p.x), yp(p.y));
      else ctx.lineTo(xp(p.x), yp(p.y));
      prevX = p.x;
    });
    ctx.stroke();
  }

  function gapForAgg(aggKey, subsetKey = 'all') {
    if (aggKey === 'daily') return 3 / 366 * 1.5 + 2 / 366;
    // With a single month/season selected, consecutive points are a year
    // apart — without the wider gap allowance every point would be isolated.
    if (aggKey === 'monthly') return subsetKey === 'all' ? 1.6 / 12 : 1.6;
    if (aggKey === 'seasonal') return subsetKey === 'all' ? 0.4 : 1.6;
    return 1.6;
  }

  function keyedTooltip(canvas, tooltip, getLayout, describe) {
    canvas.addEventListener('mousemove', (e) => {
      if (e.buttons) return; // dragging = panning, not inspecting
      const layout = getLayout();
      if (!layout || !layout.points || !layout.points.length) { tooltip.hidden = true; return; }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let best = null;
      let bestDist = Infinity;
      layout.points.forEach((p) => {
        const dx = Math.abs(x - layout.xp(p.x));
        if (dx < bestDist) { bestDist = dx; best = p; }
      });
      if (best && bestDist < 30) {
        tooltip.textContent = describe(best);
        tooltip.hidden = false;
        const ttW = tooltip.offsetWidth || 140;
        let left = x + 14;
        if (left + ttW > rect.width - 8) left = x - ttW - 14;
        tooltip.style.left = Math.max(4, left) + 'px';
        tooltip.style.top = '12px';
      } else {
        tooltip.hidden = true;
      }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  /* ── Paired series chart ───────────────────────────────────────────── */
  let pairedLayout = null;

  function drawPairedChart() {
    updatePairedTitle();
    const container = els.pairedChartContainer;
    const canvas = els.pairedChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const pairs = currentPairs();
    if (!pairs || !pairs.length) { pairedLayout = null; return; }

    const pad = { top: 16, right: 24, bottom: 36, left: 56 };
    const gapX = gapForAgg(agg, subset);
    const view = resolveView(viewCal, seriesExtentX(pairs));
    const visible = visibleWithin(pairs, view, gapX);
    const values = [];
    visible.forEach((p) => {
      if (seriesVisible.measured) values.push(p.a);
      if (seriesVisible.modelled) values.push(p.b);
    });
    // Both series toggled off: keep a stable frame from the full data.
    if (!values.length) visible.forEach((p) => { values.push(p.a, p.b); });
    const yExt = extentOf(values);
    const yPad = (yExt.hi - yExt.lo) * 0.08 || 0.5;
    const frame = drawFrame(ctx, W, H, pad, view.lo, view.hi,
      yExt.lo - yPad, yExt.hi + yPad, '');

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, frame.cW, frame.cH);
    ctx.clip();
    seriesOrder.filter((which) => seriesVisible[which]).forEach((which) => {
      const pts = visible.map((p) => ({ x: keyToX(p.key), y: which === 'measured' ? p.a : p.b, key: p.key }));
      drawSeries(ctx, pts, frame.xp, frame.yp, seriesColor[which](), gapX);
    });
    ctx.restore();

    pairedLayout = {
      xp: frame.xp,
      view,
      cW: frame.cW,
      points: visible.map((p) => ({ x: keyToX(p.key), key: p.key, a: p.a, b: p.b })),
    };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `${config.seriesNames.measured} and ${config.seriesNames.modelled}, ${aggSubsetLabel(agg, subset)} values, drawn together.`);
  }

  function updatePairedKey() {
    els.pairedKey.innerHTML = seriesOrder.map((which) =>
      legendButton(which, config.seriesNames[which], seriesColor[which](), seriesVisible[which])).join('');
  }

  /* ── Difference chart ──────────────────────────────────────────────── */
  let diffLayout = null;

  // Spell out the full month/season a slice refers to, e.g. "December",
  // "winter" (hemisphere-aware). Toggle buttons use the compact subsetLabel
  // ("Dec", "DJF (winter)"); chart titles use this fuller form.
  function subsetFullName(subsetKey) {
    if (subsetKey === 'all') return null;
    if (subsetKey.startsWith('m')) return MONTH_NAMES_FULL[Number(subsetKey.slice(1)) - 1];
    return seasonName(subsetKey);
  }

  // Describe the current averaging + time-of-year slice for a chart title, so a
  // screenshot is self-describing: "Annual", "Monthly (December)", "Seasonal
  // (winter)", "Daily (December)". The averaging word is always present, which
  // also keeps a lone month unambiguous where several averaging levels offer
  // one (e.g. both daily and monthly).
  function subsetDescriptor(aggKey = agg, subsetKey = subset) {
    if (!aggKey) return null;
    const full = subsetFullName(subsetKey);
    return full ? `${aggLabel(aggKey)} (${full})` : aggLabel(aggKey);
  }

  // Both chart titles read "<station> <verb> ERA5 reanalysis — <slice>", where
  // the base ("… vs …" for the paired chart, "… minus …" for the difference) is
  // a per-lab config function and the slice is the shared averaging descriptor.
  function chartTitle(el, baseFn) {
    if (!el || typeof baseFn !== 'function') return;
    const site = siteById(siteId);
    if (!site) return;
    const descriptor = subsetDescriptor();
    el.textContent = descriptor ? `${baseFn(site.name)} — ${descriptor}` : baseFn(site.name);
  }

  function updateDiffTitle() {
    chartTitle(els.diffChartTitle, config.diffTitle);
  }

  function updatePairedTitle() {
    chartTitle(els.pairedChartTitle, config.pairedTitle);
  }

  function updateHistTitle() {
    chartTitle(els.histChartTitle, config.histTitle);
  }

  // The transfer chart shows a different (target) station than the one the band
  // was built at, so its title names both — the target being tested, and the
  // calibration station plus slice the frozen band came from.
  function updateTransferTitle() {
    if (!els.transferChartTitle || !config.transferTitle) return;
    const target = siteById(targetId);
    // The band's provenance is the station it was frozen at, which may differ
    // from the currently-selected calibration station after an upstream change.
    const calibration = siteById(frozen ? frozen.siteId : siteId);
    els.transferChartTitle.textContent = config.transferTitle({
      target: target ? target.name : null,
      calibration: calibration ? calibration.name : null,
      coverage: frozen ? Math.round(frozen.coverage * 100) : null,
      slice: frozen ? subsetDescriptor(frozen.agg, frozen.subset) : null,
    });
  }

  function drawDiffChart() {
    updateDiffTitle();
    const container = els.diffChartContainer;
    const canvas = els.diffChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const pairs = currentPairs();
    if (!pairs || !pairs.length || !differenceBuilt) { diffLayout = null; return; }

    const pad = { top: 16, right: 24, bottom: 36, left: 56 };
    const gapX = gapForAgg(agg, subset);
    const view = resolveView(viewCal, seriesExtentX(pairs));
    const visible = visibleWithin(pairs, view, gapX);
    let extent = 1e-6;
    visible.forEach((p) => { extent = Math.max(extent, Math.abs(p.a - p.b)); });
    // Symmetric y-axis about zero so neither sign of disagreement is
    // visually exaggerated.
    const frame = drawFrame(ctx, W, H, pad, view.lo, view.hi, -extent * 1.08, extent * 1.08, '');

    // Band shading (only once frozen, and only at the frozen aggregation).
    // The band always comes from the full overlap, however far you zoom.
    if (frozen && frozen.agg === agg && frozen.subset === subset) {
      ctx.fillStyle = 'rgba(80,144,248,0.14)';
      const y0 = frame.yp(Math.min(frozen.hi, extent * 1.08));
      const y1 = frame.yp(Math.max(frozen.lo, -extent * 1.08));
      ctx.fillRect(pad.left, y0, frame.cW, Math.max(0, y1 - y0));
    }

    // Zero line
    ctx.strokeStyle = 'rgba(212,168,85,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, frame.yp(0));
    ctx.lineTo(pad.left + frame.cW, frame.yp(0));
    ctx.stroke();
    ctx.setLineDash([]);

    const pts = visible.map((p) => ({ x: keyToX(p.key), y: p.a - p.b, key: p.key }));
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, frame.cW, frame.cH);
    ctx.clip();
    drawSeries(ctx, pts, frame.xp, frame.yp, cssVar('--accent') || '#d4a855', gapX);
    ctx.restore();

    diffLayout = { xp: frame.xp, view, cW: frame.cW, points: pts };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Difference series, ${config.seriesNames.measured} minus ${config.seriesNames.modelled}, ${aggSubsetLabel(agg, subset)}.`);
  }

  /* ── Histogram + band ──────────────────────────────────────────────── */
  let histLayout = null;

  function drawHistChart() {
    updateHistTitle();
    const container = els.histChartContainer;
    const canvas = els.histChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const pairs = currentPairs();
    if (!pairs || !pairs.length || !differenceBuilt) { histLayout = null; return; }

    const gold = cssVar('--accent') || '#d4a855';
    const bandColor = cssVar('--series-obs') || '#5090f8';
    const textColor = cssVar('--text-secondary') || '#a8a090';
    const pad = { top: 16, right: 24, bottom: 36, left: 40 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const diffs = differences(pairs);
    const hist = buildHistogram(diffs, Math.max(10, Math.min(24, Math.floor(cW / 26))));
    if (!hist) { histLayout = null; return; }

    // Symmetric x-axis about zero (same reasoning as the cherry-picking
    // tally: an asymmetric axis exaggerates whichever tail reaches further).
    const extent = Math.max(
      Math.abs(hist.start),
      Math.abs(hist.start + hist.counts.length * hist.binWidth),
    );
    const xPad = extent * 0.06 || 0.1;
    const xLo = -extent - xPad;
    const xHi = extent + xPad;
    const maxCount = Math.max(...hist.counts, 1);
    const xp = (v) => pad.left + ((v - xLo) / Math.max(1e-9, xHi - xLo)) * cW;
    const yp = (c) => pad.top + (1 - c / maxCount) * cH;

    ctx.strokeStyle = 'rgba(212,168,85,0.12)';
    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui, sans-serif';
    const yTick = Math.max(1, Math.round(niceStep(maxCount, 4)));
    for (let c = 0; c <= maxCount; c += yTick) {
      const y = yp(c);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(c), pad.left - 6, y + 4);
    }
    ctx.textAlign = 'center';
    const xTick = niceStep(xHi - xLo, 6);
    for (let v = Math.ceil(xLo / xTick) * xTick; v <= xHi + 1e-9; v += xTick) {
      const tick = Math.abs(v) < xTick * 1e-6 ? 0 : v;
      ctx.fillText(tick.toFixed(Math.min(3, Math.max(1, -Math.floor(Math.log10(xTick))))), xp(tick), H - 8);
    }

    // Current band shading behind the bars.
    const band = empiricalBand(diffs, coverage);
    if (band) {
      ctx.fillStyle = 'rgba(80,144,248,0.14)';
      ctx.fillRect(xp(band.lo), pad.top, xp(band.hi) - xp(band.lo), cH);
      ctx.strokeStyle = bandColor;
      ctx.lineWidth = 1.5;
      [band.lo, band.hi].forEach((v) => {
        ctx.beginPath();
        ctx.moveTo(xp(v), pad.top);
        ctx.lineTo(xp(v), pad.top + cH);
        ctx.stroke();
      });
    }

    // Zero line
    ctx.strokeStyle = 'rgba(212,168,85,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xp(0), pad.top);
    ctx.lineTo(xp(0), pad.top + cH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(212,168,85,0.55)';
    ctx.strokeStyle = gold;
    ctx.lineWidth = 1;
    hist.counts.forEach((count, i) => {
      if (!count) return;
      const v0 = hist.start + i * hist.binWidth;
      const x0 = xp(v0);
      const x1 = xp(v0 + hist.binWidth);
      const y = yp(count);
      ctx.fillRect(x0, y, Math.max(1, x1 - x0 - 1), pad.top + cH - y);
      ctx.strokeRect(x0, y, Math.max(1, x1 - x0 - 1), pad.top + cH - y);
    });

    histLayout = { xp, hist, xLo, xHi, pad, cW };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Histogram of ${diffs.length} ${aggSubsetLabel(agg, subset)} differences, with the central ${Math.round(coverage * 100)}% band marked.`);
  }

  function updateDiffReadouts() {
    const pairs = currentPairs();
    // No current difference (e.g. a station switch is awaiting a record-version
    // pick) — the band can't be frozen, so make sure the button reflects that
    // rather than keeping whatever state the previous station left it in.
    if (!pairs || !differenceBuilt) {
      els.freezeBand.disabled = true;
      els.diffN.textContent = '—';
      els.diffMean.textContent = '—';
      els.diffMedian.textContent = '—';
      els.bandRange.textContent = '—';
      return;
    }
    const diffs = differences(pairs);
    const summary = summarizeDiffs(diffs);
    const band = empiricalBand(diffs, coverage);
    els.diffN.textContent = summary ? String(summary.n) : '—';
    els.diffMean.textContent = summary ? `${fmtDiff(summary.mean)} ${config.unit}` : '—';
    els.diffMedian.textContent = summary ? `${fmtDiff(summary.median)} ${config.unit}` : '—';
    els.bandRange.textContent = band
      ? `${fmtDiff(band.lo)} to ${fmtDiff(band.hi)} ${config.unit}`
      : 'not enough differences';
    // The candidate matches the frozen band only if it's the same station,
    // record version, averaging, time-of-year and coverage — change any of them
    // and the button offers to adopt the new band instead of staying locked.
    const isFrozenSelection = Boolean(frozen
      && frozen.siteId === siteId && frozen.datasetKey === datasetKey
      && frozen.agg === agg && frozen.subset === subset && frozen.coverage === coverage);
    els.freezeBand.disabled = !band || isFrozenSelection;
    // Once a band is frozen, changing the coverage/averaging/time-of-year picks
    // a different candidate band; the button then offers to adopt it in place of
    // the frozen one, rather than reading as a first-time freeze.
    els.freezeBand.textContent = frozen && !isFrozenSelection ? 'Use this band' : 'Freeze this band';
    els.freezeBandHint.textContent = frozen
      ? isFrozenSelection
        ? `This is your frozen band: central ${Math.round(frozen.coverage * 100)}% of ${aggSubsetLabel(frozen.agg, frozen.subset)} differences, ${fmtDiff(frozen.lo)} to ${fmtDiff(frozen.hi)} ${config.unit} (n=${frozen.n}).`
        : `Using this band replaces your frozen one (central ${Math.round(frozen.coverage * 100)}% of ${aggSubsetLabel(frozen.agg, frozen.subset)} differences) and clears your scorecard.`
      : band
        ? 'Freezing locks this band so you can test it at another site. You can re-freeze later.'
        : `Needs at least 30 ${aggSubsetLabel(agg, subset)} differences.`;
  }

  /* ── Transfer chart ────────────────────────────────────────────────── */
  let transferLayout = null;

  function targetPairs() {
    if (!targetPairsByAgg || !frozen) return null;
    // The transfer test is apples-to-apples: a band built from one month or
    // season is tested against the same month or season at the target.
    return filterPairs(targetPairsByAgg[frozen.agg] || [], frozen.agg, frozen.subset);
  }

  function drawTransferChart() {
    updateTransferTitle();
    const container = els.transferChartContainer;
    const canvas = els.transferChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const pairs = targetPairs();
    if (!pairs || !pairs.length || !frozen) { transferLayout = null; return; }

    const pad = { top: 16, right: 24, bottom: 36, left: 56 };
    const gapX = gapForAgg(frozen.agg, frozen.subset);
    const view = resolveView(viewTransfer, seriesExtentX(pairs));
    const visible = visibleWithin(pairs, view, gapX);
    const values = [];
    visible.forEach((p) => {
      if (transferVisible.band) values.push(p.b + frozen.lo, p.b + frozen.hi);
      if (transferVisible.modelled) values.push(p.b);
      if (revealed && transferVisible.measured) values.push(p.a);
    });
    if (!values.length) visible.forEach((p) => { values.push(p.b + frozen.lo, p.b + frozen.hi); });
    const yExt = extentOf(values);
    const yPad = (yExt.hi - yExt.lo) * 0.08 || 0.5;
    const frame = drawFrame(ctx, W, H, pad, view.lo, view.hi,
      yExt.lo - yPad, yExt.hi + yPad, '');

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, frame.cW, frame.cH);
    ctx.clip();

    // Band: filled region between modelled+lo and modelled+hi, drawn per
    // contiguous run so gaps stay gaps.
    ctx.fillStyle = 'rgba(80,144,248,0.16)';
    let run = [];
    const flushRun = () => {
      if (transferVisible.band && run.length > 1) {
        ctx.beginPath();
        run.forEach((p, i) => {
          const m = i === 0 ? 'moveTo' : 'lineTo';
          ctx[m](frame.xp(p.x), frame.yp(p.b + frozen.hi));
        });
        for (let i = run.length - 1; i >= 0; i--) {
          ctx.lineTo(frame.xp(run[i].x), frame.yp(run[i].b + frozen.lo));
        }
        ctx.closePath();
        ctx.fill();
      }
      run = [];
    };
    let prevX = null;
    visible.forEach((p) => {
      const x = keyToX(p.key);
      if (prevX !== null && x - prevX > gapX) flushRun();
      run.push({ x, b: p.b });
      prevX = x;
    });
    flushRun();

    // Modelled centre line.
    if (transferVisible.modelled) {
      const modelledPts = visible.map((p) => ({ x: keyToX(p.key), y: p.b, key: p.key }));
      drawSeries(ctx, modelledPts, frame.xp, frame.yp, seriesColor.modelled(), gapX);
    }

    // Measured overlay, only after the reveal.
    if (revealed && transferVisible.measured) {
      const measuredPts = visible.map((p) => ({ x: keyToX(p.key), y: p.a, key: p.key }));
      drawSeries(ctx, measuredPts, frame.xp, frame.yp, seriesColor.measured(), gapX, 1.2);
    }
    ctx.restore();

    transferLayout = {
      xp: frame.xp,
      view,
      cW: frame.cW,
      points: visible.map((p) => ({ x: keyToX(p.key), key: p.key, a: p.a, b: p.b })),
    };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label', revealed
      ? `${config.seriesNames.modelled} with your frozen band, and the revealed ${config.seriesNames.measured.toLowerCase()}, at the site you are testing.`
      : `${config.seriesNames.modelled} with your frozen band at the site you are testing; measurements not yet revealed.`);
  }

  function updateTransferKey() {
    const items = [
      legendButton('modelled', config.seriesNames.modelled, seriesColor.modelled(), transferVisible.modelled),
      legendButton('band', 'Your frozen band', BAND_LEGEND_COLOR, transferVisible.band),
    ];
    if (revealed) {
      items.push(legendButton('measured', config.seriesNames.measured, seriesColor.measured(), transferVisible.measured));
    }
    els.transferKey.innerHTML = items.join('');
  }

  function updateTransferTally() {
    if (!revealed || !frozen) { els.transferTally.textContent = ''; return; }
    const result = transferCoverage(targetPairs(), frozen);
    if (!result) { els.transferTally.textContent = ''; return; }
    els.transferTally.textContent =
      `${result.inside} of ${result.n} ${aggSubsetLabel(frozen.agg, frozen.subset)} measurements fall inside your band — ` +
      `${(result.fraction * 100).toFixed(1)}%, against the ${Math.round(frozen.coverage * 100)}% the band held at your calibration site.`;
  }

  function updateScorecard() {
    const tbody = els.scorecardBody;
    tbody.innerHTML = '';
    scorecard.forEach((row) => {
      const site = siteById(row.siteId);
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${site ? site.name : row.siteId}</td>` +
        `<td>${fmtBu(site ? site.bu1km : null)}</td>` +
        `<td>${row.inside} / ${row.n}</td>` +
        `<td>${(row.fraction * 100).toFixed(1)}%</td>` +
        `<td>${Math.round(frozen.coverage * 100)}%</td>`;
      tbody.appendChild(tr);
    });
  }

  /* ── Pairs data table (accessibility fallback) ─────────────────────── */
  function fillPairsTable() {
    const tbody = els.pairsTable.querySelector('tbody');
    tbody.innerHTML = '';
    const pairs = currentPairs();
    if (!pairs) return;
    const frag = document.createDocumentFragment();
    pairs.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.key}</td><td>${fmtVal(p.a)}</td><td>${fmtVal(p.b)}</td>`;
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  /* ── Explore readouts ──────────────────────────────────────────────── */
  function updateExploreReadouts() {
    const pairs = currentPairs();
    if (!pairs || !pairs.length) {
      els.readoutSpan.textContent = '—';
      els.readoutPeriods.textContent = '—';
      els.readoutAgg.textContent = '—';
      return;
    }
    els.readoutSpan.textContent = `${pairs[0].key} to ${pairs[pairs.length - 1].key}`;
    els.readoutPeriods.textContent = String(pairs.length);
    els.readoutAgg.textContent = subset === 'all'
      ? aggLabel(agg)
      : `${aggLabel(agg)} (${subsetLabel(subset)})`;
  }

  function redrawAll() {
    drawPairedChart();
    updatePairedKey();
    drawDiffChart();
    drawHistChart();
    updateDiffReadouts();
    drawTransferChart();
    updateTransferKey();
    updateExploreReadouts();
  }

  /* ── Beacons ───────────────────────────────────────────────────────── */
  function beacon(eventKey) {
    const name = config.beacons[eventKey];
    if (!name || sentBeacons.has(name)) return;
    sendFeatureBeacon(`${config.funnelPrefix}/${name}`);
    sentBeacons.add(name);
  }

  /* ── Aggregation / coverage controls ───────────────────────────────── */
  function setAgg(key, { fromRestore = false } = {}) {
    if (!AGG_KEYS.includes(key)) return;
    agg = key;
    document.querySelectorAll('[data-agg]').forEach((btn) => {
      const active = btn.getAttribute('data-agg') === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    // The month/season filter options depend on the averaging; an invalid
    // carry-over falls back to the first available option (the pooled view
    // where one is offered, otherwise the first month/season).
    const validSubsets = subsetOptionsFor(key);
    if (!validSubsets.includes(subset)) subset = validSubsets[0];
    renderSubsetButtons();
    if (pairsByAgg) {
      fillPairsTable();
      redrawAll();
    }
    if (!fromRestore) pushStateToUrl();
  }

  function renderSubsetButtons() {
    const options = subsetOptionsFor(agg);
    els.subsetRow.hidden = options.length === 1;
    els.subsetButtons.innerHTML = options.map((key) =>
      `<button type="button" class="toggle-btn${key === subset ? ' active' : ''}" data-subset="${key}" aria-pressed="${key === subset}">${subsetButtonLabel(key)}</button>`).join('');
  }

  function setSubset(key, { fromRestore = false } = {}) {
    if (!subsetOptionsFor(agg).includes(key)) return;
    subset = key;
    document.querySelectorAll('[data-subset]').forEach((btn) => {
      const active = btn.getAttribute('data-subset') === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (pairsByAgg) {
      fillPairsTable();
      redrawAll();
    }
    if (!fromRestore) pushStateToUrl();
  }

  function setCoverage(level, { fromRestore = false } = {}) {
    if (!COVERAGE_LEVELS.includes(level)) return;
    coverage = level;
    document.querySelectorAll('[data-coverage]').forEach((btn) => {
      const active = Number(btn.getAttribute('data-coverage')) === level;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (pairsByAgg && differenceBuilt) {
      drawHistChart();
      updateDiffReadouts();
    }
    if (!fromRestore) pushStateToUrl();
  }

  /* ── Blocking choice: calibration site ─────────────────────────────── */
  function renderSiteCards() {
    const grid = els.siteGrid;
    grid.innerHTML = '';
    shuffleArray(config.sites).forEach((site) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'station-card' + (site.id === siteId ? ' active' : '');
      btn.dataset.siteId = site.id;
      btn.setAttribute('aria-pressed', site.id === siteId ? 'true' : 'false');
      btn.innerHTML = config.cardHtml(site);
      btn.addEventListener('click', () => chooseSite(site.id));
      grid.appendChild(btn);
    });
  }

  function updateSiteCards() {
    document.querySelectorAll('#siteGrid .station-card').forEach((c) => {
      const active = c.dataset.siteId === siteId;
      c.classList.toggle('active', active);
      c.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // Full reset (Reset button): collapse everything past the explore section.
  function clearDownstream() {
    differenceBuilt = false;
    frozen = null;
    targetId = null;
    revealed = false;
    targetPairsByAgg = null;
    scorecard = [];
    sections.difference.hidden = true;
    sections.transfer.hidden = true;
    if (!sections.explore.hidden) sections.diffPrompt.hidden = false;
    els.frozenBanner.hidden = true;
    els.transferTally.textContent = '';
    if (els.scorecardBody) els.scorecardBody.innerHTML = '';
  }

  // Drop only the transfer target (keeping the frozen band) — used when a newly
  // chosen calibration station is the one currently under test, which would
  // otherwise leave a station being compared against itself.
  function resetTarget() {
    targetId = null;
    revealed = false;
    targetPairsByAgg = null;
    els.targetPrompt.hidden = false;
    els.transferTally.textContent = '';
    els.revealMeasured.disabled = true;
    els.revealMeasuredHint.textContent = 'Pick a site above first.';
    updateTargetCards();
  }

  function chooseSite(id, { fromRestore = false } = {}) {
    const site = siteById(id);
    if (!site) return;
    const changed = siteId !== null && siteId !== id;
    siteId = id;
    // The record-version options can differ by site (QCU/QCF vs a composite's
    // Spliced/Raw), so re-render the dataset cards for this site and drop a choice
    // that is no longer valid (e.g. carrying "qcf" onto a composite).
    const dsOpts = datasetsForSite(site);
    const needsDataset = hasDatasets && dsOpts.length > 0;
    if (hasDatasets) {
      if (datasetKey && !dsOpts.some((o) => o.key === datasetKey)) {
        datasetKey = null;
        els.datasetChosenBanner.hidden = true;
        els.datasetPrompt.hidden = false;
        pairsByAgg = null;  // the new station's series isn't loaded until re-picked
      }
      renderDatasetCards();
    }
    updateSiteCards();
    els.siteInfo.innerHTML = config.siteInfoHtml(site);
    els.sitePrompt.hidden = true;
    const nextSection = needsDataset ? sections.dataset : sections.explore;
    const firstReveal = nextSection.hidden;
    nextSection.hidden = false;
    if (!needsDataset) sections.diffPrompt.hidden = differenceBuilt;
    updatePairedTitle();
    updateDiffTitle();
    updateHistTitle();
    // Season button names are hemisphere-dependent, so (re)render them now the
    // station is known — matters on URL restore, where the subset buttons first
    // render before any station is chosen.
    renderSubsetButtons();
    // Changing the calibration station recomputes the difference for the new
    // station but leaves everything you've already opened in place — the
    // difference stays open, and any frozen band and its transfer results stay
    // visible (the band keeps its own provenance). Only drop the transfer target
    // if it collides with the new calibration station.
    if (changed && targetId === id) resetTarget();
    renderTargetCards();
    if (!fromRestore) {
      beacon('siteSelected');
      pushStateToUrl();
      if (firstReveal) nextSection.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      if (!needsDataset || datasetKey) loadAndShow();
      else redrawAll();  // awaiting a version pick: clear stale charts + freeze state
    }
  }

  /* ── Blocking choice: dataset version (optional) ───────────────────── */
  function renderDatasetCards() {
    if (!hasDatasets) return;
    const grid = els.datasetGrid;
    grid.innerHTML = '';
    shuffleArray(datasetsForSite(siteById(siteId))).forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prediction-card' + (opt.key === datasetKey ? ' chosen' : '');
      btn.dataset.key = opt.key;
      btn.innerHTML = `
        <span class="prediction-card-label">${opt.label}</span>
        <span class="prediction-card-desc">${opt.desc}</span>
      `;
      btn.addEventListener('click', () => chooseDataset(opt.key));
      grid.appendChild(btn);
    });
  }

  function chooseDataset(key, { fromRestore = false } = {}) {
    const opt = datasetsForSite(siteById(siteId)).find((o) => o.key === key);
    if (!opt) return;
    datasetKey = key;
    document.querySelectorAll('#datasetGrid .prediction-card').forEach((c) => {
      c.classList.toggle('chosen', c.dataset.key === key);
    });
    els.datasetChosenLabel.textContent = opt.label;
    els.datasetChosenBanner.hidden = false;
    els.datasetPrompt.hidden = true;
    const firstReveal = sections.explore.hidden;
    sections.explore.hidden = false;
    sections.diffPrompt.hidden = differenceBuilt;
    // Switching record version (QCU/QCF) recomputes the difference against the
    // new series but keeps whatever you've already opened — including a frozen
    // band and its transfer results — rather than collapsing back.
    if (!fromRestore) {
      beacon('datasetSelected');
      pushStateToUrl();
      if (firstReveal) sections.explore.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      loadAndShow();
    }
  }

  /* ── Data loading ──────────────────────────────────────────────────── */
  // The record-version key is chosen for the calibration station, but a transfer
  // target can offer a different set (a composite's Spliced/Raw vs a normal
  // station's QCU/QCF). Carry the current key over only if the target actually
  // has it; otherwise fall back to that site's own default (the first option —
  // QCU for a normal station), so e.g. a composite calibration never asks a
  // normal station for a non-existent "spliced" record.
  function datasetKeyForSite(site) {
    if (!hasDatasets) return datasetKey;
    const opts = datasetsForSite(site);
    if (!opts.length) return datasetKey;
    if (opts.some((o) => o.key === datasetKey)) return datasetKey;
    return opts[0].key;
  }

  async function loadPairsCached(site) {
    const key = datasetKeyForSite(site);
    const cacheKey = `${site.id}:${key || ''}`;
    if (pairsCache.has(cacheKey)) return pairsCache.get(cacheKey);
    const result = await config.loadPairs(site, key);
    pairsCache.set(cacheKey, result);
    return result;
  }

  function showLoadError(loadingEl, retry, message) {
    loadingEl.hidden = false;
    loadingEl.innerHTML = `
      <span>Could not load the data.</span>
      <button type="button" class="mini-tool" data-retry-load style="margin-left:0.5rem;pointer-events:auto">Retry</button>
    `;
    loadingEl.querySelector('[data-retry-load]').addEventListener('click', retry);
    if (message) console.error('Data load error:', message);
  }

  let loadToken = 0;
  async function loadAndShow({ restored = null } = {}) {
    if (!siteId || (hasDatasets && !datasetKey)) return;
    const token = ++loadToken;
    pairsByAgg = null;
    viewCal = restored ? restored.vx : null;
    viewTransfer = restored ? restored.tvx : null;
    updateExploreReadouts();
    els.pairedChartLoading.hidden = false;
    els.pairedChartLoading.innerHTML = '<span class="spinner" aria-hidden="true"></span>Loading…';
    try {
      const result = await loadPairsCached(siteById(siteId));
      if (token !== loadToken) return;
      pairsByAgg = result;
      els.pairedChartLoading.hidden = true;
      fillPairsTable();
      if (restored) {
        if (restored.df) buildDifference({ fromRestore: true });
        if (restored.fa && COVERAGE_LEVELS.includes(restored.fc)
            && AGG_KEYS.includes(restored.fa)) {
          const fsuOptions = subsetOptionsFor(restored.fa);
          const fsu = fsuOptions.includes(restored.fsu) ? restored.fsu : fsuOptions[0];
          freezeBand({ fromRestore: true, agg: restored.fa, coverage: restored.fc, subset: fsu });
          if (restored.t && siteById(restored.t) && restored.t !== siteId) {
            await chooseTarget(restored.t, { fromRestore: true });
            if (restored.r) revealMeasured({ fromRestore: true });
          }
        }
      }
      redrawAll();
      pushStateToUrl();
    } catch (err) {
      if (token !== loadToken) return;
      showLoadError(els.pairedChartLoading, () => loadAndShow(), err.message || 'unknown error');
    }
  }

  /* ── Difference reveal ─────────────────────────────────────────────── */
  function buildDifference({ fromRestore = false } = {}) {
    if (!pairsByAgg) return;
    differenceBuilt = true;
    sections.diffPrompt.hidden = true;
    sections.difference.hidden = false;
    if (!fromRestore) {
      beacon('differenceBuilt');
      redrawAll();
      pushStateToUrl();
      sections.difference.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    }
  }

  /* ── Freeze band / transfer ────────────────────────────────────────── */
  function freezeBand({ fromRestore = false, agg: fAgg = null, coverage: fCov = null, subset: fSub = null } = {}) {
    const useAgg = fAgg || agg;
    const useCov = fCov != null ? fCov : coverage;
    const useSub = fSub != null ? fSub : subset;
    const pairs = pairsByAgg
      ? filterPairs(pairsByAgg[useAgg] || [], useAgg, useSub)
      : null;
    if (!pairs) return;
    const band = empiricalBand(differences(pairs), useCov);
    if (!band) return;
    frozen = { siteId, datasetKey, agg: useAgg, subset: useSub, coverage: useCov, lo: band.lo, hi: band.hi, n: band.n };
    scorecard = [];
    targetId = null;
    revealed = false;
    targetPairsByAgg = null;
    els.frozenBanner.hidden = false;
    els.frozenLabel.textContent =
      `central ${Math.round(useCov * 100)}% of ${aggSubsetLabel(useAgg, useSub)} differences at ${siteById(siteId).name}: ` +
      `${fmtDiff(band.lo)} to ${fmtDiff(band.hi)} ${config.unit} (n=${band.n})`;
    sections.transfer.hidden = false;
    els.targetPrompt.hidden = false;
    els.revealMeasured.disabled = true;
    els.revealMeasuredHint.textContent = 'Pick a site above first.';
    els.transferTally.textContent = '';
    updateScorecard();
    renderTargetCards();
    drawTransferChart();
    updateTransferKey();
    if (!fromRestore) {
      beacon('bandFrozen');
      updateDiffReadouts();
      pushStateToUrl();
      sections.transfer.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    }
  }

  function renderTargetCards() {
    const grid = els.targetGrid;
    if (!grid) return;
    grid.innerHTML = '';
    shuffleArray(config.sites.filter((s) => s.id !== siteId)).forEach((site) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'station-card' + (site.id === targetId ? ' active' : '');
      btn.dataset.siteId = site.id;
      btn.setAttribute('aria-pressed', site.id === targetId ? 'true' : 'false');
      btn.innerHTML = config.cardHtml(site);
      btn.addEventListener('click', () => chooseTarget(site.id));
      grid.appendChild(btn);
    });
  }

  function updateTargetCards() {
    document.querySelectorAll('#targetGrid .station-card').forEach((c) => {
      const active = c.dataset.siteId === targetId;
      c.classList.toggle('active', active);
      c.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  async function chooseTarget(id, { fromRestore = false } = {}) {
    if (!siteById(id) || id === siteId || !frozen) return;
    targetId = id;
    revealed = false;
    targetPairsByAgg = null;
    if (!fromRestore) viewTransfer = null;
    updateTargetCards();
    updateTransferTitle();
    els.targetPrompt.hidden = true;
    els.transferTally.textContent = '';
    els.revealMeasured.disabled = true;
    els.revealMeasuredHint.textContent = 'Loading…';
    els.transferChartLoading.hidden = false;
    els.transferChartLoading.innerHTML = '<span class="spinner" aria-hidden="true"></span>Loading…';
    if (!fromRestore) pushStateToUrl();
    const token = ++loadToken + 100000; // distinct token space from calibration loads
    try {
      const result = await loadPairsCached(siteById(id));
      if (targetId !== id) return;
      targetPairsByAgg = result;
      els.transferChartLoading.hidden = true;
      const existing = scorecard.find((r) => r.siteId === id);
      if (existing && !fromRestore) {
        // Already revealed this one under the current band.
        revealed = true;
      }
      els.revealMeasured.disabled = revealed;
      els.revealMeasuredHint.textContent = revealed
        ? 'Already revealed for this site under this band.'
        : 'The chart shows only the modelled series and your band. Reveal when ready.';
      drawTransferChart();
      updateTransferKey();
      updateTransferTally();
      if (!fromRestore) pushStateToUrl();
    } catch (err) {
      if (targetId !== id) return;
      showLoadError(els.transferChartLoading, () => chooseTarget(id), err.message || 'unknown error');
    }
  }

  function revealMeasured({ fromRestore = false } = {}) {
    if (!frozen || !targetId || !targetPairsByAgg || revealed) return;
    revealed = true;
    const result = transferCoverage(targetPairs(), frozen);
    if (result && !scorecard.some((r) => r.siteId === targetId)) {
      scorecard.push({ siteId: targetId, inside: result.inside, n: result.n, fraction: result.fraction });
    }
    els.revealMeasured.disabled = true;
    els.revealMeasuredHint.textContent = 'Pick another site above to test your band again.';
    drawTransferChart();
    updateTransferKey();
    updateTransferTally();
    updateScorecard();
    if (!fromRestore) {
      beacon('transferRevealed');
      pushStateToUrl();
    }
  }

  /* ── Reset ─────────────────────────────────────────────────────────── */
  function wireReset() {
    els.resetLab.addEventListener('click', () => {
      siteId = null;
      datasetKey = null;
      pairsByAgg = null;
      viewCal = null;
      viewTransfer = null;
      seriesVisible.measured = true;
      seriesVisible.modelled = true;
      transferVisible.modelled = true;
      transferVisible.band = true;
      transferVisible.measured = true;
      clearDownstream();
      updateSiteCards();
      els.siteInfo.innerHTML = '';
      els.sitePrompt.hidden = false;
      if (hasDatasets) {
        document.querySelectorAll('#datasetGrid .prediction-card').forEach((c) => c.classList.remove('chosen'));
        els.datasetChosenBanner.hidden = true;
        els.datasetPrompt.hidden = false;
        sections.dataset.hidden = true;
      }
      sections.explore.hidden = true;
      sections.diffPrompt.hidden = true;
      setAgg(AGG_KEYS[Math.floor(Math.random() * AGG_KEYS.length)], { fromRestore: true });
      const resetSubsets = subsetOptionsFor(agg);
      setSubset(resetSubsets[Math.floor(Math.random() * resetSubsets.length)], { fromRestore: true });
      setCoverage(COVERAGE_LEVELS[Math.floor(Math.random() * COVERAGE_LEVELS.length)], { fromRestore: true });
      updateExploreReadouts();
      pushStateToUrl();
      window.scrollTo({ top: 0, behavior: scrollBehavior });
    });
  }

  /* ── Theme / resize redraws ────────────────────────────────────────── */
  function wireRedraws() {
    window.addEventListener('klymot:theme-toggled', () => {
      if (pairsByAgg) redrawAll();
    });
    const observer = new ResizeObserver(() => {
      if (pairsByAgg) redrawAll();
    });
    observer.observe(els.pairedChartContainer);
    observer.observe(els.diffChartContainer);
    observer.observe(els.histChartContainer);
    observer.observe(els.transferChartContainer);
  }

  /* ── Initialisation ────────────────────────────────────────────────── */
  function initialize() {
    const urlState = readStateFromUrl();
    sectionTracker = createSectionTracker(config.sectionIds, { onChange: pushStateToUrl });
    sectionTracker.setCurrentSectionId(urlState.sec || null);
    window.addEventListener('scroll', sectionTracker.syncSectionState, { passive: true });

    renderSiteCards();
    renderDatasetCards();
    wireReset();
    wireRedraws();

    document.querySelectorAll('[data-agg]').forEach((btn) => {
      btn.addEventListener('click', () => setAgg(btn.getAttribute('data-agg')));
    });
    // Subset buttons are re-rendered whenever the averaging changes, so the
    // click handler lives on their container.
    els.subsetButtons.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-subset]');
      if (btn) setSubset(btn.getAttribute('data-subset'));
    });
    document.querySelectorAll('[data-coverage]').forEach((btn) => {
      btn.addEventListener('click', () => setCoverage(Number(btn.getAttribute('data-coverage'))));
    });
    els.buildDifference.addEventListener('click', () => buildDifference());
    els.freezeBand.addEventListener('click', () => freezeBand());
    els.revealMeasured.addEventListener('click', () => revealMeasured());

    document.querySelectorAll('[data-chart-nav]').forEach((btn) => {
      btn.addEventListener('click', () =>
        navChart(btn.getAttribute('data-chart-nav'), btn.getAttribute('data-nav-action')));
    });
    wireDragPan(els.pairedChart, 'cal', () => pairedLayout, els.pairedTooltip);
    wireDragPan(els.diffChart, 'cal', () => diffLayout, els.diffTooltip);
    wireDragPan(els.transferChart, 'transfer', () => transferLayout, els.transferTooltip);

    els.pairedKey.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-series-toggle]');
      if (!btn) return;
      const which = btn.getAttribute('data-series-toggle');
      seriesVisible[which] = !seriesVisible[which];
      updatePairedKey();
      drawPairedChart();
    });
    els.transferKey.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-series-toggle]');
      if (!btn) return;
      const which = btn.getAttribute('data-series-toggle');
      transferVisible[which] = !transferVisible[which];
      updateTransferKey();
      drawTransferChart();
    });

    keyedTooltip(els.pairedChart, els.pairedTooltip, () => pairedLayout,
      (p) => {
        const parts = seriesOrder.map((which) =>
          `${config.seriesNames[which]} ${fmtVal(which === 'measured' ? p.a : p.b)}`);
        return `${p.key}  ${parts.join(' · ')} ${config.unit}`;
      });
    keyedTooltip(els.diffChart, els.diffTooltip, () => diffLayout,
      (p) => `${p.key}  ${fmtDiff(p.y)} ${config.unit}`);
    keyedTooltip(els.transferChart, els.transferTooltip, () => transferLayout,
      (p) => revealed
        ? `${p.key}  ${config.seriesNames.modelled} ${fmtVal(p.b)} · ${config.seriesNames.measured} ${fmtVal(p.a)} ${config.unit}`
        : `${p.key}  ${config.seriesNames.modelled} ${fmtVal(p.b)} ${config.unit}`);
    els.histChart.addEventListener('mousemove', (e) => {
      const tooltip = els.histTooltip;
      if (!histLayout) { tooltip.hidden = true; return; }
      const rect = els.histChart.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { hist, xLo, xHi, pad, cW } = histLayout;
      const v = xLo + ((x - pad.left) / Math.max(1e-9, cW)) * (xHi - xLo);
      const i = Math.floor((v - hist.start) / hist.binWidth);
      if (i < 0 || i >= hist.counts.length || !hist.counts[i]) { tooltip.hidden = true; return; }
      const b0 = hist.start + i * hist.binWidth;
      tooltip.textContent =
        `${fmtDiff(b0)} to ${fmtDiff(b0 + hist.binWidth)} ${config.unit}\n${hist.counts[i]} period${hist.counts[i] === 1 ? '' : 's'}`;
      tooltip.hidden = false;
      const ttW = tooltip.offsetWidth || 160;
      let left = x + 14;
      if (left + ttW > rect.width - 8) left = x - ttW - 14;
      tooltip.style.left = Math.max(4, left) + 'px';
      tooltip.style.top = '12px';
    });
    els.histChart.addEventListener('mouseleave', () => { els.histTooltip.hidden = true; });

    // Non-blocking controls: randomized initial values unless restored.
    restoring = true;
    setAgg(AGG_KEYS.includes(urlState.a) ? urlState.a
      : AGG_KEYS[Math.floor(Math.random() * AGG_KEYS.length)], { fromRestore: true });
    const subsetOptions = subsetOptionsFor(agg);
    setSubset(subsetOptions.includes(urlState.sub) ? urlState.sub
      : subsetOptions[Math.floor(Math.random() * subsetOptions.length)], { fromRestore: true });
    setCoverage(COVERAGE_LEVELS.includes(urlState.c) ? urlState.c
      : COVERAGE_LEVELS[Math.floor(Math.random() * COVERAGE_LEVELS.length)], { fromRestore: true });

    // Restore blocking choices, revealing the sections they unlock before
    // any fetch starts, then restore the scroll position exactly once.
    const restoredSite = urlState.s && siteById(urlState.s) ? urlState.s : null;
    const restoredDataset = hasDatasets && urlState.d
      && datasetsForSite(siteById(urlState.s)).some((o) => o.key === urlState.d) ? urlState.d : null;
    if (restoredSite) {
      chooseSite(restoredSite, { fromRestore: true });
      if (hasDatasets && restoredDataset) chooseDataset(restoredDataset, { fromRestore: true });
      const choicesComplete = !hasDatasets || Boolean(restoredDataset);
      if (choicesComplete && urlState.df) {
        sections.diffPrompt.hidden = true;
        sections.difference.hidden = false;
      }
    }
    restoring = false;
    sectionTracker.restoreSectionFromUrl(urlState.sec);

    const choicesComplete = restoredSite && (!hasDatasets || restoredDataset);
    if (choicesComplete) {
      loadAndShow({ restored: urlState });
    } else {
      pushStateToUrl();
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
}
