/**
 * Calibration.js
 *
 * Headless recalibration of maintenance / TDEE, cached to a sheet and served
 * over the API so an agent can read the current estimate without re-deriving
 * it from raw logs.
 *
 * Why this exists:
 *   The Phase Analysis tools answer "what happened across my whole history".
 *   They run only from the spreadsheet menu, so nothing notices when the
 *   picture changes. The Oct 2025 - Feb 2026 regain ran ~5 months; a trailing
 *   estimate would have flagged it the whole time, but nobody was looking.
 *
 * What it does NOT do:
 *   It never writes your goals. A single window estimate carries a standard
 *   error of roughly +/- 400 kcal/day (see maintenanceGrossSE), so auto-tuning
 *   a target from it would chase water weight and logging noise. It reports;
 *   you decide.
 *
 * Method:
 *   Energy balance over a trailing window, independent of phase detection:
 *     maintenance_gross = avg_gross_intake - 3500 * (lb/day weight trend)
 *   The trend is an OLS slope over daily weights in the window, so its
 *   standard error propagates straight into the maintenance estimate.
 *
 * Units:
 *   maintenanceGross is GROSS kcal and already includes exercise.
 *   maintenanceEffective is in the same units as the Summary "Effective kcal"
 *   column: gross - dTarget * burn. These differ by ~700 kcal/day; mixing them
 *   up is the single easiest mistake to make with this data.
 *
 * Entry points:
 *   runCalibrationNow()          menu: recompute + cache + show
 *   calibrationWeekly()          time-driven trigger target
 *   installCalibrationTrigger()  one-time trigger setup
 *   GET /calibration             latest cached row (agent-facing)
 *   GET /calibration?fresh=true  recompute now
 *   GET /calibration/history     cached rows over time
 */

const CAL_SHEET = 'Calibration';

/** Trailing window for the estimate. 56d balances noise against staleness. */
const CAL_WINDOW_DAYS = 56;

/** Consecutive weekly calibrations trending against goal before flagging. */
const CAL_DRIFT_RUNS = 3;

/**
 * Baseline PAL (TDEE/BMR) before logged exercise: resting + TEF + NEAT.
 * Only used for the optional under-logging estimate. 1.30 is a desk-job
 * baseline; the estimate is roughly +/- 180 kcal per 0.1 of error here.
 */
const CAL_BASE_PAL = 1.30;

/** Fraction of logged burn treated as real when predicting TDEE. */
const CAL_BURN_REALISM = 0.7;

// ─── Entry points ────────────────────────────────────────────────────────────

function runCalibrationNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cal = cal_compute_(ss, Session.getScriptTimeZone());
  if (!cal || cal.error) {
    pa_notify_('Calibration failed: ' + ((cal && cal.error) || 'no data'));
    return;
  }
  cal_appendRow_(ss, cal);
  const ci = Math.round(1.96 * cal.maintenanceGrossSE);
  SpreadsheetApp.getUi().alert(
    'Calibration (' + cal.window.startDate + ' to ' + cal.window.endDate + ')\n\n' +
    'Weight ' + pa_round_(cal.weightNow, 1) + ' lb, trend ' +
      pa_round_(cal.window.trendLbPerWeek, 2) + ' lb/week\n\n' +
    'Maintenance GROSS: ' + Math.round(cal.maintenanceGross) + ' +/- ' + ci + ' kcal/day\n' +
    'Maintenance EFFECTIVE (d=' + cal.dTarget + '): ' +
      Math.round(cal.maintenanceEffective) + ' kcal/day\n' +
      '  -> compare this one to the Summary "Effective kcal" column\n\n' +
    (cal.targetAtGoalRate
      ? 'To lose ' + cal.goalRateLbPerWeek + ' lb/week: ' +
        Math.round(cal.targetAtGoalRate.effectivePerDay) + ' effective/day\n\n'
      : '') +
    (cal.drift.flag ? 'DRIFT: ' + cal.drift.message + '\n\n' : '') +
    'Written to the "' + CAL_SHEET + '" sheet.'
  );
}

/** Time-driven trigger target. No UI in this context. */
function calibrationWeekly() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cal = cal_compute_(ss, Session.getScriptTimeZone());
  if (!cal || cal.error) {
    console.error('[Calibration] weekly run failed: ' + ((cal && cal.error) || 'no data'));
    return;
  }
  cal_appendRow_(ss, cal);
  console.log('[Calibration] maintenance ' + Math.round(cal.maintenanceGross) +
              ' gross, trend ' + pa_round_(cal.window.trendLbPerWeek, 2) + ' lb/wk' +
              (cal.drift.flag ? ' DRIFT: ' + cal.drift.message : ''));
}

/** Install (or reinstall) the weekly trigger. Safe to run more than once. */
function installCalibrationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'calibrationWeekly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('calibrationWeekly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  pa_notify_('Weekly calibration trigger installed (Mondays ~6am).');
}

// ─── Core computation ────────────────────────────────────────────────────────

/**
 * Compute the current calibration. Returns a plain object (JSON-safe) or
 * { error }. Never touches the UI, so it is safe from triggers and doGet.
 */
function cal_compute_(ss, tz) {
  const series = pa_readDailySeries_(ss, tz);
  if (!series) return { error: 'Could not read Metrics/Summary series' };

  const settings = pa_readSettings_(ss);
  const rate = parseFloat(settings['activity_credit_rate']);
  const dTarget = isFinite(rate) ? rate : PA_D_TARGET;

  const n = series.dates.length;
  const start = Math.max(0, n - CAL_WINDOW_DAYS);

  // Intake: skip incomplete-log days, same floor the phase tools use, so a
  // day you forgot to log does not read as a day you did not eat.
  let sumG = 0, sumB = 0, cntG = 0;
  for (let i = start; i < n; i++) {
    const g = series.gross[i];
    if (g === null || g < PA_MIN_GROSS_KCAL) continue;
    sumG += g;
    sumB += series.burn[i] || 0;
    cntG++;
  }
  if (cntG < 14) return { error: 'Only ' + cntG + ' logged days in the last ' + CAL_WINDOW_DAYS };

  // Weight trend: OLS slope of raw daily weights on day index.
  const xs = [], ys = [];
  for (let i = start; i < n; i++) {
    if (series.weights[i] === null) continue;
    xs.push(i - start); ys.push(series.weights[i]);
  }
  if (xs.length < 10) return { error: 'Only ' + xs.length + ' weigh-ins in the window' };
  const fit = cal_olsWithSE_(xs, ys);
  if (!fit) return { error: 'Weight trend not estimable (no spread in dates)' };

  const avgGross = sumG / cntG;
  const avgBurn  = sumB / cntG;

  // Energy balance. 3500 kcal/lb is the standard fat-mass approximation.
  const maintenanceGross   = avgGross - 3500 * fit.slope;
  const maintenanceGrossSE = 3500 * fit.slopeSE;
  const maintenanceEffective = maintenanceGross - dTarget * avgBurn;

  let weightNow = null;
  for (let i = n - 1; i >= 0; i--) {
    if (series.weights[i] !== null) { weightNow = series.weights[i]; break; }
  }

  const out = {
    computedAt: new Date().toISOString(),
    windowDays: CAL_WINDOW_DAYS,
    window: {
      startDate: series.dates[start],
      endDate: series.dates[n - 1],
      loggedDays: cntG,
      weighIns: xs.length,
      avgGross: avgGross,
      avgBurn: avgBurn,
      avgEffective: avgGross - dTarget * avgBurn,
      trendLbPerWeek: fit.slope * 7,
      trendSELbPerWeek: fit.slopeSE * 7,
    },
    weightNow: weightNow,
    dTarget: dTarget,
    dMeasure: PA_D_MEASURE,
    maintenanceGross: maintenanceGross,
    maintenanceGrossSE: maintenanceGrossSE,
    maintenanceGrossSENaive: 3500 * fit.slopeSENaive,
    seNote: 'maintenanceGrossSE is adjusted for day-to-day weight autocorrelation ' +
            '(rho=' + pa_round_(fit.residualAutocorr, 2) + ', inflation x' +
            pa_round_(fit.seInflation, 2) + '). It is a WITHIN-window error and still ' +
            'understates true uncertainty; see historicalSpread.',
    maintenanceEffective: maintenanceEffective,
    units: 'maintenanceGross includes exercise; maintenanceEffective = gross - dTarget*burn ' +
           'and is what the Summary "Effective kcal" column shows.',
  };

  const goalRate = parseFloat(settings['target_loss_rate_lb_per_week']);
  if (isFinite(goalRate) && goalRate !== 0) {
    const deficit = Math.abs(goalRate) * 3500 / 7;
    out.goalRateLbPerWeek = goalRate;
    out.targetAtGoalRate = {
      grossPerDay: maintenanceGross - deficit,
      effectivePerDay: maintenanceEffective - deficit,
      restDayGrossPerDay: maintenanceEffective - deficit,
      note: 'effectivePerDay is a REST-DAY figure. On a training day add ' +
            'dTarget * that day\'s burn to get gross.',
    };
  }

  out.historicalSpread = cal_historicalSpread_(ss);
  out.bmr = cal_bmrBlock_(settings, weightNow, avgBurn, maintenanceGross);
  out.drift = cal_drift_(ss, fit.slope * 7, goalRate);
  return out;
}

/**
 * OLS slope with an autocorrelation-adjusted standard error.
 *
 * Daily weights are strongly autocorrelated -- water and glycogen swings
 * persist for days -- so the textbook OLS standard error, which assumes
 * independent observations, is far too small. On real data it understates the
 * uncertainty by roughly a factor of 2-3, which would present a maintenance
 * estimate as precise to +/-85 kcal/day when repeated windows actually
 * disagree by several hundred.
 *
 * Correction: inflate by sqrt((1+rho)/(1-rho)) using the lag-1 residual
 * autocorrelation, the standard AR(1) effective-sample-size adjustment.
 *
 * Even the adjusted figure is a WITHIN-window number. It says how well the
 * trend is pinned down given this window's data; it cannot see regime change
 * (a training block ending, logging habits shifting). Compare consecutive
 * rows in /calibration/history for the honest spread.
 */
function cal_olsWithSE_(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
  const my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx <= 1e-9 || n < 3) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  const resid = [];
  for (let i = 0; i < n; i++) resid.push(ys[i] - (intercept + slope * xs[i]));
  let sse = 0;
  for (let i = 0; i < n; i++) sse += resid[i] * resid[i];
  const naiveSE = Math.sqrt((sse / (n - 2)) / sxx);

  // Lag-1 residual autocorrelation, over consecutive in-window observations.
  let num = 0;
  for (let i = 0; i + 1 < n; i++) num += resid[i] * resid[i + 1];
  let rho = sse > 0 ? num / sse : 0;
  if (!isFinite(rho) || rho < 0) rho = 0;
  if (rho > 0.95) rho = 0.95;               // guard the variance blow-up
  const inflation = Math.sqrt((1 + rho) / (1 - rho));

  return {
    slope: slope,
    intercept: intercept,
    slopeSE: naiveSE * inflation,
    slopeSENaive: naiveSE,
    residualAutocorr: rho,
    seInflation: inflation,
  };
}

/**
 * Spread of recent cached maintenance estimates -- the empirical uncertainty,
 * which includes regime change that a within-window SE cannot see. Returns
 * null until enough calibrations have accumulated.
 */
function cal_historicalSpread_(ss) {
  const rows = cal_history_(ss);
  const vals = rows.slice(0, 12)
    .map(function (r) { return parseFloat(r.maintenanceGross); })
    .filter(function (v) { return isFinite(v); });
  if (vals.length < 4) {
    return { available: false, n: vals.length, note: 'Needs at least 4 cached calibrations.' };
  }
  const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  let ss2 = 0;
  vals.forEach(function (v) { ss2 += (v - mean) * (v - mean); });
  return {
    available: true,
    n: vals.length,
    mean: mean,
    sd: Math.sqrt(ss2 / (vals.length - 1)),
    note: 'Standard deviation across recent calibrations. Wider than maintenanceGrossSE ' +
          'because it includes real change in training and logging, not just estimation error. ' +
          'This is the number to trust when deciding how much a single reading should move a goal.',
  };
}

/**
 * Optional BMR anchor. Needs dob and height_cm in Settings; biological_sex
 * defaults to male (the Mifflin-St Jeor constant differs by 166 kcal).
 *
 * impliedUnderLogKcal compares measured maintenance against a predicted TDEE.
 * It leans on CAL_BASE_PAL and CAL_BURN_REALISM, so treat it as an order of
 * magnitude, not a measurement.
 */
function cal_bmrBlock_(settings, weightLb, avgBurn, maintenanceGross) {
  const dob = settings['dob'];
  const heightCm = parseFloat(settings['height_cm']);
  if (!dob || !isFinite(heightCm) || weightLb === null) {
    return { available: false, note: 'Set dob (YYYY-MM-DD) and height_cm in Settings to enable the BMR anchor.' };
  }
  const born = new Date(dob);
  if (isNaN(born.getTime())) return { available: false, note: 'Settings dob is not a readable date.' };

  // Age from date of birth, recomputed every run so it never goes stale.
  const ageYears = (new Date() - born) / (365.2425 * 24 * 3600 * 1000);
  const kg = weightLb / 2.20462;
  const sex = String(settings['biological_sex'] || 'male').trim().toLowerCase();
  const bmr = 10 * kg + 6.25 * heightCm - 5 * ageYears + (sex === 'female' ? -161 : 5);

  const predictedTDEE = bmr * CAL_BASE_PAL + CAL_BURN_REALISM * avgBurn;
  return {
    available: true,
    ageYears: ageYears,
    weightKg: kg,
    bmr: bmr,
    basePAL: CAL_BASE_PAL,
    burnRealism: CAL_BURN_REALISM,
    predictedTDEE: predictedTDEE,
    impliedPAL: bmr > 0 ? maintenanceGross / bmr : null,
    impliedUnderLogKcal: predictedTDEE - maintenanceGross,
    note: 'impliedUnderLogKcal = predicted TDEE - maintenance measured from LOGGED intake. ' +
          'A large positive value means logged intake understates real intake by about that much. ' +
          'Sensitive to basePAL and burnRealism; treat as approximate.',
  };
}

/**
 * Flag when recent calibrations keep trending against the goal.
 * Reads back over cached rows so a slow regain surfaces without anyone asking.
 */
function cal_drift_(ss, trendLbPerWeek, goalRate) {
  const wantLoss = isFinite(goalRate) && goalRate !== 0;
  const sh = ss.getSheetByName(CAL_SHEET);
  const against = function (t) { return wantLoss ? t >= 0 : false; };

  let run = against(trendLbPerWeek) ? 1 : 0;
  if (sh && run > 0) {
    const data = sh.getDataRange().getValues();
    const head = data.length ? data[0] : [];
    const col = head.indexOf('trendLbPerWeek');
    if (col >= 0) {
      for (let r = data.length - 1; r >= 1; r--) {
        const v = parseFloat(data[r][col]);
        if (!isFinite(v) || !against(v)) break;
        run++;
      }
    }
  }
  const flag = run >= CAL_DRIFT_RUNS;
  return {
    consecutiveAgainstGoal: run,
    threshold: CAL_DRIFT_RUNS,
    flag: flag,
    message: flag
      ? run + ' consecutive calibrations trending ' +
        (trendLbPerWeek >= 0 ? 'flat or upward' : 'against goal') +
        ' while the goal is ' + goalRate + ' lb/week.'
      : '',
  };
}

// ─── Sheet cache ─────────────────────────────────────────────────────────────

const CAL_COLUMNS = [
  'computedAt', 'windowStart', 'windowEnd', 'loggedDays', 'weighIns',
  'weightNow', 'trendLbPerWeek', 'trendSELbPerWeek',
  'avgGross', 'avgBurn', 'dTarget',
  'maintenanceGross', 'maintenanceGrossSE', 'maintenanceEffective',
  'goalRateLbPerWeek', 'targetEffectivePerDay',
  'bmr', 'impliedPAL', 'impliedUnderLogKcal',
  'driftRun', 'driftFlag',
];

function cal_appendRow_(ss, cal) {
  let sh = ss.getSheetByName(CAL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CAL_SHEET);
    sh.appendRow(CAL_COLUMNS);
    sh.setFrozenRows(1);
  }
  const b = cal.bmr || {};
  const t = cal.targetAtGoalRate || {};
  sh.appendRow([
    cal.computedAt, cal.window.startDate, cal.window.endDate,
    cal.window.loggedDays, cal.window.weighIns,
    pa_round_(cal.weightNow, 1),
    pa_round_(cal.window.trendLbPerWeek, 3), pa_round_(cal.window.trendSELbPerWeek, 3),
    Math.round(cal.window.avgGross), Math.round(cal.window.avgBurn), cal.dTarget,
    Math.round(cal.maintenanceGross), Math.round(cal.maintenanceGrossSE),
    Math.round(cal.maintenanceEffective),
    cal.goalRateLbPerWeek === undefined ? '' : cal.goalRateLbPerWeek,
    t.effectivePerDay === undefined ? '' : Math.round(t.effectivePerDay),
    b.available ? Math.round(b.bmr) : '',
    b.available ? pa_round_(b.impliedPAL, 2) : '',
    b.available ? Math.round(b.impliedUnderLogKcal) : '',
    cal.drift.consecutiveAgainstGoal, cal.drift.flag ? 'YES' : '',
  ]);
}

/** Latest cached calibration as an object, or null. */
function cal_latest_(ss) {
  const sh = ss.getSheetByName(CAL_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = sh.getRange(sh.getLastRow(), 1, 1, sh.getLastColumn()).getValues()[0];
  const out = {};
  head.forEach(function (h, i) { if (h) out[h] = row[i]; });
  return out;
}

/** All cached calibrations, newest first. */
function cal_history_(ss) {
  const sh = ss.getSheetByName(CAL_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getDataRange().getValues();
  const head = data.shift();
  const rows = data.filter(function (r) { return r[0]; }).map(function (r) {
    const o = {};
    head.forEach(function (h, i) { if (h) o[h] = r[i]; });
    return o;
  });
  rows.reverse();
  return rows;
}
