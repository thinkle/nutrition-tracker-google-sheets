/**
 * PhaseAnalysis.js
 *
 * Weight phase detection, exercise-discount sweep, and data-driven calorie
 * target — all grounded in Tom's own observed data, not calculator estimates.
 *
 * Menu items (added to onOpen in Menu.js):
 *   Nutrition Tools > Analysis > Run Phase Analysis
 *   Nutrition Tools > Analysis > Run Discount Sweep
 *   Nutrition Tools > Analysis > Compute Target…
 *
 * Data sources (same spreadsheet):
 *   Metrics sheet  — Date, Weight
 *   Summary sheet  — Date, Gross kcal, kcal burned, carbs burned, macros
 *     (Summary is formula-computed; we read its computed values via getValues())
 *
 * Key concept: effective intake = gross − d · burn
 *   d = 0  → ignore exercise entirely
 *   d = 1  → full "net calories" (subtract all logged burn)
 *   D_MEASURE = empirical value from the sweep (best predicts weight change)
 *   D_TARGET  = conservative eating discount (≤ D_MEASURE; banks a safety margin
 *               because device burns are inflated and exercise drives compensatory
 *               eating; never auto-promoted from D_MEASURE without deliberate choice)
 */

// ─── Tuneable parameters ─────────────────────────────────────────────────────

/** lb reversal tolerance. Real phases (~10–16 lb) >> daily noise (~2 lb). */
const PA_THRESH = 2.0;

/** Minimum phase duration to keep. */
const PA_MIN_WEEKS = 2;

/**
 * Minimum gross kcal for a day to be included in nutrition averages.
 * Days below this are treated as incomplete logs and excluded — they would
 * otherwise drag down avg gross AND avg burn (since burn is only averaged
 * over the same days). 500 kcal is a reasonable "you definitely logged today"
 * floor; raise it if you see many partial-day logs contaminating the averages.
 */
const PA_MIN_GROSS_KCAL = 500;

/**
 * D_MEASURE: discount used in phase stats and maintenance fitting.
 * Start at 1.0 (full credit); run the Discount Sweep to find a better estimate
 * and update this constant, then re-run Phase Analysis and Compute Target.
 */
const PA_D_MEASURE = 1.0;

/**
 * D_TARGET: discount for daily eating targets.
 * Deliberately conservative (< D_MEASURE) to bank a safety margin.
 * Update after reviewing the sweep; do not auto-set to d*.
 */
const PA_D_TARGET = 0.5;

/**
 * Weight-maintenance scaling coefficient in effective-intake units.
 * Textbook gross is ~10–12 kcal/lb; in compressed effective units use smaller.
 * This is an ASSUMPTION — refit once enough data with real weight spread exists.
 * The live data can't resolve this because weight and intake are collinear
 * (Tom eats less when heavier, inflating the apparent weight-maintenance link).
 */
const PA_K_PER_LB = 6; // eff-kcal/day per lb of body weight

// ─── Sheet names ─────────────────────────────────────────────────────────────
const PA_SHEET_PHASE = 'Phase Analysis';
const PA_SHEET_SWEEP = 'Discount Sweep';

// ─── Entry points ─────────────────────────────────────────────────────────────

function runPhaseAnalysis() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  const series = pa_readDailySeries_(ss, tz);
  if (!series) return;

  // Read D_TARGET from Settings (activity_credit_rate) so the phase table shows
  // effective intake at both D_MEASURE (for analysis) and D_TARGET (for daily goals).
  const settings = pa_readSettings_(ss);
  const settingsRate = parseFloat(settings['activity_credit_rate']);
  const dTarget = isFinite(settingsRate) ? settingsRate : PA_D_TARGET;

  const smoothed = pa_smoothWeights_(series.weights);
  const pivotIdxs = pa_zigzagPivots_(smoothed, PA_THRESH);
  const phases = pa_buildPhases_(series, smoothed, pivotIdxs, PA_D_MEASURE, PA_MIN_WEEKS);

  if (phases.length === 0) {
    SpreadsheetApp.getUi().alert(
      'No phases detected. Possible causes:\n' +
      '  • Not enough data (need several months)\n' +
      '  • All segments shorter than MIN_WEEKS (' + PA_MIN_WEEKS + ')\n' +
      '  • Smoothed weight has too many gaps (check Metrics sheet)\n' +
      'Try lowering PA_THRESH or PA_MIN_WEEKS at the top of PhaseAnalysis.js.'
    );
    return;
  }

  // Derive maintenance from phases (rate=0 → maintenance intake).
  const maintCalc = pa_computeTargetCalcs_(phases, series, PA_D_MEASURE, dTarget, PA_K_PER_LB, 0);

  // Trailing 21-day average intake vs maintenance estimate.
  const trailing = pa_trailingEstimate_(series, maintCalc, 21, PA_D_MEASURE);

  pa_writePhaseSheet_(ss, phases, maintCalc, trailing, PA_D_MEASURE, dTarget);

  SpreadsheetApp.getUi().alert(
    'Phase Analysis complete: ' + phases.length + ' phases written to "' + PA_SHEET_PHASE + '".\n\n' +
    'Effective kcal maintenance (d=' + dTarget + '): ' + Math.round(maintCalc.maintenanceWeightedNow) + '/day at ' + pa_round_(maintCalc.wNow, 1) + ' lb\n' +
    '  → Keep Summary "Effective kcal" at this level to hold weight.\n\n' +
    'Net kcal maintenance (d=' + PA_D_MEASURE + '): ' + Math.round(maintCalc.maintenanceNow) + '/day\n' +
    '  → Analysis number; matches Discount Sweep calibration.\n\n' +
    'Next: run "Discount Sweep" to calibrate D_MEASURE, then "Compute Target…" for a daily goal.'
  );
}

function runDiscountSweep() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  const series = pa_readDailySeries_(ss, tz);
  if (!series) return;

  const smoothed = pa_smoothWeights_(series.weights);
  const sweepResult = pa_discountSweep_(series, smoothed);

  pa_writeSweepSheet_(ss, sweepResult);

  const w = sweepResult.weekly;
  const m = sweepResult.monthly;
  SpreadsheetApp.getUi().alert(
    'Discount Sweep complete.\n\n' +
    'Weekly scale:  d* ≈ ' + (w.dStar !== null ? w.dStar.toFixed(2) : 'n/a') +
      '  (R² = ' + (w.rSqStar !== null ? w.rSqStar.toFixed(3) : 'n/a') + ', n=' + w.n + ' blocks)\n' +
    'Monthly scale: d* ≈ ' + (m.dStar !== null ? m.dStar.toFixed(2) : 'n/a') +
      '  (R² = ' + (m.rSqStar !== null ? m.rSqStar.toFixed(3) : 'n/a') + ', n=' + m.n + ' blocks)\n\n' +
    'Gross ↔ Burn correlation: ' + sweepResult.corrGrossBurn.toFixed(3) +
      (Math.abs(sweepResult.corrGrossBurn) > 0.7 ? ' ⚠ HIGH — d* weakly identified' : '') + '\n\n' +
    'Lead with the monthly d* for body-comp conclusions.\n' +
    'Full results in "' + PA_SHEET_SWEEP + '".'
  );
}

function computeTarget() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const resp1 = ui.prompt(
    'Compute Calorie Target (1/2)',
    'Enter desired weight-change rate (lb/week).\n' +
    'Negative = loss  (e.g. -0.5)\n' +
    'Zero     = maintenance\n' +
    'Positive = gain  (e.g. +0.25)',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp1.getSelectedButton() !== ui.Button.OK) return;
  const desiredRate = parseFloat(resp1.getResponseText());
  if (isNaN(desiredRate)) { ui.alert('Invalid input. Enter a number like -0.5.'); return; }

  // Read current activity_credit_rate from Settings as the default D_TARGET.
  // These are the same concept: how much of logged exercise burn to allow eating back.
  const settings = pa_readSettings_(ss);
  const settingsRate = parseFloat(settings['activity_credit_rate']);
  const defaultDTarget = isFinite(settingsRate) ? settingsRate : PA_D_TARGET;

  const resp2 = ui.prompt(
    'Compute Calorie Target (2/2)',
    'Enter D_TARGET: the exercise discount for your eating goal.\n' +
    'This should be ≤ D_MEASURE (' + PA_D_MEASURE + ').\n\n' +
    'Examples:\n' +
    '  0.5 = eat back 50% of logged burn (conservative, recommended)\n' +
    '  0.7 = eat back 70%\n' +
    '  1.0 = eat back 100% (full net — risky if device over-estimates)\n\n' +
    'Current Settings value (activity_credit_rate): ' + defaultDTarget + '\n' +
    'Press OK to keep it, or type a new value.',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp2.getSelectedButton() !== ui.Button.OK) return;
  const dTargetInput = resp2.getResponseText().trim();
  const dTarget = dTargetInput === '' ? defaultDTarget : parseFloat(dTargetInput);
  if (isNaN(dTarget) || dTarget < 0 || dTarget > 2) {
    ui.alert('Invalid D_TARGET. Enter a number between 0 and 2 (e.g. 0.5).'); return;
  }

  // If the user changed D_TARGET, offer to sync it back to Settings so the
  // Summary "Effective kcal" column uses the same discount.
  if (dTarget !== defaultDTarget) {
    const syncResp = ui.alert(
      'Update Settings?',
      'You changed D_TARGET from ' + defaultDTarget + ' to ' + dTarget + '.\n\n' +
      'Write this back to the Settings sheet (activity_credit_rate)?\n' +
      'This keeps the Summary "Effective kcal" column in sync with your target.',
      ui.ButtonSet.YES_NO
    );
    if (syncResp === ui.Button.YES) {
      pa_writeToSettings_(ss, 'activity_credit_rate', dTarget);
    }
  }

  const tz = Session.getScriptTimeZone();

  const series = pa_readDailySeries_(ss, tz);
  if (!series) return;

  const smoothed = pa_smoothWeights_(series.weights);
  const pivotIdxs = pa_zigzagPivots_(smoothed, PA_THRESH);
  const phases = pa_buildPhases_(series, smoothed, pivotIdxs, PA_D_MEASURE, PA_MIN_WEEKS);

  if (phases.length < 2) {
    ui.alert(
      'Need at least 2 phases to fit maintenance.\n' +
      'Run "Run Phase Analysis" first to confirm phases are being detected.'
    );
    return;
  }

  const calc = pa_computeTargetCalcs_(phases, series, PA_D_MEASURE, dTarget, PA_K_PER_LB, desiredRate);
  pa_writeTargetBlock_(ss, calc);

  ui.alert(
    'Target computed for rate = ' + desiredRate + ' lb/wk at ' + pa_round_(calc.wNow, 1) + ' lb:\n\n' +
    'Effective kcal maintenance (d=' + dTarget + '): ' + Math.round(calc.maintenanceWeightedNow) + '/day\n' +
    'Effective kcal target: ' + Math.round(calc.targetWeighted) + '/day\n\n' +
    'Rest day gross ≈ ' + Math.round(calc.targetWeighted) + ' kcal\n' +
    'Exercise day: gross = ' + Math.round(calc.targetWeighted) + ' + ' + dTarget + ' × burn\n\n' +
    '(Analysis maintenance at d=' + calc.dMeasure + ': ' + Math.round(calc.maintenanceNow) + ' net-kcal/day)\n\n' +
    'Written to "' + PA_SHEET_PHASE + '".'
  );
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Reads Metrics (weight) and Summary (nutrition) into aligned daily arrays.
 * Weight: averages duplicate weigh-ins per day, then interpolates gaps ≤ 6 days.
 * Nutrition: only days with gross > 0 (actually logged food) are populated.
 */
function pa_readDailySeries_(ss, tz) {
  const ui = SpreadsheetApp.getUi();

  // ── Weight ──────────────────────────────────────────────────────────────────
  const mSheet = ss.getSheetByName('Metrics');
  if (!mSheet) { ui.alert('Metrics sheet not found.'); return null; }
  const mData = mSheet.getDataRange().getValues();
  if (mData.length < 2) { ui.alert('Metrics sheet has no data.'); return null; }

  const weightMap = {}; // date → [weights]
  for (let r = 1; r < mData.length; r++) {
    const dk = pa_toDateKey_(mData[r][0], tz);
    const w = Number(mData[r][1]);
    if (!dk || !isFinite(w) || w <= 0) continue;
    if (!weightMap[dk]) weightMap[dk] = [];
    weightMap[dk].push(w);
  }

  // ── Nutrition (Summary) ─────────────────────────────────────────────────────
  const sSheet = ss.getSheetByName('Summary');
  if (!sSheet) { ui.alert('Summary sheet not found. Run "Reset Summary Formulas for Activities" first.'); return null; }
  const sData = sSheet.getDataRange().getValues();
  if (sData.length < 2) { ui.alert('Summary sheet has no data.'); return null; }

  const sHeaders = sData[0].map(h => String(h).trim());
  const sCol = {
    date:        sHeaders.indexOf('Date'),
    gross:       sHeaders.indexOf('Gross kcal'),
    burn:        sHeaders.indexOf('kcal burned'),
    carbsBurned: sHeaders.indexOf('carbs burned'),
    protein:     sHeaders.indexOf('Total protein'),
    fat:         sHeaders.indexOf('Total fat'),
    carbs:       sHeaders.indexOf('Gross carbs'),
    addedSugar:  sHeaders.indexOf('Total added_sugar'),
    fiber:       sHeaders.indexOf('Total fiber'),
  };

  const missing = Object.entries(sCol).filter(([, i]) => i === -1).map(([n]) => n);
  if (missing.length) {
    ui.alert('Summary sheet is missing columns: ' + missing.join(', ') + '.\nRun "Reset Summary Formulas for Activities" to rebuild it.');
    return null;
  }

  const summaryMap = {}; // date → nutrition row
  for (let r = 1; r < sData.length; r++) {
    const dk = pa_toDateKey_(sData[r][sCol.date], tz);
    if (!dk) continue;
    const gross = Number(sData[r][sCol.gross]) || 0;
    if (gross < PA_MIN_GROSS_KCAL) continue; // skip incomplete-log days
    summaryMap[dk] = {
      gross,
      burn:        Number(sData[r][sCol.burn])        || 0,
      carbsBurned: Number(sData[r][sCol.carbsBurned]) || 0,
      protein:     Number(sData[r][sCol.protein])     || 0,
      fat:         Number(sData[r][sCol.fat])          || 0,
      carbs:       Number(sData[r][sCol.carbs])        || 0,
      addedSugar:  Number(sData[r][sCol.addedSugar])  || 0,
      fiber:       Number(sData[r][sCol.fiber])        || 0,
    };
  }

  // ── Build continuous daily index ────────────────────────────────────────────
  const allDateKeys = [...new Set([...Object.keys(weightMap), ...Object.keys(summaryMap)])].sort();
  if (allDateKeys.length === 0) { ui.alert('No data found in Metrics or Summary sheets.'); return null; }

  // Use noon UTC to avoid DST edge cases when stepping by 86400 s
  const startMs = new Date(allDateKeys[0] + 'T12:00:00Z').getTime();
  const endMs   = new Date(allDateKeys[allDateKeys.length - 1] + 'T12:00:00Z').getTime();
  const nDays   = Math.round((endMs - startMs) / 86400000) + 1;

  const dates = [];
  const dateToIdx = {};
  for (let i = 0; i < nDays; i++) {
    const dk = Utilities.formatDate(new Date(startMs + i * 86400000), tz, 'yyyy-MM-dd');
    dates.push(dk);
    dateToIdx[dk] = i;
  }

  // Weight: average per-day, then interpolate gaps ≤ 6 days
  const weightsRaw = new Array(nDays).fill(null);
  for (const [dk, ws] of Object.entries(weightMap)) {
    const idx = dateToIdx[dk];
    if (idx !== undefined) weightsRaw[idx] = ws.reduce((a, b) => a + b, 0) / ws.length;
  }
  const weights = pa_interpolateWeights_(weightsRaw, 6);

  // Nutrition: null where not logged
  const gross       = new Array(nDays).fill(null);
  const burn        = new Array(nDays).fill(null);
  const carbsBurned = new Array(nDays).fill(null);
  const protein     = new Array(nDays).fill(null);
  const fat         = new Array(nDays).fill(null);
  const carbs       = new Array(nDays).fill(null);
  const addedSugar  = new Array(nDays).fill(null);
  const fiber       = new Array(nDays).fill(null);

  for (const [dk, row] of Object.entries(summaryMap)) {
    const idx = dateToIdx[dk];
    if (idx === undefined) continue;
    gross[idx]       = row.gross;
    burn[idx]        = row.burn;
    carbsBurned[idx] = row.carbsBurned;
    protein[idx]     = row.protein;
    fat[idx]         = row.fat;
    carbs[idx]       = row.carbs;
    addedSugar[idx]  = row.addedSugar;
    fiber[idx]       = row.fiber;
  }

  return { dates, dateToIdx, weights, gross, burn, carbsBurned, protein, fat, carbs, addedSugar, fiber };
}

/**
 * 28-day centered moving average of daily weights.
 * Window: [i−13, i+14] inclusive. Requires ≥ 18 non-null days.
 * Non-causal (uses future days) — correct for retrospective analysis but means
 * the last ~14 days produce null (no right-side window), which is expected.
 * Do NOT use for real-time "am I losing right now" — see pa_trailingEstimate_.
 */
function pa_smoothWeights_(weights) {
  const n = weights.length;
  const MIN_NON_NULL = 18;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 13);
    const hi = Math.min(n - 1, i + 14);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= hi; j++) {
      if (weights[j] !== null) { sum += weights[j]; cnt++; }
    }
    if (cnt >= MIN_NON_NULL) out[i] = sum / cnt;
  }
  return out;
}

/**
 * Zigzag pivot detector on the smoothed weight series.
 * Segments on net displacement > thresh, not instantaneous slope sign.
 * Null smoothed values are skipped; pivots are expressed as original array indices.
 *
 * Algorithm per spec (corrected version that locks in direction before tracking pivots):
 *   direction starts at 0 (unknown); locks to ±1 once price moves thresh from start.
 *   Once locked, tracks the extreme in that direction; reverses when it retraces thresh.
 */
function pa_zigzagPivots_(smoothed, thresh) {
  // Compact to non-null values, keeping original indices
  const valid = [];
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] !== null) valid.push({ i, v: smoothed[i] });
  }
  if (valid.length < 2) return [0, smoothed.length - 1];

  const n = valid.length;
  let direction = 0; // 0 = unknown, +1 = rising, -1 = falling
  let extIdx = valid[0].i;
  let extVal = valid[0].v;
  const pivots = [valid[0].i];

  for (let k = 1; k < n; k++) {
    const { i, v } = valid[k];

    if (direction === 0) {
      if (v - valid[0].v >= thresh) {
        direction = 1; extIdx = i; extVal = v;
      } else if (valid[0].v - v >= thresh) {
        direction = -1; extIdx = i; extVal = v;
      }
    } else if (direction === 1) {
      if (v > extVal) {
        extIdx = i; extVal = v; // extend the up-run
      } else if (extVal - v >= thresh) {
        pivots.push(extIdx); // pivot at the high
        direction = -1; extIdx = i; extVal = v;
      }
    } else { // direction === -1
      if (v < extVal) {
        extIdx = i; extVal = v; // extend the down-run
      } else if (v - extVal >= thresh) {
        pivots.push(extIdx); // pivot at the low
        direction = 1; extIdx = i; extVal = v;
      }
    }
  }
  pivots.push(valid[n - 1].i);

  return [...new Set(pivots)].sort((a, b) => a - b);
}

/**
 * Converts pivot index pairs to phase objects with per-phase nutrition averages.
 * Drops phases shorter than minWeeks and phases with no nutrition data.
 */
function pa_buildPhases_(series, smoothed, pivotIdxs, dMeasure, minWeeks) {
  const minDays = minWeeks * 7;
  const phases = [];

  for (let p = 0; p < pivotIdxs.length - 1; p++) {
    const startIdx = pivotIdxs[p];
    const endIdx   = pivotIdxs[p + 1];
    const days = endIdx - startIdx;
    if (days < minDays) continue;

    const startW = smoothed[startIdx];
    const endW   = smoothed[endIdx];
    if (startW === null || endW === null) continue;

    const weeks = days / 7;
    const rate = (endW - startW) / weeks;
    const type = rate < -0.1 ? 'LOSS' : rate > 0.1 ? 'GAIN' : 'HOLD';

    let sumGross = 0, sumBurn = 0, sumCarbsBurned = 0;
    let sumProtein = 0, sumFat = 0, sumCarbs = 0, sumAddedSugar = 0, sumFiber = 0;
    let nutritionDays = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      if (series.gross[i] === null) continue;
      sumGross       += series.gross[i];
      sumBurn        += series.burn[i]        || 0;
      sumCarbsBurned += series.carbsBurned[i] || 0;
      sumProtein     += series.protein[i]     || 0;
      sumFat         += series.fat[i]          || 0;
      sumCarbs       += series.carbs[i]        || 0;
      sumAddedSugar  += series.addedSugar[i]  || 0;
      sumFiber       += series.fiber[i]        || 0;
      nutritionDays++;
    }

    if (nutritionDays === 0) continue;

    const avgGross = sumGross / nutritionDays;
    const avgBurn  = sumBurn  / nutritionDays;

    phases.push({
      num: phases.length + 1,
      type,
      startIdx, endIdx,
      startDate: series.dates[startIdx],
      endDate:   series.dates[endIdx],
      days, weeks, startW, endW, rate,
      avgGross,
      avgBurn,
      avgCarbsBurned: sumCarbsBurned / nutritionDays,
      // avgEff computed at dMeasure; store raw gross+burn so sweep can recompute at any d
      avgEff:    avgGross - dMeasure * avgBurn,
      avgProtein: sumProtein / nutritionDays,
      avgFat:     sumFat    / nutritionDays,
      avgCarbs:   sumCarbs  / nutritionDays,
      avgAddedSugar: sumAddedSugar / nutritionDays,
      avgFiber:   sumFiber  / nutritionDays,
      nutritionDays,
    });
  }
  return phases;
}

/**
 * Sweeps d ∈ [0, 1.2] at weekly and monthly scales and runs the two-predictor
 * OLS regression to find the empirical exercise credit factor.
 *
 * Two scales answer different questions:
 *   Weekly: dominated by water/glycogen swings; d* often appears lower (artifact)
 *   Monthly: closer to fat-mass changes; generally higher d* and more meaningful
 *            for body-composition conclusions. Lead with this one.
 *
 * The OLS regression (ΔW = β0 + β1·gross + β2·burn) is mathematically equivalent
 * to the sweep; d* = −β2/β1 with a CI via the delta method. It also flags
 * collinearity (high gross↔burn correlation = d* weakly identified).
 */
function pa_discountSweep_(series, smoothed) {
  const weeklyBlocks  = pa_buildNonOverlappingBlocks_(series, smoothed, 7);
  const monthlyBlocks = pa_buildNonOverlappingBlocks_(series, smoothed, 28);

  const dGrid = [];
  for (let d100 = 0; d100 <= 120; d100 += 5) dGrid.push(d100 / 100);

  const weeklySweep  = pa_sweepBlocks_(weeklyBlocks,  dGrid);
  const monthlySweep = pa_sweepBlocks_(monthlyBlocks, dGrid);

  const weeklyOLS  = pa_olsDiscountRegress_(weeklyBlocks);
  const monthlyOLS = pa_olsDiscountRegress_(monthlyBlocks);

  // Gross↔burn correlation at weekly scale (more blocks = more reliable estimate)
  const grossArr = weeklyBlocks.map(b => b.gross);
  const burnArr  = weeklyBlocks.map(b => b.burn);
  const corrGrossBurn = pa_correlation_(grossArr, burnArr);

  return {
    weekly:  { ...weeklySweep,  ...weeklyOLS,  n: weeklyBlocks.length  },
    monthly: { ...monthlySweep, ...monthlyOLS, n: monthlyBlocks.length },
    dGrid,
    corrGrossBurn,
  };
}

/**
 * Non-overlapping blocks of blockSize days.
 * Each block: avg gross, avg burn (nutrition days only), deltaW/wk from smoothed.
 * Requires ≥ 40% of days to have nutrition data and non-null smoothed weight
 * at block start and end.
 *
 * Using non-overlapping blocks avoids the autocorrelation inflation that
 * plagued the older overlapping-window Correlation Report.
 */
function pa_buildNonOverlappingBlocks_(series, smoothed, blockSize) {
  const n = series.dates.length;
  const blocks = [];
  const minLogged = Math.ceil(blockSize * 0.4);

  for (let start = 0; start + blockSize <= n; start += blockSize) {
    const end = start + blockSize - 1;
    const wStart = smoothed[start];
    const wEnd   = smoothed[end];
    if (wStart === null || wEnd === null) continue;

    let sumGross = 0, sumBurn = 0, cnt = 0;
    for (let i = start; i <= end; i++) {
      if (series.gross[i] === null) continue;
      sumGross += series.gross[i];
      sumBurn  += series.burn[i] || 0;
      cnt++;
    }
    if (cnt < minLogged) continue;

    blocks.push({
      startDate: series.dates[start],
      endDate:   series.dates[end],
      gross:  sumGross / cnt,
      burn:   sumBurn  / cnt,
      // deltaW in lb/wk so it's scale-independent across block sizes
      deltaW: (wEnd - wStart) / (blockSize / 7),
      cnt,
    });
  }
  return blocks;
}

/**
 * For each d in dGrid, compute R²(effective_d, deltaW) across blocks.
 * The peak d is the one that explains the most weight-change variance.
 * A flat curve means the data can't distinguish high from low d.
 */
function pa_sweepBlocks_(blocks, dGrid) {
  if (blocks.length < 3) return { curve: [], dStar: null, rSqStar: null };

  const deltaW = blocks.map(b => b.deltaW);
  const curve = dGrid.map(d => {
    const eff = blocks.map(b => b.gross - d * b.burn);
    return { d, rSq: pa_rSquared_(eff, deltaW) };
  });

  let dStar = null, rSqStar = -Infinity;
  curve.forEach(({ d, rSq }) => { if (rSq > rSqStar) { rSqStar = rSq; dStar = d; } });
  return { curve, dStar, rSqStar };
}

/**
 * Two-predictor OLS: ΔW = β0 + β1·gross + β2·burn.
 * d* = −β2/β1 (implied discount); CI via the delta method.
 * Reports collinearity as a warning rather than silently returning a bad d*.
 */
function pa_olsDiscountRegress_(blocks) {
  const empty = { dStar: null, ciLo: null, ciHi: null, beta: null, corrGB: null, vif: null, warning: null, n: blocks.length };
  if (blocks.length < 4) return { ...empty, warning: 'Insufficient blocks for OLS (need ≥ 4).' };

  const X = blocks.map(b => [1, b.gross, b.burn]);
  const y = blocks.map(b => b.deltaW);

  const ols = pa_olsMultivariate_(X, y);
  if (!ols) return { ...empty, warning: 'OLS failed — nearly singular matrix (very high collinearity or constant inputs).' };

  const { beta, cov } = ols;
  const b1 = beta[1], b2 = beta[2];

  const grossArr = blocks.map(b => b.gross);
  const burnArr  = blocks.map(b => b.burn);
  const corrGB = pa_correlation_(grossArr, burnArr);
  const vif = corrGB * corrGB < 0.9999 ? 1 / (1 - corrGB * corrGB) : Infinity;

  let warning = null;
  if (Math.abs(corrGB) > 0.7) {
    warning = `High collinearity: corr(gross, burn) = ${corrGB.toFixed(2)}, VIF = ${vif.toFixed(1)}. d* is weakly identified — the data cannot pin the discount.`;
  }

  if (Math.abs(b1) < 1e-10) {
    return { ...empty, beta, corrGB, vif, warning: 'β1 ≈ 0 (gross has no predictive power); d* is not identified.' };
  }

  const dStar = -b2 / b1;

  // Delta method: Var(d*) where g(β) = −β2/β1, ∇g = [0, β2/β1², −1/β1]
  const grad = [0, b2 / (b1 * b1), -1 / b1];
  let varDstar = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) varDstar += grad[i] * cov[i][j] * grad[j];
  }
  const seDstar = Math.sqrt(Math.abs(varDstar));
  // 1.96 ≈ z_0.025; for n < 30 blocks a t-table would be tighter but this is fine for guidance
  const ci95 = 1.96 * seDstar;

  return { dStar, ciLo: dStar - ci95, ciHi: dStar + ci95, beta, corrGB, vif, warning, n: blocks.length };
}

/**
 * Derives maintenance and a calorie target from the phase regression.
 *
 * Runs the regression TWICE — at dMeasure and at dTarget — because they answer
 * different questions:
 *
 *   dMeasure regression: "what net-kcal intake predicts weight change?"
 *     Used for the Discount Sweep comparison and analysis. Maintenance here
 *     is in net-calorie units (hard to intuit but analytically correct).
 *
 *   dTarget regression: "what Effective-kcal intake predicts weight change?"
 *     Used for the PRACTICAL daily target. The rest-day gross target comes
 *     from this regression, because this is what the Summary Effective kcal
 *     column already shows. Maintenance and target are directly readable.
 *
 * Why two regressions instead of converting?
 *   The formula "gross = target_eff(dMeasure) + dTarget*burn" mixes units when
 *   dTarget ≠ dMeasure. On exercise days it over-counts the deficit because
 *   eff(dMeasure) = target_eff - (dMeasure-dTarget)*burn < target_eff. Using
 *   the dTarget regression avoids this and gives the rest-day target the user
 *   can directly read from the "Avg Eff kcal (d=dTarget)" column.
 *
 * Weight-scaling: maintenance(W) = maintenance_ref + kPerLb·(W − W_ref)
 *   W_ref = mean weight across phases. kPerLb is an ASSUMPTION — the data cannot
 *   fit it independently because weight and intake are collinear (Tom eats less
 *   when heavy, inflating the apparent weight→maintenance link). Short answer to
 *   "does it account for my higher weight during the loss phase?": yes, but only
 *   through this assumed coefficient, not from a fitted regression.
 */
function pa_computeTargetCalcs_(phases, series, dMeasure, dTarget, kPerLb, desiredRate) {
  const rates = phases.map(p => p.rate);
  const n     = phases.length;

  // Helper: simple OLS on one x-array, returns { slope, intercept } or NaN
  function ols1d_(xs) {
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<n;i++){sx+=xs[i];sy+=rates[i];sxx+=xs[i]*xs[i];sxy+=xs[i]*rates[i];}
    const mx=sx/n, my=sy/n, sxx2=sxx-n*mx*mx, sxy2=sxy-n*mx*my;
    const slope = Math.abs(sxx2)>1e-6 ? sxy2/sxx2 : NaN;
    return { slope, intercept: my - slope*mx };
  }

  // dMeasure regression — analysis units (net kcal at dMeasure)
  const avgsM   = phases.map(p => p.avgEff); // already at dMeasure
  const regM    = ols1d_(avgsM);
  const maintM  = -regM.intercept / regM.slope; // maintenance at wRef, dMeasure units

  // dTarget regression — practical units (Effective kcal shown in Summary column)
  const avgsT   = phases.map(p => p.avgGross - dTarget * p.avgBurn);
  const regT    = ols1d_(avgsT);
  const maintT  = -regT.intercept / regT.slope; // maintenance at wRef, dTarget units

  // W_ref: mean of phase midpoint weights (the regime the regression was fitted on)
  const wRef = phases.reduce((s,p) => s + (p.startW+p.endW)/2, 0) / phases.length;

  // wNow: most recent raw weigh-in (raw, not smoothed — smoothed lags ~14 days)
  let wNow = wRef;
  for (let i=series.weights.length-1; i>=0; i--) {
    if (series.weights[i] !== null) { wNow = series.weights[i]; break; }
  }

  // Weight-adjust both maintenance estimates to current weight
  const maintMNow = maintM + kPerLb*(wNow - wRef);
  const maintTNow = maintT + kPerLb*(wNow - wRef);

  // Targets at desired rate
  const targetEff      = isFinite(regM.slope) ? maintMNow + desiredRate/regM.slope : NaN;
  const targetWeighted = isFinite(regT.slope) ? maintTNow + desiredRate/regT.slope : NaN;
  // targetWeighted is the rest-day gross; exercise day gross = targetWeighted + dTarget*burn

  return {
    // dMeasure (analysis)
    slope: regM.slope, intercept: regM.intercept,
    maintenanceEff: maintM, maintenanceNow: maintMNow, targetEff,
    // dTarget (practical daily targets)
    slopeTarget: regT.slope, interceptTarget: regT.intercept,
    maintenanceWeighted: maintT, maintenanceWeightedNow: maintTNow, targetWeighted,
    // shared
    wRef, wNow, kPerLb, dMeasure, dTarget, desiredRate,
  };
}

/**
 * Trailing-window estimate for a "current status" signal.
 * Intake leads weight by ~2–4 weeks, so this is a leading indicator even though
 * it uses past data. Clearly labeled as lagged/uncertain — NOT a current phase
 * detection (can't detect a local min/max in real time with centered smoothing).
 */
function pa_trailingEstimate_(series, maintCalc, windowDays, dMeasure) {
  const n = series.gross.length;
  const end = n - 1;
  const start = Math.max(0, end - windowDays + 1);

  let sumGross = 0, sumBurn = 0, cnt = 0;
  for (let i = start; i <= end; i++) {
    if (series.gross[i] === null) continue;
    sumGross += series.gross[i];
    sumBurn  += series.burn[i] || 0;
    cnt++;
  }
  if (cnt === 0) return null;

  const avgGross = sumGross / cnt;
  const avgBurn  = sumBurn  / cnt;
  const avgEff   = avgGross - dMeasure * avgBurn;
  const gap      = avgEff - maintCalc.maintenanceNow; // + = above maintenance

  return {
    windowDays,
    loggedDays: cnt,
    startDate: series.dates[start],
    endDate:   series.dates[end],
    avgGross, avgBurn, avgEff, gap,
  };
}

// ─── Math / stats helpers ─────────────────────────────────────────────────────

/**
 * Multivariate OLS: β = (X'X)⁻¹ X'y for a k-column X matrix.
 * Returns { beta, sigma², cov } or null if X'X is singular.
 * Only handles k ≤ 3 (the 3×3 inverse is analytical; avoids a full LU solver).
 */
function pa_olsMultivariate_(X, y) {
  const nObs = X.length;
  const k = X[0].length;
  if (k > 3) throw new Error('pa_olsMultivariate_: only k ≤ 3 supported');

  // X'X  (k×k)
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++)
      for (let r = 0; r < nObs; r++) XtX[i][j] += X[r][i] * X[r][j];

  // X'y  (k×1)
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < k; i++)
    for (let r = 0; r < nObs; r++) Xty[i] += X[r][i] * y[r];

  const XtX_inv = k === 3 ? pa_matInv3_(XtX) : pa_matInv2_(XtX);
  if (!XtX_inv) return null;

  const beta = new Array(k).fill(0);
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) beta[i] += XtX_inv[i][j] * Xty[j];

  let sse = 0;
  for (let r = 0; r < nObs; r++) {
    let yhat = 0;
    for (let j = 0; j < k; j++) yhat += X[r][j] * beta[j];
    sse += (y[r] - yhat) ** 2;
  }
  const sigma2 = sse / (nObs - k);
  const cov = XtX_inv.map(row => row.map(v => v * sigma2));

  return { beta, sigma2, cov, sse };
}

function pa_matInv3_(A) {
  const [a, b, c] = A[0];
  const [d, e, f] = A[1];
  const [g, h, k] = A[2];
  const det = a*(e*k - f*h) - b*(d*k - f*g) + c*(d*h - e*g);
  if (Math.abs(det) < 1e-14) return null;
  return [
    [ (e*k-f*h)/det, -(b*k-c*h)/det,  (b*f-c*e)/det ],
    [-(d*k-f*g)/det,  (a*k-c*g)/det, -(a*f-c*d)/det ],
    [ (d*h-e*g)/det, -(a*h-b*g)/det,  (a*e-b*d)/det ],
  ];
}

function pa_matInv2_(A) {
  const [[a, b], [c, dd]] = A;
  const det = a*dd - b*c;
  if (Math.abs(det) < 1e-14) return null;
  return [[ dd/det, -b/det], [-c/det, a/det]];
}

function pa_correlation_(x, y) {
  const pairs = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] != null && y[i] != null && isFinite(x[i]) && isFinite(y[i])) {
      pairs.push([x[i], y[i]]);
    }
  }
  if (pairs.length < 3) return 0;
  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [xi, yi] of pairs) { sx += xi; sy += yi; sxx += xi*xi; syy += yi*yi; sxy += xi*yi; }
  const mx = sx/n, my = sy/n;
  const vx = sxx/n - mx*mx, vy = syy/n - my*my;
  if (vx < 1e-10 || vy < 1e-10) return 0;
  return (sxy/n - mx*my) / Math.sqrt(vx * vy);
}

function pa_rSquared_(x, y) {
  const r = pa_correlation_(x, y);
  return r * r;
}

/**
 * Linear interpolation of null gaps in a weight array.
 * Only fills gaps ≤ maxGap days (longer gaps stay null — unreliable to interpolate).
 */
function pa_interpolateWeights_(arr, maxGap) {
  const out = arr.slice();
  const n = arr.length;
  let i = 0;
  while (i < n) {
    if (out[i] !== null) { i++; continue; }
    const gapStart = i - 1;
    let j = i;
    while (j < n && out[j] === null) j++;
    const gapLen = j - i; // number of null days
    if (gapStart >= 0 && j < n && gapLen <= maxGap) {
      const v0 = out[gapStart], v1 = out[j];
      for (let k = i; k < j; k++) {
        out[k] = v0 + (v1 - v0) * (k - gapStart) / (j - gapStart);
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * Reads the Settings sheet into a plain object { key: value }.
 * Returns an empty object (not null) if the sheet is missing.
 */
function pa_readSettings_(ss) {
  const sh = ss.getSheetByName('Settings');
  if (!sh) return {};
  const data = sh.getDataRange().getValues();
  const out = {};
  for (let r = 1; r < data.length; r++) {
    const key = String(data[r][0]).trim();
    if (key) out[key] = data[r][1];
  }
  return out;
}

/**
 * Updates a single key in the Settings sheet. Creates the row if missing.
 */
function pa_writeToSettings_(ss, key, value) {
  const sh = ss.getSheetByName('Settings');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim() === key) {
      sh.getRange(r + 1, 2).setValue(value);
      sh.getRange(r + 1, 4).setValue(new Date().toISOString());
      return;
    }
  }
  // Key not found — append a new row
  const lastRow = sh.getLastRow() + 1;
  sh.getRange(lastRow, 1, 1, 4).setValues([[key, value, '', new Date().toISOString()]]);
}

function pa_toDateKey_(val, tz) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    return isNaN(val.getTime()) ? null : Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  const s = String(val).trim();
  if (!s || s === '0') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  } catch (_) {}
  return null;
}

function pa_round_(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Pads every row to exactly `width` columns so setValues doesn't throw. */
function pa_padRows_(rows, width) {
  return rows.map(row => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

// ─── Output writers ───────────────────────────────────────────────────────────

function pa_writePhaseSheet_(ss, phases, maintCalc, trailing, dMeasure, dTarget) {
  if (dTarget === undefined) dTarget = PA_D_TARGET;
  let sh = ss.getSheetByName(PA_SHEET_PHASE);
  if (sh) { sh.clearContents(); sh.clearFormats(); }
  else sh = ss.insertSheet(PA_SHEET_PHASE);

  const rows = [];

  // Title
  rows.push([
    `Phase Analysis  |  D_MEASURE = ${dMeasure}  |  Run: ${new Date().toLocaleString()}`,
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ]);
  rows.push(['']);

  // Phase table header
  // Two effective-kcal columns:
  //   d=D_MEASURE: used for the maintenance regression (analysis truth)
  //   d=D_TARGET:  matches the "Effective kcal" column in Summary (daily goal lens)
  // They're the same number if D_MEASURE == D_TARGET. Showing both makes it
  // clear that the low D_MEASURE=1.0 numbers are net calories, not starvation.
  const showBothD = Math.abs(dMeasure - dTarget) > 0.01;
  const hdr = [
    '#', 'Type', 'Start Date', 'End Date', 'Days', 'Weeks',
    'Start W (lb)', 'End W (lb)', 'Rate (lb/wk)',
    'Avg Gross kcal', 'Avg Burn kcal', 'Avg Carbs Burned g',
    `Avg Eff kcal (d=${dMeasure}, analysis)`,
    ...(showBothD ? [`Avg Eff kcal (d=${dTarget}, goal)`] : []),
    'Avg Protein g', 'Avg Fat g', 'Avg Carbs g', 'Avg Sugar g', 'Avg Fiber g',
    'Logged Days'
  ];
  rows.push(hdr);

  for (const p of phases) {
    rows.push([
      p.num, p.type, p.startDate, p.endDate,
      p.days, pa_round_(p.weeks, 1),
      pa_round_(p.startW, 1), pa_round_(p.endW, 1), pa_round_(p.rate, 3),
      Math.round(p.avgGross), Math.round(p.avgBurn), pa_round_(p.avgCarbsBurned, 1),
      Math.round(p.avgEff),
      ...(showBothD ? [Math.round(p.avgGross - dTarget * p.avgBurn)] : []),
      Math.round(p.avgProtein), Math.round(p.avgFat), Math.round(p.avgCarbs),
      Math.round(p.avgAddedSugar), Math.round(p.avgFiber),
      p.nutritionDays,
    ]);
  }
  rows.push(['']);

  // Maintenance estimate block
  rows.push(['── Maintenance Estimate (from phase regression) ──']);
  if (isNaN(maintCalc.slope)) {
    rows.push(['Not enough phase variance to fit a regression.']);
  } else {
    rows.push(['Regression: rate (lb/wk) = intercept + slope × avg_eff_kcal']);
    rows.push(['  Slope (lb/wk per eff-kcal/day)', maintCalc.slope.toExponential(3), '', 'positive = more intake → more gain']);
    rows.push(['  Intercept', pa_round_(maintCalc.intercept, 4)]);
    rows.push(['Weight reference W_ref (mean of phases)', pa_round_(maintCalc.wRef, 1), 'lb']);
    rows.push(['Maintenance at W_ref', Math.round(maintCalc.maintenanceEff), `eff-kcal/day at d=${dMeasure} (= net kcal if d=1)`]);
    rows.push(['Current weight W_now (most recent weigh-in)', pa_round_(maintCalc.wNow, 1), 'lb']);
    rows.push([`K_PER_LB (assumed; ${maintCalc.kPerLb} eff-kcal/day per lb)`, '', 'ASSUMPTION — see comments']);
    rows.push(['Maintenance at W_now', Math.round(maintCalc.maintenanceNow), `eff-kcal/day at d=${dMeasure}`]);
    if (showBothD) {
      // On a typical exercise day, gross = maintenance + D_TARGET * burn.
      // Show a worked example using the avg burn across all phases.
      const avgBurnAllPhases = phases.reduce((s, p) => s + p.avgBurn, 0) / phases.length;
      const grossRestDay = Math.round(maintCalc.maintenanceNow);
      const grossExDay   = Math.round(maintCalc.maintenanceNow + dTarget * avgBurnAllPhases);
      rows.push(['→ Rest day gross at maintenance ≈', grossRestDay, 'kcal']);
      rows.push(['→ Exercise day gross at maintenance ≈', grossExDay, `kcal  (${grossRestDay} + ${dTarget}×${Math.round(avgBurnAllPhases)} avg burn)`]);
      rows.push(['', '  These are the "normal-sounding" numbers — eat this gross and your Effective kcal hits maintenance.', '']);
    }
  }
  rows.push(['']);

  // Trailing intake estimate
  if (trailing) {
    const gapLabel = trailing.gap > 0 ? `+${Math.round(trailing.gap)} (above maintenance → trending gain)` :
                                        `${Math.round(trailing.gap)} (below maintenance → trending loss)`;
    rows.push([`── Trailing ${trailing.windowDays}-Day Intake Estimate (${trailing.startDate} → ${trailing.endDate}) ──`]);
    rows.push(['Logged days in window', trailing.loggedDays]);
    rows.push(['Avg gross kcal/day', Math.round(trailing.avgGross)]);
    rows.push(['Avg burn kcal/day', Math.round(trailing.avgBurn)]);
    rows.push([`Avg eff kcal/day (d=${dMeasure})`, Math.round(trailing.avgEff)]);
    rows.push(['Maintenance now', Math.round(maintCalc.maintenanceNow), 'eff-kcal/day']);
    rows.push(['Gap (eff − maintenance)', gapLabel]);
    rows.push(['', '⚠ Intake leads weight by ~2–4 weeks. This is a leading indicator, not a current phase detection.', '', '']);
    rows.push(['', '  Cannot detect a local weight min/max in real time — only confirmed after weight retraces past threshold.', '', '']);
  }
  rows.push(['']);
  rows.push(['── Run "Compute Target…" from the Analysis menu to set a goal intake. ──']);

  sh.getRange(1, 1, rows.length, hdr.length).setValues(pa_padRows_(rows, hdr.length));

  // Formatting
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  const headerRow = 3;
  sh.getRange(headerRow, 1, 1, hdr.length).setFontWeight('bold').setBackground('#e8f0fe');
  sh.setFrozenRows(headerRow);
  sh.autoResizeColumns(1, hdr.length);

  // Shade phase rows by type
  for (let r = 0; r < phases.length; r++) {
    const color = phases[r].type === 'LOSS' ? '#d9ead3' : phases[r].type === 'GAIN' ? '#fce8e6' : '#fff2cc';
    sh.getRange(headerRow + 1 + r, 1, 1, hdr.length).setBackground(color);
  }
}

function pa_writeSweepSheet_(ss, result) {
  let sh = ss.getSheetByName(PA_SHEET_SWEEP);
  if (sh) { sh.clearContents(); sh.clearFormats(); }
  else sh = ss.insertSheet(PA_SHEET_SWEEP);

  const rows = [];

  const hdr1 = [`Discount Sweep  |  Run: ${new Date().toLocaleString()}`];
  rows.push(hdr1);
  rows.push(['']);
  rows.push([
    'Gross ↔ Burn correlation:', pa_round_(result.corrGrossBurn, 3), '',
    Math.abs(result.corrGrossBurn) > 0.7
      ? '⚠ High collinearity — d* is weakly identified. The data cannot pin the discount.'
      : 'Collinearity OK.',
  ]);
  rows.push(['VIF (from weekly blocks)',
    result.weekly.vif !== null && result.weekly.vif !== undefined
      ? (isFinite(result.weekly.vif) ? pa_round_(result.weekly.vif, 2) : '∞')
      : 'n/a'
  ]);
  rows.push(['']);
  rows.push(['NOTE: D_MEASURE ≠ D_TARGET. d* here is "how much logged burn empirically moved weight."', '', '', '']);
  rows.push(['D_TARGET for eating goals should be ≤ d* (conservative; device burns are inflated).', '', '', '']);
  rows.push(['']);

  // ── Weekly ────────────────────────────────────────────────────────────────
  const wKey = 'Weekly Scale (7-day non-overlapping blocks, n=' + result.weekly.n + ')';
  rows.push([wKey]);
  rows.push(['d', 'R² (weekly)', '', 'Interpretation']);
  for (const { d, rSq } of result.weekly.curve) {
    rows.push([d, pa_round_(rSq, 4), '',
      d === result.weekly.dStar ? '← peak (d* weekly)' : ''
    ]);
  }
  rows.push(['']);
  rows.push(['Weekly OLS:  ΔW = β0 + β1·gross + β2·burn  →  d* = −β2/β1']);
  if (result.weekly.beta) {
    rows.push(['  β0', result.weekly.beta[0].toExponential(3)]);
    rows.push(['  β1 (gross)', result.weekly.beta[1].toExponential(3)]);
    rows.push(['  β2 (burn)', result.weekly.beta[2].toExponential(3)]);
  }
  if (result.weekly.dStar !== null) {
    rows.push(['  d*', pa_round_(result.weekly.dStar, 3)]);
    rows.push(['  95% CI', `[${pa_round_(result.weekly.ciLo, 3)}, ${pa_round_(result.weekly.ciHi, 3)}]`]);
    rows.push(['  R² at d*', pa_round_(result.weekly.rSqStar, 4)]);
  }
  if (result.weekly.warning) rows.push(['  ⚠ WARNING', result.weekly.warning]);
  rows.push(['']);

  // ── Monthly ───────────────────────────────────────────────────────────────
  const mKey = 'Monthly Scale (28-day non-overlapping blocks, n=' + result.monthly.n + ')  ← lead with this for body-comp';
  rows.push([mKey]);
  rows.push(['d', 'R² (monthly)', '', 'Interpretation']);
  for (const { d, rSq } of result.monthly.curve) {
    rows.push([d, pa_round_(rSq, 4), '',
      d === result.monthly.dStar ? '← peak (d* monthly)' : ''
    ]);
  }
  rows.push(['']);
  rows.push(['Monthly OLS:  ΔW = β0 + β1·gross + β2·burn  →  d* = −β2/β1']);
  if (result.monthly.beta) {
    rows.push(['  β0', result.monthly.beta[0].toExponential(3)]);
    rows.push(['  β1 (gross)', result.monthly.beta[1].toExponential(3)]);
    rows.push(['  β2 (burn)', result.monthly.beta[2].toExponential(3)]);
  }
  if (result.monthly.dStar !== null) {
    rows.push(['  d*', pa_round_(result.monthly.dStar, 3)]);
    rows.push(['  95% CI', `[${pa_round_(result.monthly.ciLo, 3)}, ${pa_round_(result.monthly.ciHi, 3)}]`]);
    rows.push(['  R² at d*', pa_round_(result.monthly.rSqStar, 4)]);
  }
  if (result.monthly.warning) rows.push(['  ⚠ WARNING', result.monthly.warning]);
  rows.push(['']);

  rows.push(['── Interpretation guide ──────────────────────────────────────────']);
  rows.push(['A sharp R²-vs-d peak → d is well-identified. A flat curve → data cannot distinguish (say) d=0.4 from d=0.9.']);
  rows.push(['Weekly d* is biased low by water/glycogen swings. Monthly d* is closer to fat-mass truth.']);
  rows.push(['d* conflates device over-estimation and physiological compensation; it cannot separate them.']);
  rows.push(['If burn source changes (e.g. new device), refit d* — it is specific to the current measurement convention.']);
  rows.push(['Cross-check: do loss-vs-gain phase averages imply a similar d? (Phase Analysis tab)']);

  sh.getRange(1, 1, rows.length, 4).setValues(pa_padRows_(rows, 4));

  sh.getRange(1, 1).setFontWeight('bold').setFontSize(11);
  // Bold section headers
  const boldRows = [9, 18, 19]; // approximate — header, weekly section, monthly section
  // Find and bold rows that start with 'Weekly Scale' or 'Monthly Scale'
  for (let r = 0; r < rows.length; r++) {
    const cell = String(rows[r][0] || '');
    if (cell.startsWith('Weekly Scale') || cell.startsWith('Monthly Scale') ||
        cell.startsWith('Weekly OLS') || cell.startsWith('Monthly OLS') ||
        cell.startsWith('── ')) {
      sh.getRange(r + 1, 1).setFontWeight('bold');
    }
  }
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 30);
  sh.setColumnWidth(4, 420);
  sh.getRange(1, 4, rows.length, 1).setWrap(true);
}

/**
 * Appends the target derivation block to the Phase Analysis tab.
 * Called by computeTarget(); run Phase Analysis first so the tab exists.
 */
function pa_writeTargetBlock_(ss, calc) {
  let sh = ss.getSheetByName(PA_SHEET_PHASE);
  if (!sh) {
    SpreadsheetApp.getUi().alert('Run "Phase Analysis" first to create the tab.');
    return;
  }

  const lastRow = sh.getLastRow() + 2;
  const rows = [];

  rows.push([`── Calorie Target  |  Rate = ${calc.desiredRate} lb/wk  |  ${new Date().toLocaleString()} ──`]);
  rows.push(['']);
  rows.push(['Parameter', 'Value', 'Notes']);
  rows.push(['D_MEASURE (used to fit analysis regression)', calc.dMeasure, 'Empirical discount from Discount Sweep']);
  rows.push(['D_TARGET (used for daily eating goal)', calc.dTarget,  'Conservative eating discount; ≤ D_MEASURE']);
  rows.push(['K_PER_LB (weight-scaling, assumed)', calc.kPerLb, 'eff-kcal/day per lb of body weight — ASSUMPTION']);
  rows.push(['']);

  rows.push(['── Practical daily targets (d=' + calc.dTarget + ') ─────────────────────────────']);
  rows.push(['  These match the "Effective kcal" column in your Summary sheet.', '', '']);
  rows.push(['Effective kcal maintenance at W_now', Math.round(calc.maintenanceWeightedNow) + ' /day', 'Directly readable from Summary "Effective kcal" column']);
  rows.push(['Effective kcal TARGET', Math.round(calc.targetWeighted) + ' /day', 'Keep your Summary Effective kcal at or below this']);
  rows.push(['Rest day gross ≈', Math.round(calc.targetWeighted) + ' kcal', '']);
  rows.push(['Exercise day: gross =', Math.round(calc.targetWeighted) + ' + ' + calc.dTarget + ' × burn', 'e.g. 700 burn → gross ≈ ' + Math.round(calc.targetWeighted + calc.dTarget * 700)]);
  rows.push(['']);

  rows.push(['── Analysis regression (d=' + calc.dMeasure + ') ─────────────────────────────']);
  rows.push(['  Used for Discount Sweep comparison only; not for daily tracking.', '', '']);
  rows.push(['Net kcal maintenance at W_ref (' + pa_round_(calc.wRef,1) + ' lb)', Math.round(calc.maintenanceEff) + ' /day', '']);
  rows.push(['Net kcal maintenance at W_now (' + pa_round_(calc.wNow,1) + ' lb)', Math.round(calc.maintenanceNow) + ' /day',
    'Weight adjustment: ' + calc.kPerLb + ' kcal/day per lb × (' + pa_round_(calc.wNow,1) + '−' + pa_round_(calc.wRef,1) + ') lb']);
  rows.push(['Net kcal target', Math.round(calc.targetEff) + ' /day', '']);
  rows.push(['  Regression slope', calc.slope.toExponential(3), 'lb/wk per net-kcal/day']);
  rows.push(['  Regression slope (d=' + calc.dTarget + ')', calc.slopeTarget.toExponential(3), 'lb/wk per weighted-kcal/day']);
  rows.push(['']);
  rows.push(['Note: weight is adjusted from W_ref to W_now via K_PER_LB. The regression itself']);
  rows.push(['  uses phase-averaged intakes without separating weight effects — only 3 phase points']);
  rows.push(['  prevents fitting weight as an independent predictor. The K_PER_LB adjustment is an']);
  rows.push(['  approximation; revisit it once more phase data with wider weight range is available.']);
  rows.push(['']);
  rows.push(['Caveat: intake leads weight by ~2–4 weeks. Track your trailing Effective kcal vs']);
  rows.push(['  maintenance (shown in Phase Analysis tab) as the leading signal.']);

  sh.getRange(lastRow, 1, rows.length, 3).setValues(pa_padRows_(rows, 3));
  sh.getRange(lastRow, 1).setFontWeight('bold').setFontSize(11);
  sh.getRange(lastRow, 1, 1, 3).setBackground('#fce8b2');
  sh.getRange(lastRow + 2, 1, 1, 3).setFontWeight('bold').setBackground('#eeeeee');
  sh.autoResizeColumns(1, 3);
}
