// Interactive driver + pure math for the "Is 'Average' Really the Average?" lab.
//
// The lab lets a reader pick a real weather station and discover, for that
// station, the gap between the daily midpoint (Tmax+Tmin)/2 and the true daily
// mean: how big it is, whether it has a shape across the year, whether it drifts
// across the years, and whether a correction fitted on part of the record holds
// up on years held back.
//
// NEUTRALITY (see LAB-DESIGN.md): the code never encodes a conclusion. Station
// order and correction-strategy order are randomised with no default; "assume
// the gap is zero" is one strategy on equal footing with the others; the holdout
// bars are computed and drawn, and the page never names a winner.
//
// gap = mid - avg, where mid = (Tmax+Tmin)/2 and avg = the true daily mean.
//
// The pure functions below are DOM-free and unit-tested in
// average-really-average-lab.test.js. The interactive driver (initAverageLab)
// follows.

/* ══════════════════════════════════════════════════════════════════════════
 * Pure math (DOM-free, tested)
 * ══════════════════════════════════════════════════════════════════════════ */

export const STRATEGIES = ['zero', 'constant', 'seasonal'];

/** Daily gap series from a station's daily_sample: gap = mid - avg, dropping
 *  days missing either value. */
export function dailyGaps(dailySample) {
  const out = [];
  for (const d of dailySample || []) {
    if (d.mid == null || d.avg == null) continue;
    out.push({ d: d.d, mid: d.mid, avg: d.avg, gap: d.mid - d.avg });
  }
  return out;
}

/** Monthly gap series from a station's monthly block. Each entry carries the
 *  ISO month key, its year and calendar month (1–12), the gap, and the day
 *  count. Months missing either mid or avg are dropped. */
export function monthlyGapSeries(monthly) {
  const out = [];
  if (!monthly || !monthly.months) return out;
  const { months, mid, avg, n } = monthly;
  for (let i = 0; i < months.length; i++) {
    if (mid[i] == null || avg[i] == null) continue;
    const key = months[i];
    out.push({
      month: key,
      year: Number(key.slice(0, 4)),
      mon: Number(key.slice(5, 7)),
      gap: mid[i] - avg[i],
      n: n ? n[i] : null,
    });
  }
  return out;
}

/** Month-of-year climatology of the gap: the average gap for each calendar
 *  month over the whole record, plus the per-year traces behind it (so a caller
 *  can show that the shape is statistical, not something to read off one year).
 *  byMonth[i] covers calendar month i+1; mean is null where that month never
 *  appears. */
export function monthOfYearClimatology(series) {
  const acc = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
  const perYear = new Map();
  for (const p of series) {
    const idx = p.mon - 1;
    acc[idx].sum += p.gap;
    acc[idx].count += 1;
    if (!perYear.has(p.year)) perYear.set(p.year, new Array(12).fill(null));
    perYear.get(p.year)[idx] = p.gap;
  }
  const byMonth = acc.map((a, i) => ({
    mon: i + 1,
    mean: a.count ? a.sum / a.count : null,
    n: a.count,
  }));
  const traces = [...perYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, values]) => ({ year, values }));
  return { byMonth, traces };
}

/** Year-by-year average gap across the record. A year needs at least minMonths
 *  monthly values to appear. */
export function annualGapSeries(series, minMonths = 1) {
  const byYear = new Map();
  for (const p of series) {
    if (!byYear.has(p.year)) byYear.set(p.year, []);
    byYear.get(p.year).push(p.gap);
  }
  return [...byYear.entries()]
    .filter(([, gaps]) => gaps.length >= minMonths)
    .sort((a, b) => a[0] - b[0])
    .map(([year, gaps]) => ({
      year,
      gap: gaps.reduce((s, x) => s + x, 0) / gaps.length,
      n: gaps.length,
    }));
}

/** Split a monthly gap series chronologically into a training block and a
 *  held-out test block. end='tail' holds back the most recent months;
 *  end='head' holds back the earliest. At least one month is always held out. */
export function splitByFraction(series, holdoutFrac, end = 'tail') {
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const total = sorted.length;
  const nTest = Math.min(total, Math.max(1, Math.round(total * holdoutFrac)));
  if (end === 'head') {
    return { test: sorted.slice(0, nTest), train: sorted.slice(nTest) };
  }
  return { train: sorted.slice(0, total - nTest), test: sorted.slice(total - nTest) };
}

/** Fit statistics from a training block: the overall mean gap and the
 *  month-of-year climatology (mean gap per calendar month, null where absent). */
export function trainStats(train) {
  const mean = train.length ? train.reduce((s, p) => s + p.gap, 0) / train.length : 0;
  const acc = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
  for (const p of train) {
    acc[p.mon - 1].sum += p.gap;
    acc[p.mon - 1].count += 1;
  }
  const climatology = acc.map((a) => (a.count ? a.sum / a.count : null));
  return { mean, climatology, n: train.length };
}

/** The correction a strategy would subtract for a given calendar month, using
 *  training statistics only. 'zero' changes nothing; 'constant' subtracts the
 *  training mean; 'seasonal' subtracts the training month-of-year value (falling
 *  back to the mean for a calendar month unseen in training). */
export function predictCorrection(strategy, stats, mon) {
  if (strategy === 'constant') return stats.mean;
  if (strategy === 'seasonal') {
    const c = stats.climatology[mon - 1];
    return c == null ? stats.mean : c;
  }
  return 0; // 'zero' and any unknown strategy
}

/** Root-mean-square of a residual array (null if empty). */
export function rmse(residuals) {
  if (!residuals.length) return null;
  const ms = residuals.reduce((s, r) => s + r * r, 0) / residuals.length;
  return Math.sqrt(ms);
}

/** Score one strategy: fit on the train block, then measure the leftover error
 *  on the test block. The residual for a test month is its actual gap minus the
 *  correction the strategy would have applied. */
export function scoreStrategy(train, test, strategy) {
  const stats = trainStats(train);
  const residuals = test.map((p) => p.gap - predictCorrection(strategy, stats, p.mon));
  return {
    strategy,
    rmse: rmse(residuals),
    mae: test.length ? residuals.reduce((s, r) => s + Math.abs(r), 0) / test.length : null,
    n: test.length,
    stats,
  };
}

/** Run the full holdout test: split the series, fit each strategy on the train
 *  block, and score all three on the held-out block. */
export function runHoldout(series, holdoutFrac, end = 'tail') {
  const { train, test } = splitByFraction(series, holdoutFrac, end);
  const results = {};
  for (const s of STRATEGIES) results[s] = scoreStrategy(train, test, s);
  return { train, test, results, stats: trainStats(train) };
}

/** Lag-1 autocorrelation of a series (null if fewer than 3 values or no
 *  variance). Used to discount slowly-drifting annual gap series in the
 *  transfer test: consecutive years of a drifting gap are not independent. */
export function lag1Autocorr(values) {
  const n = values.length;
  if (n < 3) return null;
  const mean = values.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    den += d * d;
    if (i > 0) num += d * (values[i - 1] - mean);
  }
  return den > 0 ? num / den : null;
}

/** Effective number of independent observations in an autocorrelated series:
 *  n_eff = n(1−r)/(1+r) for positive lag-1 r (the same adjustment the
 *  investigation's trend analysis uses). No inflation for negative r; floored
 *  at 2 so a heavily-drifting station still enters the ANOVA, just weakly. */
export function effectiveN(n, r) {
  if (r == null || r <= 0) return n;
  return Math.max(2, Math.min(n, (n * (1 - r)) / (1 + r)));
}

/** One-way ANOVA from per-group summaries (n, mean, sample variance) — enough to
 *  compare how much the gap differs *between* stations against how much it wobbles
 *  *within* each, i.e. whether one station's correction could carry to another.
 *  Returns null if fewer than two groups have ≥2 observations. */
export function oneWayAnova(groups) {
  const g = (groups || []).filter((x) => x && x.n >= 2 && x.var != null);
  const k = g.length;
  const N = g.reduce((s, x) => s + x.n, 0);
  if (k < 2 || N - k < 1) return null;
  const grand = g.reduce((s, x) => s + x.n * x.mean, 0) / N;
  const ssB = g.reduce((s, x) => s + x.n * (x.mean - grand) ** 2, 0);
  const ssW = g.reduce((s, x) => s + (x.n - 1) * x.var, 0);
  const dfB = k - 1;
  const dfW = N - k;
  const msB = ssB / dfB;
  const msW = ssW / dfW;
  // sd of the station mean gaps — the scale of error from reusing one on another.
  const meanSpread = Math.sqrt(
    g.reduce((s, x) => s + (x.mean - grand) ** 2, 0) / (k - 1)
  );
  return {
    k, N, dfB, dfW,
    F: msW > 0 ? msB / msW : Infinity,
    withinSd: Math.sqrt(msW),
    meanSpread,
  };
}

// Log-gamma (Lanczos) and the regularised incomplete beta (Numerical Recipes
// betacf), enough to get an F-distribution p-value without a stats library.
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Upper-tail p-value of an F statistic (P(F ≥ f) under the null). */
export function fPValue(f, dfB, dfW) {
  if (!(f > 0) || dfB < 1 || dfW < 1) return 1;
  return betai(dfW / 2, dfB / 2, dfW / (dfW + dfB * f));
}

/* ══════════════════════════════════════════════════════════════════════════
 * Interactive driver (browser only)
 * ══════════════════════════════════════════════════════════════════════════ */

// Guarded so this module stays importable in Node for the unit tests: the
// driver only touches the DOM when initAverageLab is actually called.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const STRATEGY_META = {
  zero: {
    label: 'Assume the gap is zero',
    desc: 'Change nothing — treat the midpoint as the day’s average, the way the old records do.',
  },
  constant: {
    label: 'Subtract this station’s average gap',
    desc: 'Work out one average gap from the years you keep, and take it off every month.',
  },
  seasonal: {
    label: 'Subtract a season-shaped gap',
    desc: 'Work out a separate average gap for each calendar month, and take off the one that fits.',
  },
};

const HOLDOUT_OPTIONS = [0.2, 0.3, 0.4];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtSigned(v, dp = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}`;
}

function fmtPlain(v, dp = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toFixed(dp);
}

/**
 * @param {{
 *   stations: Array<{id,name,place,climate,kind,n_months}>,
 *   introDay: object,
 *   dataBase: string,
 *   funnelPrefix: string,
 *   sendFeatureBeacon: (name:string)=>void,
 * }} config
 */
export function initAverageLab(config) {
  const {
    stations, introDay, dataBase,
    funnelPrefix, sendFeatureBeacon,
  } = config;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

  /* ── State ──────────────────────────────────────────────────────────── */
  let stationId = null;        // blocking choice
  let stationData = null;      // loaded station JSON
  let monthlySeries = null;    // monthlyGapSeries(stationData.monthly)
  let sampleMonths = [];       // distinct 'YYYY-MM' present in daily_sample
  let currentSampleMonth = null;
  let strategy = null;         // blocking choice within the game (equal footing)
  // One shuffled order for this session, shared by the option cards, the bar chart,
  // and the results-table columns so they always line up (re-shuffled on Reset lab).
  let strategyOrder = shuffle(STRATEGIES.slice());
  let holdoutFrac = HOLDOUT_OPTIONS[Math.floor(Math.random() * HOLDOUT_OPTIONS.length)];
  let progress = 2;            // furthest section index revealed (2 = station chooser onward)
  let holdoutRun = false;      // has the reader run the hidden-years test yet
  let hasCompleted = false;    // have they finished a full run once (enables the fast repeat path)
  // Section 1 midpoint / true-average overlays start hidden so the reader
  // reveals each candidate average themselves.
  const introShow = { mid: false, avg: false };

  let restoring = false;
  const beaconsSent = new Set();

  const els = {};
  [
    'introChart', 'introChartContainer', 'introTooltip',
    'introToggleMid', 'introToggleAvg', 'introReadout', 'introTable',
    'stationGrid', 'stationPrompt', 'stationChosen', 'stationChosenName',
    'toS3',
    'wiggleChart', 'wiggleChartContainer', 'wiggleTooltip', 'wiggleMonth',
    'wigglePrev', 'wiggleNext', 'wiggleReadout', 'toS4',
    'seasonChart', 'seasonChartContainer', 'seasonTooltip', 'seasonTraces', 'seasonBars', 'seasonReadout', 'toS5',
    'yearChart', 'yearChartContainer', 'yearTooltip', 'yearReadout', 'toS6',
    'strategyGrid', 'strategyPrompt', 'holdoutRow', 'holdoutButtons',
    'runHoldout', 'runHoldoutHint',
    'holdoutChart', 'holdoutChartContainer', 'holdoutReadout',
    'holdoutTable', 'holdoutChoice', 'runHoldoutRow', 'holdoutResult', 'toS7',
    'endSummary', 'resetLab', 'resetLabEnd', 'resultsBlock', 'resultsTable',
    'transferNote', 'transferExpander', 'addAll', 'resultsPct', 'resultsHead',
  ].forEach((id) => { els[id] = document.getElementById(id); });

  const sections = {
    s3: document.getElementById('measure'),
    s4: document.getElementById('seasonal'),
    s5: document.getElementById('yearly'),
    s6: document.getElementById('correct'),
    s7: document.getElementById('endcard'),
  };

  const SECTION_ORDER = [
    { key: 's3', idx: 3 },
    { key: 's4', idx: 4 },
    { key: 's5', idx: 5 },
    { key: 's6', idx: 6 },
    { key: 's7', idx: 7 },
  ];

  function stationById(id) {
    return stations.find((s) => s.id === id) || null;
  }

  /* ── Canvas helpers (matches the site chart style used by the other labs) ─ */
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

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
    return step * mag;
  }

  // Generic framed axes; xTicks is an array of {v,label}. Returns coordinate
  // mappers. yUnit appended to y labels.
  function drawFrame(ctx, W, H, pad, xLo, xHi, yLo, yHi, xTicks, yUnit) {
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
      ctx.fillText(`${v.toFixed(2)}${yUnit ? ' ' + yUnit : ''}`, pad.left - 6, y + 4);
    }
    ctx.textAlign = 'center';
    (xTicks || []).forEach((t) => {
      ctx.fillText(t.label, xp(t.v), H - 8);
    });
    return { xp, yp, cW, cH };
  }

  // Dashed zero line.
  function drawZero(ctx, xp, yp, xLo, xHi, cW, pad) {
    ctx.strokeStyle = 'rgba(212,168,85,0.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yp(0));
    ctx.lineTo(pad.left + cW, yp(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawLine(ctx, pts, xp, yp, color, width = 1.6) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => { ctx[i === 0 ? 'moveTo' : 'lineTo'](xp(p.x), yp(p.y)); });
    ctx.stroke();
  }

  function drawDots(ctx, pts, xp, yp, color, r = 2.6) {
    ctx.fillStyle = color;
    pts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(xp(p.x), yp(p.y), r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function extentOf(values, padFrac = 0.08, minPad = 0.2) {
    let lo = Infinity; let hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * padFrac || minPad;
    return { lo: lo - pad, hi: hi + pad };
  }

  // Symmetric extent about zero (for gap charts, so neither sign is exaggerated).
  function symExtent(values, minHalf = 0.2) {
    let m = minHalf;
    for (const v of values) m = Math.max(m, Math.abs(v));
    return { lo: -m * 1.1, hi: m * 1.1 };
  }

  const GOLD = () => cssVar('--accent') || '#d4a855';
  const BLUE = () => cssVar('--series-obs') || '#5090f8';
  const MUTED = () => cssVar('--muted') || '#5a6880';

  /* ── Section 1: intro day ───────────────────────────────────────────── */
  function drawIntroChart() {
    const container = els.introChartContainer;
    const canvas = els.introChart;
    if (!container || !canvas) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const hours = introDay.hours;
    const temps = introDay.temps;
    const values = temps.concat([introDay.tmax, introDay.tmin]);
    if (introShow.mid) values.push(introDay.midpoint);
    if (introShow.avg) values.push(introDay.true_mean);
    const yExt = extentOf(values, 0.1, 1);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const xTicks = [0, 6, 12, 18, 23].map((h) => ({ v: h, label: `${h}h` }));
    const frame = drawFrame(ctx, W, H, pad, 0, 23, yExt.lo, yExt.hi, xTicks, '');

    // High / low marker lines.
    ctx.strokeStyle = 'rgba(212,168,85,0.25)';
    ctx.setLineDash([3, 3]);
    [introDay.tmax, introDay.tmin].forEach((v) => {
      ctx.beginPath();
      ctx.moveTo(pad.left, frame.yp(v));
      ctx.lineTo(pad.left + frame.cW, frame.yp(v));
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // The day's curve.
    const pts = hours.map((h, i) => ({ x: h, y: temps[i] }));
    drawLine(ctx, pts, frame.xp, frame.yp, cssVar('--text-secondary') || '#a8a090', 1.8);
    drawDots(ctx, pts, frame.xp, frame.yp, cssVar('--text-secondary') || '#a8a090', 2.2);

    // Candidate averages (revealed on toggle).
    const drawHLine = (v, color, label) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pad.left, frame.yp(v));
      ctx.lineTo(pad.left + frame.cW, frame.yp(v));
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${label} ${v.toFixed(2)}`, pad.left + 6, frame.yp(v) - 4);
    };
    if (introShow.mid) drawHLine(introDay.midpoint, GOLD(), 'midpoint');
    if (introShow.avg) drawHLine(introDay.true_mean, BLUE(), 'all-day average');

    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Hourly temperature through ${introDay.date} at ${introDay.station}, with the day’s high and low marked.`);

    // Readout.
    if (els.introReadout) {
      const parts = [`High ${introDay.tmax.toFixed(1)}°`, `Low ${introDay.tmin.toFixed(1)}°`];
      if (introShow.mid) parts.push(`Midpoint ${introDay.midpoint.toFixed(2)}°`);
      if (introShow.avg) parts.push(`All-day average ${introDay.true_mean.toFixed(2)}°`);
      if (introShow.mid && introShow.avg) {
        parts.push(`They differ by ${fmtSigned(introDay.midpoint - introDay.true_mean)}° on this day`);
      }
      els.introReadout.textContent = parts.join('  ·  ');
    }
  }

  function fillIntroTable() {
    if (!els.introTable) return;
    const tbody = els.introTable.querySelector('tbody');
    tbody.innerHTML = introDay.hours.map((h, i) =>
      `<tr><td>${h}:00</td><td>${introDay.temps[i].toFixed(1)}</td></tr>`).join('');
  }

  /* ── Section 3: daily wiggle ────────────────────────────────────────── */
  function sampleForMonth(month) {
    return stationData.daily_sample
      .filter((d) => d.d.slice(0, 7) === month && d.mid != null && d.avg != null)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
  }

  function drawWiggleChart() {
    const container = els.wiggleChartContainer;
    const canvas = els.wiggleChart;
    if (!container || !canvas || !currentSampleMonth) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const days = sampleForMonth(currentSampleMonth);
    if (!days.length) return;
    const values = [];
    days.forEach((d) => { values.push(d.mid, d.avg); });
    const yExt = extentOf(values, 0.12, 1);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const dayNums = days.map((d) => Number(d.d.slice(8, 10)));
    const xLo = Math.min(...dayNums);
    const xHi = Math.max(...dayNums);
    const step = Math.max(1, Math.round((xHi - xLo) / 6));
    const xTicks = [];
    for (let dn = xLo; dn <= xHi; dn += step) xTicks.push({ v: dn, label: String(dn) });
    const frame = drawFrame(ctx, W, H, pad, xLo, xHi, yExt.lo, yExt.hi, xTicks, '°');

    // Gap ribbons: a faint vertical stroke from avg to mid for each day.
    ctx.strokeStyle = 'rgba(212,168,85,0.30)';
    ctx.lineWidth = 1;
    days.forEach((d, i) => {
      const x = frame.xp(dayNums[i]);
      ctx.beginPath();
      ctx.moveTo(x, frame.yp(d.avg));
      ctx.lineTo(x, frame.yp(d.mid));
      ctx.stroke();
    });

    const midPts = days.map((d, i) => ({ x: dayNums[i], y: d.mid, d }));
    const avgPts = days.map((d, i) => ({ x: dayNums[i], y: d.avg, d }));
    drawLine(ctx, avgPts, frame.xp, frame.yp, BLUE(), 1.6);
    drawDots(ctx, avgPts, frame.xp, frame.yp, BLUE(), 2.2);
    drawLine(ctx, midPts, frame.xp, frame.yp, GOLD(), 1.6);
    drawDots(ctx, midPts, frame.xp, frame.yp, GOLD(), 2.2);

    wiggleLayout = { xp: frame.xp, dayNums, days };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Daily midpoint and all-day average for ${currentSampleMonth} at ${stationData.name}.`);

    if (els.wiggleReadout) {
      const gaps = days.map((d) => d.mid - d.avg);
      const meanGap = gaps.reduce((s, x) => s + x, 0) / gaps.length;
      const minGap = Math.min(...gaps);
      const maxGap = Math.max(...gaps);
      els.wiggleReadout.textContent =
        `${days.length} days · daily gap ranges ${fmtSigned(minGap)} to ${fmtSigned(maxGap)}° ` +
        `· this month’s average gap ${fmtSigned(meanGap)}°`;
    }
  }

  let wiggleLayout = null;

  function updateWiggleMonthLabel() {
    if (!els.wiggleMonth || !currentSampleMonth) return;
    const y = currentSampleMonth.slice(0, 4);
    const m = MONTH_FULL[Number(currentSampleMonth.slice(5, 7)) - 1];
    els.wiggleMonth.textContent = `${m} ${y}`;
  }

  function setSampleMonth(month, { fromRestore = false } = {}) {
    if (!sampleMonths.includes(month)) return;
    currentSampleMonth = month;
    updateWiggleMonthLabel();
    drawWiggleChart();
    if (!fromRestore) pushState();
  }

  function stepSampleMonth(dir) {
    const i = sampleMonths.indexOf(currentSampleMonth);
    const j = Math.min(sampleMonths.length - 1, Math.max(0, i + dir));
    setSampleMonth(sampleMonths[j]);
  }

  /* ── Section 4: seasonal shape ──────────────────────────────────────── */
  let showTraces = true;
  let showBars = true;
  // "on" colour for the individual-years toggle — the secondary text tone, so the
  // active chip is clearly distinct from the greyed/half-opacity "off" state (a
  // literal light grey read almost the same as off).
  const TRACE_SWATCH = () => cssVar('--text-secondary') || '#8a8a8a';

  function drawSeasonChart() {
    const container = els.seasonChartContainer;
    const canvas = els.seasonChart;
    if (!container || !canvas || !monthlySeries) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const clim = monthOfYearClimatology(monthlySeries);
    const means = clim.byMonth.map((b) => b.mean).filter((v) => v != null);
    // Always size the y-axis to the per-year spread, whether or not the traces
    // are shown, so toggling them never rescales the axis (that motion reads as
    // distracting and makes the two views hard to compare).
    const allTraceVals = clim.traces.flatMap((t) => t.values.filter((v) => v != null));
    const yExt = symExtent(means.concat(allTraceVals), 0.3);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    // Thin the month labels on narrow screens so Jan…Dec don't overlap (bars are
    // still drawn for every month — only the axis labels drop out).
    const availW = W - pad.left - pad.right;
    const kEvery = Math.max(1, Math.ceil(12 / Math.max(3, Math.floor(availW / 34))));
    const xTicks = MONTH_LABELS
      .map((label, i) => ({ v: i + 1, label }))
      .filter((_, i) => i % kEvery === 0);
    const frame = drawFrame(ctx, W, H, pad, 0.5, 12.5, yExt.lo, yExt.hi, xTicks, '°');
    drawZero(ctx, frame.xp, frame.yp, 0.5, 12.5, frame.cW, pad);

    // Faint per-year traces behind the bold average.
    if (showTraces) {
      ctx.strokeStyle = 'rgba(160,160,160,0.18)';
      ctx.lineWidth = 1;
      clim.traces.forEach((t) => {
        ctx.beginPath();
        let started = false;
        t.values.forEach((v, i) => {
          if (v == null) { started = false; return; }
          const x = frame.xp(i + 1); const y = frame.yp(v);
          ctx[started ? 'lineTo' : 'moveTo'](x, y);
          started = true;
        });
        ctx.stroke();
      });
    }

    // Bold month-of-year average bars.
    if (showBars) {
      const barW = (frame.cW / 12) * 0.6;
      clim.byMonth.forEach((b) => {
        if (b.mean == null) return;
        const x = frame.xp(b.mon);
        const y0 = frame.yp(0);
        const y1 = frame.yp(b.mean);
        ctx.fillStyle = 'rgba(212,168,85,0.55)';
        ctx.strokeStyle = GOLD();
        ctx.lineWidth = 1;
        const top = Math.min(y0, y1);
        ctx.fillRect(x - barW / 2, top, barW, Math.abs(y1 - y0));
        ctx.strokeRect(x - barW / 2, top, barW, Math.abs(y1 - y0));
      });
    }

    seasonLayout = { xp: frame.xp, clim };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Average gap for each calendar month at ${stationData.name}, with faint per-year traces behind.`);
    if (els.seasonReadout && means.length) {
      const lo = Math.min(...means);
      const hi = Math.max(...means);
      els.seasonReadout.textContent =
        `Across the record, the month-by-month average gap runs from ${fmtSigned(lo)} to ` +
        `${fmtSigned(hi)}° depending on the calendar month.`;
    }
  }

  let seasonLayout = null;

  /* ── Section 5: year by year ────────────────────────────────────────── */
  function drawYearChart() {
    const container = els.yearChartContainer;
    const canvas = els.yearChart;
    if (!container || !canvas || !monthlySeries) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const annual = annualGapSeries(monthlySeries, 6);
    if (!annual.length) return;
    const yExt = symExtent(annual.map((a) => a.gap), 0.15);
    const pad = { top: 16, right: 18, bottom: 34, left: 46 };
    const xLo = annual[0].year;
    const xHi = annual[annual.length - 1].year;
    const span = Math.max(1, xHi - xLo);
    // Fewer year labels on narrow screens — a 4-digit year needs ~56px, so on a
    // phone we show 2–3 rather than 6 to stop the labels overlapping.
    const availW = W - pad.left - pad.right;
    const maxTicks = Math.max(2, Math.floor(availW / 56));
    const step = niceStep(span, Math.min(6, maxTicks));
    const xTicks = [];
    for (let yr = Math.ceil(xLo / step) * step; yr <= xHi; yr += step) {
      xTicks.push({ v: yr, label: String(yr) });
    }
    const frame = drawFrame(ctx, W, H, pad, xLo - 0.5, xHi + 0.5, yExt.lo, yExt.hi, xTicks, '°');
    drawZero(ctx, frame.xp, frame.yp, xLo, xHi, frame.cW, pad);
    const pts = annual.map((a) => ({ x: a.year, y: a.gap, a }));
    drawLine(ctx, pts, frame.xp, frame.yp, GOLD(), 1.8);
    drawDots(ctx, pts, frame.xp, frame.yp, GOLD(), 2.6);
    yearLayout = { xp: frame.xp, annual };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Year-by-year average gap across the record at ${stationData.name}.`);
    if (els.yearReadout) {
      const gaps = annual.map((a) => a.gap);
      els.yearReadout.textContent =
        `${annual.length} full-ish years · yearly average gap ranges ${fmtSigned(Math.min(...gaps))} ` +
        `to ${fmtSigned(Math.max(...gaps))}°`;
    }
  }

  let yearLayout = null;

  /* ── Section 6: correction game ─────────────────────────────────────── */
  let showChoice = true;  // colour the reader's chosen strategy blue (a label, not a claim)

  function drawHoldoutChart() {
    const container = els.holdoutChartContainer;
    const canvas = els.holdoutChart;
    if (!container || !canvas || !monthlySeries || !holdoutRun) return;
    const { ctx, W, H } = setupCanvas(container, canvas);
    const res = runHoldout(monthlySeries, holdoutFrac, 'tail');
    const bars = strategyOrder.map((s) => ({ s, rmse: res.results[s].rmse }));
    const zeroRmse = res.results.zero ? res.results.zero.rmse : null;
    const maxRmse = Math.max(...bars.map((b) => b.rmse || 0), 0.01);
    const pad = { top: 18, right: 18, bottom: 52, left: 46 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;
    const yTop = niceStep(maxRmse, 4) * Math.ceil(maxRmse / niceStep(maxRmse, 4)) || maxRmse * 1.1;
    const yp = (v) => pad.top + (1 - v / yTop) * cH;
    // y grid
    ctx.strokeStyle = 'rgba(212,168,85,0.12)';
    ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
    ctx.font = '11px system-ui, sans-serif';
    const yStep = niceStep(yTop, 4);
    for (let v = 0; v <= yTop + 1e-9; v += yStep) {
      const y = yp(v);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(2), pad.left - 6, y + 4);
    }
    const slot = cW / bars.length;
    const barW = slot * 0.5;
    const layoutBars = [];
    bars.forEach((b, i) => {
      const cx = pad.left + slot * (i + 0.5);
      const h = b.rmse == null ? 0 : (b.rmse / yTop) * cH;
      const top = pad.top + cH - h;
      const chosen = showChoice && b.s === strategy;
      ctx.fillStyle = chosen ? 'rgba(80,144,248,0.55)' : 'rgba(212,168,85,0.45)';
      ctx.strokeStyle = chosen ? BLUE() : GOLD();
      ctx.lineWidth = chosen ? 2 : 1;
      ctx.fillRect(cx - barW / 2, top, barW, h);
      ctx.strokeRect(cx - barW / 2, top, barW, h);
      // value label: the miss in °C on top of each bar (the "% vs nothing" delta
      // lived here too, but it collided with the reference line at 320px — the
      // comparison now lives only in the readout below the chart).
      ctx.textAlign = 'center';
      if (b.rmse != null) {
        ctx.fillStyle = cssVar('--text') || '#e8e4d8';
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillText(`${b.rmse.toFixed(2)}°`, cx, top - 6);
      }
      // strategy short label (wrapped)
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
      const words = STRATEGY_SHORT[b.s].split('\n');
      words.forEach((w, li) => {
        ctx.fillText(w, cx, pad.top + cH + 16 + li * 13);
      });
      layoutBars.push({ ...b, cx, top, barW });
    });
    // Reference line at the gap-=-zero level, so the other bars can be read against
    // the unchanged-midpoint option. Neutral label, right-aligned clear of the bars'
    // value labels.
    if (zeroRmse != null) {
      const yref = yp(zeroRmse);
      ctx.save();
      ctx.strokeStyle = cssVar('--text-secondary') || '#a8a090';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, yref); ctx.lineTo(pad.left + cW, yref); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--text-secondary') || '#a8a090';
      ctx.textAlign = 'right';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('gap = zero', pad.left + cW, yref - 4);
      ctx.restore();
    }
    holdoutLayout = { bars: layoutBars, res };
    container.setAttribute('role', 'img');
    container.setAttribute('aria-label',
      `Leftover error on the hidden years for each strategy at ${stationData.name}.`);

    // Readout + table.
    if (els.holdoutReadout) {
      const nTest = res.test.length;
      const first = res.test[0] ? res.test[0].month : '';
      const last = res.test[res.test.length - 1] ? res.test[res.test.length - 1].month : '';
      const chosenR = strategy && res.results[strategy] ? res.results[strategy].rmse : null;
      let msg = `Each fix was built on the earlier years, then checked on ${nTest} hidden months ` +
        `(${first} to ${last}). Each bar is the typical amount it was still off by on those ` +
        `unseen months — shorter is better.`;
      if (chosenR != null && zeroRmse != null) {
        if (strategy === 'zero') {
          msg += ` You chose to change nothing: a typical miss of ±${zeroRmse.toFixed(2)}°C.`;
        } else {
          const pct = Math.round((1 - chosenR / zeroRmse) * 100);
          const cmp = pct > 0 ? `${pct}% less than doing nothing`
            : pct < 0 ? `${-pct}% more than doing nothing` : `about the same as doing nothing`;
          msg += ` Leaving the midpoint unchanged gives a typical miss of ±${zeroRmse.toFixed(2)}°C; ` +
            `your fix gives ±${chosenR.toFixed(2)}°C — ${cmp}.`;
        }
      }
      els.holdoutReadout.textContent = msg;
    }
    fillHoldoutTable(res);
  }

  const STRATEGY_SHORT = {
    zero: 'Gap = zero',
    constant: 'Average\ngap',
    seasonal: 'Season-\nshaped',
  };

  let holdoutLayout = null;

  function fillHoldoutTable(res) {
    if (!els.holdoutTable) return;
    const tbody = els.holdoutTable.querySelector('tbody');
    tbody.innerHTML = strategyOrder.map((s) => {
      const r = res.results[s];
      const chosen = s === strategy ? ' (your choice)' : '';
      return `<tr><td>${STRATEGY_META[s].label}${chosen}</td>` +
        `<td>${fmtPlain(r.rmse, 3)}</td><td>${fmtPlain(r.mae, 3)}</td></tr>`;
    }).join('');
  }

  /* ── Section reveal / progress ──────────────────────────────────────── */
  function revealUpTo(idx, { scroll = false, fromRestore = false } = {}) {
    progress = Math.max(progress, idx);
    SECTION_ORDER.forEach(({ key, idx: i }) => {
      const sec = sections[key];
      if (!sec) return;
      if (i <= progress) sec.hidden = false;
    });
    syncContinueButtons();
    if (scroll && !fromRestore) {
      const target = SECTION_ORDER.find((s) => s.idx === idx);
      if (target && sections[target.key]) {
        sections[target.key].scrollIntoView({ behavior: scrollBehavior, block: 'start' });
      }
    }
    if (!fromRestore) pushState();
  }

  // A "Continue" button has done its job once the section it opens is showing;
  // hide it so it doesn't linger, and the section it opened stays open.
  function syncContinueButtons() {
    if (els.toS3) els.toS3.hidden = progress >= 4;
    if (els.toS4) els.toS4.hidden = progress >= 5;
    if (els.toS5) els.toS5.hidden = progress >= 6;
  }

  /* ── Station choice (blocking) ──────────────────────────────────────── */
  function renderStationCards() {
    const grid = els.stationGrid;
    grid.innerHTML = '';
    const tried = new Set(loadResults().map((r) => r.id));
    shuffle(stations).forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const done = tried.has(s.id);
      btn.className = 'station-card' + (s.id === stationId ? ' active' : '') + (done ? ' tried' : '');
      btn.dataset.stationId = s.id;
      btn.setAttribute('aria-pressed', s.id === stationId ? 'true' : 'false');
      const years = (s.n_months / 12);
      btn.innerHTML =
        `<span class="sc-card-text">` +
        `<span class="sc-since">${s.climate}</span>` +
        `<span class="sc-name">${s.name}</span>` +
        `<span class="sc-caveat">${s.place} · about ${years < 10 ? years.toFixed(0) : Math.round(years)} years of daily records</span>` +
        `</span>` +
        (done ? `<span class="sc-tried" aria-label="already tried">✓ tried</span>` : '');
      btn.addEventListener('click', () => chooseStation(s.id));
      grid.appendChild(btn);
    });
  }

  function updateStationCards() {
    document.querySelectorAll('#stationGrid .station-card').forEach((c) => {
      const active = c.dataset.stationId === stationId;
      c.classList.toggle('active', active);
      c.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // Sync the "✓ tried" badges to the saved results in place — without re-rendering
  // (and reshuffling) the grid — so a station tested on a repeat loop is marked as
  // soon as it lands in the histogram/table.
  function updateTriedBadges() {
    // Tried at the *current* hold-back fraction, so badges show what's left to do
    // for this table.
    const pct = currentPct();
    const tried = new Set(loadResults().filter((r) => r.pct === pct).map((r) => r.id));
    document.querySelectorAll('#stationGrid .station-card').forEach((card) => {
      const done = tried.has(card.dataset.stationId);
      card.classList.toggle('tried', done);
      let badge = card.querySelector('.sc-tried');
      if (done && !badge) {
        badge = document.createElement('span');
        badge.className = 'sc-tried';
        badge.setAttribute('aria-label', 'already tried');
        badge.textContent = '✓ tried';
        card.appendChild(badge);
      } else if (!done && badge) {
        badge.remove();
      }
    });
  }

  let loadToken = 0;
  async function chooseStation(id, { fromRestore = false } = {}) {
    const s = stationById(id);
    if (!s) return;
    stationId = id;
    updateStationCards();
    if (els.stationChosen) {
      els.stationChosen.hidden = false;
      els.stationChosenName.textContent = `${s.name}, ${s.place}`;
    }
    if (els.stationPrompt) els.stationPrompt.hidden = true;
    const token = ++loadToken;
    try {
      const resp = await fetch(`${dataBase}/${id}.json`);
      if (!resp.ok) throw new Error(`${resp.status}`);
      const data = await resp.json();
      if (token !== loadToken) return;
      stationData = data;
      monthlySeries = monthlyGapSeries(data.monthly);
      sampleMonths = [...new Set(data.daily_sample
        .filter((d) => d.mid != null && d.avg != null)
        .map((d) => d.d.slice(0, 7)))].sort();
      if (!sampleMonths.includes(currentSampleMonth)) {
        currentSampleMonth = sampleMonths[Math.floor(Math.random() * sampleMonths.length)];
      }
      updateWiggleMonthLabel();
      // Carry the reader's correction choice across stations so repeats compare
      // like-for-like; only the run itself must be redone for the new station's data.
      holdoutRun = false;
      if (els.strategyPrompt) els.strategyPrompt.hidden = !!strategy;
      if (els.holdoutRow) els.holdoutRow.hidden = !strategy;
      renderStrategyCards();
      updateRunHoldoutState();
      syncHoldoutGate();
      if (els.toS7) els.toS7.hidden = true;
      drawAllStation();
      if (!fromRestore) {
        beacon('01-station-selected');
        if (hasCompleted && strategy) {
          // Repeat visit: everything was earned on the first run, so open it all
          // and score this station straight away, then drop the reader at the end
          // graph so comparing station after station is low-scroll.
          doRunHoldout({ fromRestore: true });
          revealUpTo(7);
          const end = els.holdoutChartContainer;
          if (end) end.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
        } else {
          revealUpTo(3, { scroll: true });
        }
      }
    } catch (err) {
      if (token !== loadToken) return;
      console.error('station load failed', err);
      if (els.stationPrompt) {
        els.stationPrompt.hidden = false;
        els.stationPrompt.textContent = 'Could not load that station. Try another.';
      }
    }
  }

  function drawAllStation() {
    drawWiggleChart();
    drawSeasonChart();
    drawYearChart();
    drawHoldoutChart();
    updateEndSummary();
  }

  /* ── Strategy choice (blocking, equal footing) ──────────────────────── */
  function renderStrategyCards() {
    const grid = els.strategyGrid;
    if (!grid) return;
    grid.innerHTML = '';
    strategyOrder.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prediction-card' + (s === strategy ? ' chosen' : '');
      btn.dataset.strategy = s;
      btn.innerHTML =
        `<span class="prediction-card-label">${STRATEGY_META[s].label}</span>` +
        `<span class="prediction-card-desc">${STRATEGY_META[s].desc}</span>`;
      btn.addEventListener('click', () => chooseStrategy(s));
      grid.appendChild(btn);
    });
  }

  function chooseStrategy(s, { fromRestore = false } = {}) {
    if (!STRATEGIES.includes(s)) return;
    strategy = s;
    document.querySelectorAll('#strategyGrid .prediction-card').forEach((c) => {
      c.classList.toggle('chosen', c.dataset.strategy === s);
    });
    if (els.strategyPrompt) els.strategyPrompt.hidden = true;
    if (els.holdoutRow) els.holdoutRow.hidden = false;
    updateRunHoldoutState();
    syncHoldoutGate();
    if (holdoutRun) drawHoldoutChart();
    renderResults();  // move the highlighted column to the newly-chosen strategy
    if (!fromRestore) { beacon('02-strategy-selected'); pushState(); }
  }

  function updateRunHoldoutState() {
    if (!els.runHoldout) return;
    els.runHoldout.disabled = !strategy;
    els.runHoldoutHint.textContent = strategy
      ? 'Fits all three strategies on the years you keep, then measures each one’s leftover error on the years held back.'
      : 'Pick a strategy above first.';
  }

  // The "Test it on the hidden years" button is a gate: the bar chart stays hidden
  // until it is clicked, then the button retires (like the Continue gates) and the
  // result is shown. After that, changing strategy/holdout updates the chart live.
  function syncHoldoutGate() {
    if (els.runHoldoutRow) els.runHoldoutRow.hidden = holdoutRun;
    if (els.holdoutResult) els.holdoutResult.hidden = !holdoutRun;
  }

  function setHoldout(frac, { fromRestore = false } = {}) {
    if (!HOLDOUT_OPTIONS.includes(frac)) return;
    holdoutFrac = frac;
    document.querySelectorAll('[data-holdout]').forEach((btn) => {
      const active = Number(btn.getAttribute('data-holdout')) === frac;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (holdoutRun) {
      // Re-score the current station at the new fraction and record it there; the
      // table switches to this fraction's set of runs.
      drawHoldoutChart();
      recordResult();
    } else if (!fromRestore) {
      renderResults();  // switch the shown table to this fraction even before a run
    }
    if (!fromRestore) pushState();
  }

  function doRunHoldout({ fromRestore = false } = {}) {
    if (!strategy || !monthlySeries) return;
    holdoutRun = true;
    hasCompleted = true;
    syncHoldoutGate();   // reveal the result card (and retire the run button) before drawing
    drawHoldoutChart();
    if (els.toS7) els.toS7.hidden = false;
    updateEndSummary();
    recordResult();
    if (!fromRestore) {
      beacon('03-holdout-run');
      revealUpTo(7);
      pushState();
    }
  }

  /* ── End card ───────────────────────────────────────────────────────── */
  function updateEndSummary() {
    if (!els.endSummary || !stationData) return;
    els.endSummary.textContent =
      `You measured the gap at ${stationData.name}, saw its shape across the year and across the record, ` +
      `and tested three ways of correcting it on years the fit never saw.`;
  }

  /* ── Results table (persists across repeats, this device only) ───────── */
  const RESULTS_KEY = 'ara-results-v2';

  function loadResults() {
    try { return JSON.parse(localStorage.getItem(RESULTS_KEY)) || []; } catch (_) { return []; }
  }
  function saveResults(arr) {
    try { localStorage.setItem(RESULTS_KEY, JSON.stringify(arr)); } catch (_) {}
  }
  function currentPct() { return Math.round(holdoutFrac * 100); }

  // A result row for one station at one hold-back fraction. Rows carry a gap
  // summary too so the transfer ANOVA can run without re-loading each station.
  function buildRow(id, name, series, frac) {
    const res = runHoldout(series, frac, 'tail');
    // Transfer test summary from ANNUAL-mean gaps, not monthly. Monthly gaps run to
    // hundreds per station and are autocorrelated, which makes the between-station
    // F-test significant for any real spread (verdict predetermined by sample size).
    // Annual means (~20–85 per station, near-independent) let the test land on the
    // data, and make the between-vs-within comparison agree with its own p-value.
    const annual = annualGapSeries(series, 6);
    const nY = annual.length;
    const meanY = nY ? annual.reduce((s, a) => s + a.gap, 0) / nY : 0;
    const varY = nY > 1
      ? annual.reduce((s, a) => s + (a.gap - meanY) ** 2, 0) / (nY - 1)
      : null;
    // Annual means of a drifting gap are autocorrelated (the long station's
    // lag-1 r is ~+0.8), so nY overstates the independent evidence. Store the
    // effective count too and let the ANOVA use it, so slow drift doesn't get
    // mistaken for between-station certainty.
    const rY = lag1Autocorr(annual.map((a) => a.gap));
    return {
      id, name, pct: Math.round(frac * 100),
      zero: res.results.zero.rmse,
      constant: res.results.constant.rmse,
      seasonal: res.results.seasonal.rmse,
      nYears: nY, nEffYears: effectiveN(nY, rY), meanGap: meanY, varYear: varY,
    };
  }

  // Upsert keyed by station AND hold-back % — each station can hold one row per
  // fraction, so the reader can work through all stations × all fractions.
  function upsertResult(row) {
    const arr = loadResults().filter((r) => !(r.id === row.id && r.pct === row.pct));
    arr.push(row);
    saveResults(arr);
  }

  function recordResult() {
    if (!stationData || !monthlySeries) return;
    upsertResult(buildRow(stationData.id || stationId, stationData.name, monthlySeries, holdoutFrac));
    renderResults();
  }

  function renderResults() {
    if (!els.resultsTable) return;
    const pct = currentPct();
    const shown = loadResults().filter((r) => r.pct === pct);  // table for the current fraction
    // "Try another station" retires once every station is in this fraction's table.
    if (els.resetLabEnd) {
      const allTried = shown.length >= stations.length;
      els.resetLabEnd.disabled = allTried;
      els.resetLabEnd.textContent = allTried ? 'Every station tried' : 'Pick another';
    }
    // No point offering "add every station" once they're all in this table.
    if (els.addAll) {
      els.addAll.hidden = shown.length >= stations.length;
      els.addAll.disabled = !strategy;
    }
    updateTriedBadges();
    if (!els.resultsBlock) return;
    if (!shown.length) { els.resultsBlock.hidden = true; return; }
    els.resultsBlock.hidden = false;
    if (els.resultsPct) els.resultsPct.textContent = `${pct}%`;
    // Header + cells follow the session's shuffled option order, so the columns
    // line up with the option cards and the bar chart.
    if (els.resultsHead) {
      els.resultsHead.innerHTML =
        '<th scope="col">Station</th><th scope="col">Held back</th>' +
        strategyOrder.map((s) => `<th scope="col">${RESULTS_COL[s]}</th>`).join('');
    }
    const tb = els.resultsTable.querySelector('tbody');
    tb.innerHTML = shown.map((r) =>
      `<tr><td>${r.name}</td><td>${r.pct}%</td>` +
      strategyOrder.map((s) => `<td>${fmtPlain(r[s], 2)}</td>`).join('') +
      '</tr>').join('');
    highlightChoiceColumn();
    renderTransfer(shown);
  }

  const RESULTS_COL = { zero: 'Doing nothing', constant: 'Average gap', seasonal: 'Season-shaped' };

  // Move the highlight to the currently-selected strategy's column (its position in
  // the session order, after the Station and Held-back columns).
  function highlightChoiceColumn() {
    if (!els.resultsTable) return;
    els.resultsTable.querySelectorAll('.col-choice').forEach((c) => c.classList.remove('col-choice'));
    if (!strategy) return;
    const ci = 2 + strategyOrder.indexOf(strategy);
    const th = els.resultsTable.querySelectorAll('thead th')[ci];
    if (th) th.classList.add('col-choice');
    els.resultsTable.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.children[ci]) tr.children[ci].classList.add('col-choice');
    });
  }

  // Fill the current fraction's table with every station in one go (uses the
  // chosen strategy for the highlight; each row still stores all three).
  async function addAllStations() {
    if (!strategy || !els.addAll) return;
    const frac = holdoutFrac;
    els.addAll.disabled = true;
    const label = els.addAll.textContent;
    els.addAll.textContent = 'Adding…';
    for (const s of stations) {
      try {
        const resp = await fetch(`${dataBase}/${s.id}.json`);
        if (!resp.ok) continue;
        const data = await resp.json();
        upsertResult(buildRow(s.id, s.name, monthlyGapSeries(data.monthly), frac));
      } catch (_) { /* skip a station that fails to load */ }
    }
    els.addAll.textContent = label;
    renderResults();
  }

  // Once ≥2 stations are in the table, test whether one station's fix could carry
  // to another: a one-way ANOVA of the gap, between stations vs within each.
  function renderTransfer(arr) {
    if (!els.transferNote) return;
    const groups = arr
      .filter((r) => r.varYear != null && r.nYears >= 2)
      // Use the autocorrelation-discounted year count (rows saved before that
      // field existed fall back to the raw count).
      .map((r) => ({
        n: r.nEffYears != null ? r.nEffYears : r.nYears,
        mean: r.meanGap,
        var: r.varYear,
      }));
    const a = oneWayAnova(groups);
    if (!a) {
      els.transferNote.hidden = true;
      if (els.transferExpander) els.transferExpander.hidden = true;
      return;
    }
    els.transferNote.hidden = false;
    if (els.transferExpander) els.transferExpander.hidden = false;
    const spread = a.meanSpread.toFixed(2);
    const within = a.withinSd.toFixed(2);
    // Reusing station A's constant on station B misses by (mean_B − mean_A); over
    // random pairs that has SD ≈ √2 × the spread of station means.
    const reuse = (a.meanSpread * Math.SQRT2).toFixed(2);
    const p = fPValue(a.F, a.dfB, a.dfW);
    const pstr = p < 0.001 ? 'p < 0.001' : p < 0.01 ? 'p < 0.01'
      : p < 0.05 ? 'p < 0.05' : `p = ${p.toFixed(2)}`;
    const sig = p < 0.05;
    // The headline is the test's own verdict, so it can never fight the p-value.
    const line = sig ? 'stations really differ' : 'no clear difference between stations';
    const desc = `Station to station, the average gap varies by about ±${spread}°C; within a ` +
      `single station it varies about ±${within}°C from year to year. ` +
      (sig
        ? `That between-station difference is more than the year-to-year wobble can explain ` +
          `(${pstr}), so borrowing one station's average-gap fix for another would typically ` +
          `be off by about ±${reuse}°C. (This is about reusing one raw number — not whether ` +
          `the gap could be predicted from a station's climate.)`
        : `That between-station difference is within what the year-to-year wobble could ` +
          `produce (${pstr}), so one station's average-gap fix is a reasonable stand-in here ` +
          `— add more stations to be surer.`);
    els.transferNote.innerHTML =
      `<span class="transfer-pill${sig ? '' : ' quiet'}">` +
      `<span class="tp-main">${line}</span><span class="tp-p">${pstr}</span></span>` +
      `<span class="transfer-desc">${desc}</span>`;
  }

  /* ── URL state ──────────────────────────────────────────────────────── */
  function pushState() {
    if (restoring) return;
    const params = new URLSearchParams();
    params.set('v', '1');
    if (stationId) params.set('s', stationId);
    if (currentSampleMonth) params.set('m', currentSampleMonth);
    if (strategy) params.set('st', strategy);
    params.set('h', String(holdoutFrac));
    if (holdoutRun) params.set('run', '1');
    params.set('p', String(progress));
    const hash = '#' + params.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readState() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    if (hash && params.get('v') !== '1') return {};
    const h = parseFloat(params.get('h') || '');
    return {
      s: params.get('s'),
      m: params.get('m'),
      st: params.get('st'),
      h: HOLDOUT_OPTIONS.includes(h) ? h : null,
      run: params.get('run') === '1',
      p: parseInt(params.get('p') || '', 10),
    };
  }

  /* ── Beacons ────────────────────────────────────────────────────────── */
  function beacon(name) {
    if (beaconsSent.has(name)) return;
    sendFeatureBeacon(`${funnelPrefix}/${name}`);
    beaconsSent.add(name);
  }

  /* ── Tooltips (nearest-x) ───────────────────────────────────────────── */
  function nearestXTooltip(canvas, tooltip, getLayout, describe) {
    if (!canvas || !tooltip) return;
    canvas.addEventListener('mousemove', (e) => {
      const layout = getLayout();
      if (!layout || !layout.points || !layout.points.length) { tooltip.hidden = true; return; }
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      let best = null; let bestDist = Infinity;
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
      } else { tooltip.hidden = true; }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  /* ── Reset ──────────────────────────────────────────────────────────── */
  // Full clean slate — the header "Reset lab" button. Re-locks every section,
  // restores the Continue buttons, clears the correction choice and the saved
  // results (so the "tried" badges clear too), and goes to the top.
  function reset() {
    stationId = null;
    stationData = null;
    monthlySeries = null;
    strategy = null;
    holdoutRun = false;
    hasCompleted = false;
    currentSampleMonth = null;   // don't leave a stale month in the URL after reset
    progress = 2;
    strategyOrder = shuffle(STRATEGIES.slice());  // fresh random option order
    saveResults([]);
    introShow.mid = false;
    introShow.avg = false;
    setIntroToggleVisual(els.introToggleMid, false, GOLD());
    setIntroToggleVisual(els.introToggleAvg, false, BLUE());
    drawIntroChart();
    SECTION_ORDER.forEach(({ key }) => { if (sections[key]) sections[key].hidden = true; });
    syncContinueButtons();  // restore the Continue buttons for the next run through
    if (els.stationChosen) els.stationChosen.hidden = true;
    if (els.stationPrompt) { els.stationPrompt.hidden = false; els.stationPrompt.textContent = 'Choose a station above to continue.'; }
    renderStationCards();
    renderResults();  // saved comparison is now empty → hides the table, clears badges/button
    renderStrategyCards();
    if (els.strategyPrompt) els.strategyPrompt.hidden = false;
    if (els.holdoutRow) els.holdoutRow.hidden = true;
    holdoutFrac = HOLDOUT_OPTIONS[Math.floor(Math.random() * HOLDOUT_OPTIONS.length)];
    setHoldout(holdoutFrac, { fromRestore: true });
    updateRunHoldoutState();
    syncHoldoutGate();
    pushState();
    window.scrollTo({ top: 0, behavior: scrollBehavior });
  }

  // "Try another station": everything stays unlocked (the gates were opened on the
  // first run and only "Reset lab" closes them again). Just scroll back up to the
  // chooser so the reader can pick the next one; the pick auto-runs and drops them
  // back at the results.
  function goChooseAnother() {
    const stationSection = document.getElementById('station');
    if (stationSection) stationSection.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
  }

  /* ── Wiring / init ──────────────────────────────────────────────────── */
  // Style the intro series toggles like the site's standard legend buttons:
  // a coloured border/label matching the line they reveal when on, greyed
  // (series-off) when off. Both start off, so the reader reveals each.
  function setIntroToggleVisual(btn, on, color) {
    if (!btn) return;
    btn.classList.toggle('series-off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.style.borderColor = on ? color : '';
    btn.style.color = on ? color : '';
  }

  function wireIntroToggles() {
    if (els.introToggleMid) {
      els.introToggleMid.addEventListener('click', () => {
        introShow.mid = !introShow.mid;
        setIntroToggleVisual(els.introToggleMid, introShow.mid, GOLD());
        drawIntroChart();
      });
    }
    if (els.introToggleAvg) {
      els.introToggleAvg.addEventListener('click', () => {
        introShow.avg = !introShow.avg;
        setIntroToggleVisual(els.introToggleAvg, introShow.avg, BLUE());
        drawIntroChart();
      });
    }
  }

  function wireRedraws() {
    window.addEventListener('klymot:theme-toggled', () => {
      drawIntroChart();
      if (stationData) drawAllStation();
    });
    const ro = new ResizeObserver(() => {
      drawIntroChart();
      if (stationData) drawAllStation();
    });
    [els.introChartContainer, els.wiggleChartContainer, els.seasonChartContainer,
      els.yearChartContainer, els.holdoutChartContainer].forEach((c) => { if (c) ro.observe(c); });
  }

  function initialize() {
    fillIntroTable();
    drawIntroChart();
    renderStationCards();
    renderStrategyCards();
    wireIntroToggles();
    wireRedraws();

    if (els.wigglePrev) els.wigglePrev.addEventListener('click', () => stepSampleMonth(-1));
    if (els.wiggleNext) els.wiggleNext.addEventListener('click', () => stepSampleMonth(1));
    if (els.seasonBars) {
      setIntroToggleVisual(els.seasonBars, showBars, GOLD());
      els.seasonBars.addEventListener('click', () => {
        showBars = !showBars;
        setIntroToggleVisual(els.seasonBars, showBars, GOLD());
        drawSeasonChart();
      });
    }
    if (els.seasonTraces) {
      setIntroToggleVisual(els.seasonTraces, showTraces, TRACE_SWATCH());
      els.seasonTraces.addEventListener('click', () => {
        showTraces = !showTraces;
        setIntroToggleVisual(els.seasonTraces, showTraces, TRACE_SWATCH());
        drawSeasonChart();
      });
    }
    if (els.toS3) els.toS3.addEventListener('click', () => revealUpTo(4, { scroll: true }));
    if (els.toS4) els.toS4.addEventListener('click', () => revealUpTo(5, { scroll: true }));
    if (els.toS5) els.toS5.addEventListener('click', () => revealUpTo(6, { scroll: true }));
    document.querySelectorAll('[data-holdout]').forEach((btn) => {
      btn.addEventListener('click', () => setHoldout(Number(btn.getAttribute('data-holdout'))));
    });
    if (els.runHoldout) els.runHoldout.addEventListener('click', () => doRunHoldout());
    if (els.resetLab) els.resetLab.addEventListener('click', () => reset());
    if (els.resetLabEnd) els.resetLabEnd.addEventListener('click', () => goChooseAnother());

    // "your choice" legend: colour the reader's chosen strategy blue (on by default).
    if (els.holdoutChoice) {
      setIntroToggleVisual(els.holdoutChoice, showChoice, BLUE());
      els.holdoutChoice.addEventListener('click', () => {
        showChoice = !showChoice;
        setIntroToggleVisual(els.holdoutChoice, showChoice, BLUE());
        if (holdoutRun) drawHoldoutChart();
      });
    }
    if (els.addAll) els.addAll.addEventListener('click', () => addAllStations());
    renderResults();

    nearestXTooltip(els.wiggleChart, els.wiggleTooltip,
      () => (wiggleLayout ? { xp: wiggleLayout.xp, points: wiggleLayout.days.map((d, i) => ({ x: wiggleLayout.dayNums[i], d })) } : null),
      (p) => `${p.d.d}  midpoint ${p.d.mid.toFixed(2)} · all-day ${p.d.avg.toFixed(2)} · gap ${fmtSigned(p.d.mid - p.d.avg)}°`);
    nearestXTooltip(els.seasonChart, els.seasonTooltip,
      () => (seasonLayout
        ? { xp: seasonLayout.xp, points: seasonLayout.clim.byMonth.filter((b) => b.mean != null).map((b) => ({ x: b.mon, b })) }
        : null),
      (p) => `${MONTH_FULL[p.b.mon - 1]}  average gap ${fmtSigned(p.b.mean)}° (${p.b.n} years)`);
    nearestXTooltip(els.yearChart, els.yearTooltip,
      () => (yearLayout ? { xp: yearLayout.xp, points: yearLayout.annual.map((a) => ({ x: a.year, a })) } : null),
      (p) => `${p.a.year}  average gap ${fmtSigned(p.a.gap)}° (${p.a.n} months)`);

    // Restore from URL.
    restoring = true;
    const st = readState();
    setHoldout(st.h != null ? st.h : holdoutFrac, { fromRestore: true });
    restoring = false;

    if (st.s && stationById(st.s)) {
      chooseStation(st.s, { fromRestore: true }).then(() => {
        if (st.m && sampleMonths.includes(st.m)) setSampleMonth(st.m, { fromRestore: true });
        if (st.st) chooseStrategy(st.st, { fromRestore: true });
        if (st.run) doRunHoldout({ fromRestore: true });
        const p = Number.isFinite(st.p) ? st.p : 3;
        revealUpTo(Math.max(3, p), { fromRestore: true });
        pushState();
      });
    } else {
      pushState();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
}
