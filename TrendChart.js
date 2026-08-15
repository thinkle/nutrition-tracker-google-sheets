/**
 * TrendChart.js
 *
 * Builds a "Trends" sheet for a selectable set of Summary metrics plus Weight.
 * Each selected metric gets its own dual-axis chart (metric left, weight
 * right), stacked down the sheet.
 *
 * The data columns are LIVE FORMULAS (MAP/AVERAGEIFS over Summary/Metrics),
 * not copied values — the sheet stays current as you log, no re-run needed.
 * The smoothing window lives in an editable cell in the stats block; changing
 * it recalculates every column and chart instantly. Re-running the script is
 * only needed to change WHICH metrics are charted (or to refresh the static
 * weight-axis bounds after a big weight change).
 *
 * Menu items (added to onOpen in Menu.js):
 *   Nutrition Tools > Analysis > Build Trend Chart…  (prompts for window + columns)
 *   Nutrition Tools > Analysis > Rebuild Trend Chart (reuses saved settings)
 *
 * Data sources (same spreadsheet):
 *   Summary sheet — Date + metric columns (matched by header prefix, see TC_METRIC_DEFS)
 *   Metrics sheet — Date, Weight
 *
 * Smoothing notes (why this isn't just a plain 7DA):
 *   • Trailing window (today and the previous N−1 days) so the line is causal —
 *     it answers "where am I now", at the cost of lagging turns by ~N/2 days.
 *   • Food-derived metrics on days with gross kcal below PA_MIN_GROSS_KCAL are
 *     treated as unlogged and excluded — they would otherwise drag averages to
 *     physically implausible lows (exercise logged, food not). Exercise-derived
 *     metrics (kcal burned) are kept on those days; the burn data is real.
 *   • The smoothed line goes blank when fewer than ceil(window/3) logged days
 *     fall in the window, rather than presenting sparse data as a trend.
 *   • Raw daily values are kept as point-only series behind the smoothed lines
 *     so the smoothing can't silently hide outliers. Set the Window cell to 1
 *     to see fully raw data.
 *
 * Known formula caveats (the price of live data):
 *   • Column letters for Summary/Metrics are captured at build time; if those
 *     sheets are restructured, rebuild from the menu.
 *   • Recalc cost grows with the Log — hundreds of AVERAGEIFS re-evaluate on
 *     edits. Fine at current scale; if it ever drags, the fix is archiving old
 *     Log rows, not abandoning formulas.
 *
 * Cross-file deps (global scope):
 *   PhaseAnalysis.js — PA_MIN_GROSS_KCAL, pa_readSettings_, pa_writeToSettings_,
 *                      pa_toDateKey_
 *   Util.js          — getColumnLetter
 */

// ─── CONFIG — update if sheet structure changes ──────────────────────────────

const TC_SHEET = 'Trends';
const TC_DEFAULT_WINDOW = 7;
const TC_DEFAULT_METRICS = ['net'];
/** Settings-sheet keys persisting the last choices made in the prompt. */
const TC_SETTINGS_WINDOW_KEY = 'trend_window_days';
const TC_SETTINGS_METRICS_KEY = 'trend_metrics';

const TC_SUMMARY_SHEET = 'Summary';
const TC_SUMMARY_DATE_HEADER = 'Date';
const TC_SUMMARY_GROSS_HEADER = 'Gross kcal';

const TC_METRICS_SHEET = 'Metrics';
const TC_METRICS_COL_DATE = 1;   // 1-based
const TC_METRICS_COL_WEIGHT = 2;

/**
 * Selectable Summary metrics, in prompt order.
 *   headerPrefix — matched with startsWith so wording tweaks don't break us
 *   unit         — drives axis title and number format
 *   gated        — exclude when gross kcal < PA_MIN_GROSS_KCAL (food metrics);
 *                  ungated metrics (exercise-derived) are kept on those days
 *   colors       — [raw points, smoothed line]; fixed per metric so charts
 *                  stay visually consistent between runs. Coral is reserved
 *                  for weight.
 */
const TC_METRIC_DEFS = [
  { key: 'net',       label: 'Net kcal',                  headerPrefix: 'Net kcal',              unit: 'kcal', gated: true,  colors: ['#85b7eb', '#185fa5'] },
  { key: 'effective', label: 'Effective kcal',            headerPrefix: 'Effective kcal',        unit: 'kcal', gated: true,  colors: ['#5dcaa5', '#0f6e56'] },
  { key: 'gross',     label: 'Gross kcal',                headerPrefix: 'Gross kcal',           unit: 'kcal', gated: true,  colors: ['#b4b2a9', '#5f5e5a'] },
  { key: 'carbcredit', label: 'Carb-credit kcal (adjusted)', headerPrefix: 'Carb-credit kcal',  unit: 'kcal', gated: true,  colors: ['#afa9ec', '#534ab7'] },
  { key: 'burned',    label: 'kcal burned',               headerPrefix: 'kcal burned',          unit: 'kcal', gated: false, colors: ['#fac775', '#854f0b'] },
  { key: 'protein',   label: 'Protein (g)',               headerPrefix: 'Total protein',        unit: 'g',    gated: true,  colors: ['#97c459', '#3b6d11'] },
  { key: 'sugar',     label: 'Added sugar (g)',           headerPrefix: 'Total added_sugar',    unit: 'g',    gated: true,  colors: ['#ed93b1', '#993556'] },
  { key: 'fat',       label: 'Fat (g)',                   headerPrefix: 'Total fat',            unit: 'g',    gated: true,  colors: ['#f09595', '#a32d2d'] },
];

const TC_WEIGHT_COLORS = ['#f0997b', '#d85a30'];

/** Days of raw weights used for the "current trend" regression stat. */
const TC_TREND_REGRESSION_DAYS = 30;

/** Weight axis: raw range padded by this many lb, then rounded out to a multiple of 5. */
const TC_WEIGHT_AXIS_PAD_LB = 3;

/** Spare rows kept beyond today so the date spine can keep spilling (~2 yrs). */
const TC_ROW_BUFFER = 730;

const TC_CHART_WIDTH = 1100;
const TC_CHART_HEIGHT = 460;

// ─── Entry points ────────────────────────────────────────────────────────────

/** Rebuilds the Trends sheet using saved (or default) window and metrics. */
function buildTrendChart() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = pa_readSettings_(ss);
  tc_build_(ss, tc_savedWindow_(settings), tc_savedMetrics_(settings));
}

/** Prompts for window and columns, saves both to Settings, then rebuilds. */
function buildTrendChartPrompt() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const settings = pa_readSettings_(ss);
  const currentWindow = tc_savedWindow_(settings);
  const currentMetrics = tc_savedMetrics_(settings);

  const winResp = ui.prompt(
    'Build Trend Chart (1/2)',
    'Smoothing window in days (1 = raw daily values).\n' +
    'Current: ' + currentWindow + '. Typical: 7. Try 14–28 for phase structure, ' +
    '1–3 to see what the smoothing hides.\n' +
    '(You can also edit the Window cell on the Trends sheet later — it\'s live.)',
    ui.ButtonSet.OK_CANCEL
  );
  if (winResp.getSelectedButton() !== ui.Button.OK) return;
  const winText = winResp.getResponseText().trim();
  const windowDays = winText === '' ? currentWindow : parseInt(winText, 10);
  if (!isFinite(windowDays) || windowDays < 1 || windowDays > 60) {
    ui.alert('Please enter a whole number of days between 1 and 60.');
    return;
  }

  const menu = TC_METRIC_DEFS
    .map((def, i) => (i + 1) + '. ' + def.label)
    .join('\n');
  const colResp = ui.prompt(
    'Build Trend Chart (2/2)',
    'Which columns do you want to bring in? Comma-separate for multiple.\n' +
    'Current: ' + currentMetrics.map(d => d.label).join(', ') + ' (blank to keep)\n\n' +
    menu + '\n\nWeight is always included on the right axis of every chart.',
    ui.ButtonSet.OK_CANCEL
  );
  if (colResp.getSelectedButton() !== ui.Button.OK) return;
  const colText = colResp.getResponseText().trim();
  const metrics = colText === '' ? currentMetrics : tc_parseMetricSelection_(colText);
  if (!metrics) {
    ui.alert(
      'Could not parse that selection. Use numbers 1–' + TC_METRIC_DEFS.length +
      ' (or metric names like "net, protein"), comma-separated.'
    );
    return;
  }

  pa_writeToSettings_(ss, TC_SETTINGS_WINDOW_KEY, windowDays);
  pa_writeToSettings_(ss, TC_SETTINGS_METRICS_KEY, metrics.map(d => d.key).join(','));
  tc_build_(ss, windowDays, metrics);
}

// ─── Settings / selection parsing ────────────────────────────────────────────

function tc_savedWindow_(settings) {
  const saved = parseInt(settings[TC_SETTINGS_WINDOW_KEY], 10);
  return isFinite(saved) && saved >= 1 ? saved : TC_DEFAULT_WINDOW;
}

function tc_savedMetrics_(settings) {
  const saved = String(settings[TC_SETTINGS_METRICS_KEY] || '').trim();
  if (saved) {
    const defs = tc_parseMetricSelection_(saved);
    if (defs) return defs;
  }
  return tc_parseMetricSelection_(TC_DEFAULT_METRICS.join(','));
}

/**
 * Accepts comma-separated 1-based numbers ("1,6") and/or metric keys or label
 * fragments ("net, protein"). Returns defs in TC_METRIC_DEFS order, deduped,
 * or null if any token is unrecognized.
 */
function tc_parseMetricSelection_(text) {
  const tokens = String(text).split(',').map(t => t.trim().toLowerCase()).filter(t => t);
  if (tokens.length === 0) return null;
  const picked = new Set();
  for (const tok of tokens) {
    let def = null;
    if (/^\d+$/.test(tok)) {
      def = TC_METRIC_DEFS[parseInt(tok, 10) - 1] || null;
    } else {
      def = TC_METRIC_DEFS.find(d => d.key === tok) ||
            TC_METRIC_DEFS.find(d => d.label.toLowerCase().startsWith(tok)) ||
            null;
    }
    if (!def) return null;
    picked.add(def.key);
  }
  return TC_METRIC_DEFS.filter(d => picked.has(d.key));
}

// ─── Core build ──────────────────────────────────────────────────────────────

function tc_build_(ss, windowDays, metrics) {
  const meta = tc_readMeta_(ss, metrics);
  if (!meta) return;

  const sheet = tc_resetSheet_(ss, meta.nDays);
  const layout = tc_layout_(metrics);
  tc_writeFormulas_(sheet, metrics, meta, layout, windowDays);
  tc_writeStats_(sheet, metrics, layout, windowDays);
  tc_insertCharts_(sheet, metrics, meta, layout);

  SpreadsheetApp.getActive().toast(
    metrics.length + ' live chart(s) built. Edit the Window cell to change smoothing.',
    'Trends', 5
  );
}

/** Column positions on the Trends sheet, all 1-based. */
function tc_layout_(metrics) {
  const weightDaily = 2 + 2 * metrics.length;
  const statsCol = weightDaily + 3; // one spacer after weight columns
  return {
    metricDaily: m => 2 + 2 * m,
    metricSmooth: m => 3 + 2 * m,
    weightDaily,
    weightSmooth: weightDaily + 1,
    lastDataCol: weightDaily + 1,
    statsCol,
    windowCellA1: '$' + getColumnLetter(statsCol + 1) + '$1',
    firstChartRow: metrics.length + 9, // below the stats block
  };
}

/**
 * Validates source sheets and captures what the formulas/charts need:
 * source column letters, date span, and weight-axis bounds.
 */
function tc_readMeta_(ss, metrics) {
  const ui = SpreadsheetApp.getUi();
  const tz = Session.getScriptTimeZone();

  const mSheet = ss.getSheetByName(TC_METRICS_SHEET);
  if (!mSheet) { ui.alert('Metrics sheet not found.'); return null; }
  const mData = mSheet.getDataRange().getValues();

  let wtMin = Infinity, wtMax = -Infinity;
  let dkMin = null, dkMax = null;
  for (let r = 1; r < mData.length; r++) {
    const dk = pa_toDateKey_(mData[r][TC_METRICS_COL_DATE - 1], tz);
    const w = Number(mData[r][TC_METRICS_COL_WEIGHT - 1]);
    if (!dk || !isFinite(w) || w <= 0) continue;
    if (w < wtMin) wtMin = w;
    if (w > wtMax) wtMax = w;
    if (dkMin === null || dk < dkMin) dkMin = dk;
    if (dkMax === null || dk > dkMax) dkMax = dk;
  }

  const sSheet = ss.getSheetByName(TC_SUMMARY_SHEET);
  if (!sSheet) { ui.alert('Summary sheet not found.'); return null; }
  const sData = sSheet.getDataRange().getValues();
  if (sData.length < 2) { ui.alert('Summary sheet has no data.'); return null; }

  const headers = sData[0].map(h => String(h).trim());
  const dateCol = headers.indexOf(TC_SUMMARY_DATE_HEADER);
  const grossCol = headers.indexOf(TC_SUMMARY_GROSS_HEADER);
  if (dateCol === -1 || grossCol === -1) {
    ui.alert('Summary sheet is missing the Date or Gross kcal column.\nRun "Reset Summary Formulas for Activities" to rebuild it.');
    return null;
  }
  const metricCols = metrics.map(def => {
    // Exact match first so e.g. 'Gross kcal' is preferred over a longer header
    const exact = headers.indexOf(def.headerPrefix);
    return exact !== -1 ? exact : headers.findIndex(h => h.startsWith(def.headerPrefix));
  });
  const missing = metrics.filter((_, i) => metricCols[i] === -1).map(d => d.label);
  if (missing.length) {
    ui.alert('Summary sheet is missing columns for: ' + missing.join(', ') + '.\nRun "Reset Summary Formulas for Activities" to rebuild it.');
    return null;
  }

  for (let r = 1; r < sData.length; r++) {
    const dk = pa_toDateKey_(sData[r][dateCol], tz);
    if (!dk) continue;
    if (dkMin === null || dk < dkMin) dkMin = dk;
    if (dkMax === null || dk > dkMax) dkMax = dk;
  }
  if (dkMin === null) { ui.alert('No usable data in Summary or Metrics.'); return null; }

  const nDays = Math.round(
    (new Date(dkMax + 'T12:00:00Z') - new Date(dkMin + 'T12:00:00Z')) / 86400000
  ) + 1;

  let wtBounds = null;
  if (isFinite(wtMin)) {
    wtBounds = {
      min: Math.floor((wtMin - TC_WEIGHT_AXIS_PAD_LB) / 5) * 5,
      max: Math.ceil((wtMax + TC_WEIGHT_AXIS_PAD_LB) / 5) * 5,
    };
  }

  return {
    summaryDateLetter: getColumnLetter(dateCol + 1),
    summaryGrossLetter: getColumnLetter(grossCol + 1),
    metricLetters: metricCols.map(c => getColumnLetter(c + 1)),
    metricsDateLetter: getColumnLetter(TC_METRICS_COL_DATE),
    metricsWeightLetter: getColumnLetter(TC_METRICS_COL_WEIGHT),
    nDays,
    wtBounds,
  };
}

// ─── Output ──────────────────────────────────────────────────────────────────

function tc_resetSheet_(ss, nDays) {
  let sheet = ss.getSheetByName(TC_SHEET);
  if (!sheet) sheet = ss.insertSheet(TC_SHEET);
  sheet.getCharts().forEach(c => sheet.removeChart(c));
  sheet.clear();
  // The date spine spills one row per day — make sure it has room to grow
  const rowsNeeded = nDays + 1 + TC_ROW_BUFFER;
  if (sheet.getMaxRows() < rowsNeeded) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rowsNeeded - sheet.getMaxRows());
  }
  return sheet;
}

/**
 * Headers + live formulas. Layout per metric: (daily, avg) column pair, then
 * Weight (daily, avg). All averages are calendar-window AVERAGEIFS keyed on
 * the date spine in column A, with the window read from the editable cell.
 */
function tc_writeFormulas_(sheet, metrics, meta, layout, windowDays) {
  const W = layout.windowCellA1;
  const sDate = '$' + meta.summaryDateLetter + ':$' + meta.summaryDateLetter;
  const sGross = '$' + meta.summaryGrossLetter + ':$' + meta.summaryGrossLetter;
  const mDate = '$' + meta.metricsDateLetter + ':$' + meta.metricsDateLetter;
  const mWt = '$' + meta.metricsWeightLetter + ':$' + meta.metricsWeightLetter;
  const gate = ', ' + TC_SUMMARY_SHEET + '!' + sGross + ', ">=' + PA_MIN_GROSS_KCAL + '"';

  const headers = ['Date'];
  metrics.forEach(def => headers.push(def.label + ' (daily)', def.label + ' (avg)'));
  headers.push('Weight (daily)', 'Weight (avg)');
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  // Date spine: every calendar day spanning Summary and Metrics
  sheet.getRange(2, 1).setFormula(
    '=LET(lo, MIN(INT(MIN(' + TC_SUMMARY_SHEET + '!' + sDate.replace(/\$/g, '') + ')), ' +
    'INT(MIN(' + TC_METRICS_SHEET + '!' + mDate.replace(/\$/g, '') + '))), ' +
    'hi, MAX(INT(MAX(' + TC_SUMMARY_SHEET + '!' + sDate.replace(/\$/g, '') + ')), ' +
    'INT(MAX(' + TC_METRICS_SHEET + '!' + mDate.replace(/\$/g, '') + '))), ' +
    'ARRAYFORMULA(TO_DATE(SEQUENCE(hi-lo+1, 1, lo, 1))))'
  );

  // Date criteria use [d-w+1, d+1) so datetime values (e.g. 04:00) still match
  const dayRange = (loExpr) =>
    ', ' + TC_SUMMARY_SHEET + '!' + sDate + ', ">="&' + loExpr +
    ', ' + TC_SUMMARY_SHEET + '!' + sDate + ', "<"&(d+1)';
  const wtDayRange = (loExpr) =>
    ', ' + TC_METRICS_SHEET + '!' + mDate + ', ">="&' + loExpr +
    ', ' + TC_METRICS_SHEET + '!' + mDate + ', "<"&(d+1)';

  metrics.forEach((def, m) => {
    const sVal = TC_SUMMARY_SHEET + '!$' + meta.metricLetters[m] + ':$' + meta.metricLetters[m];
    const g = def.gated ? gate : '';

    sheet.getRange(2, layout.metricDaily(m)).setFormula(
      '=MAP($A2:$A, LAMBDA(d, IF(d="", "", IFERROR(' +
      'AVERAGEIFS(' + sVal + dayRange('d') + g + '), ""))))'
    );
    sheet.getRange(2, layout.metricSmooth(m)).setFormula(
      '=MAP($A2:$A, LAMBDA(d, IF(d="", "", LET(w, ' + W + ', ' +
      'n, COUNTIFS(' + TC_SUMMARY_SHEET + '!' + sDate + ', ">="&(d-w+1), ' +
      TC_SUMMARY_SHEET + '!' + sDate + ', "<"&(d+1)' + g + '), ' +
      'IF(n < CEILING(w/3, 1), "", ' +
      'AVERAGEIFS(' + sVal + dayRange('(d-w+1)') + g + '))))))'
    );
  });

  const wtVal = TC_METRICS_SHEET + '!' + mWt;
  sheet.getRange(2, layout.weightDaily).setFormula(
    '=MAP($A2:$A, LAMBDA(d, IF(d="", "", IFERROR(' +
    'AVERAGEIFS(' + wtVal + wtDayRange('d') + '), ""))))'
  );
  sheet.getRange(2, layout.weightSmooth).setFormula(
    '=MAP($A2:$A, LAMBDA(d, IF(d="", "", IFERROR(' +
    'AVERAGEIFS(' + wtVal + wtDayRange('(d-' + W + '+1)') + '), ""))))'
  );

  const maxRows = sheet.getMaxRows();
  sheet.getRange(2, 1, maxRows - 1, 1).setNumberFormat('yyyy-mm-dd');
  metrics.forEach((def, m) => {
    sheet.getRange(2, layout.metricDaily(m), maxRows - 1, 2)
      .setNumberFormat(def.unit === 'g' ? '0.0' : '0');
  });
  sheet.getRange(2, layout.weightDaily, maxRows - 1, 2).setNumberFormat('0.0');
}

/**
 * Stats block to the right of the data. The Window cell is the live smoothing
 * control referenced by every formula; everything else is derived live too,
 * except the build timestamp.
 */
function tc_writeStats_(sheet, metrics, layout, windowDays) {
  const c = layout.statsCol;
  const lastNonBlank = (colLetter) =>
    '=IFERROR(LOOKUP(2, 1/(' + colLetter + '2:' + colLetter + '<>""), ' +
    colLetter + '2:' + colLetter + '), "—")';

  const wd = getColumnLetter(layout.weightDaily);
  const wsm = getColumnLetter(layout.weightSmooth);
  const cut = 'MAX($A2:$A)-' + (TC_TREND_REGRESSION_DAYS - 1);

  const rows = [];
  rows.push(['Window (days — edit me!)', windowDays]);
  metrics.forEach((def, m) => {
    rows.push([def.label + ' (avg, latest)', lastNonBlank(getColumnLetter(layout.metricSmooth(m)))]);
  });
  rows.push(
    ['Weight (avg, latest)', lastNonBlank(wsm)],
    [TC_TREND_REGRESSION_DAYS + '-day weight trend (lb/wk)',
      '=IFERROR(SLOPE(' +
      'FILTER(' + wd + '2:' + wd + ', $A2:$A >= ' + cut + ', ' + wd + '2:' + wd + '<>""), ' +
      'FILTER($A2:$A, $A2:$A >= ' + cut + ', ' + wd + '2:' + wd + '<>"")) * 7, "—")'],
    ['Weight change since start (lb)',
      '=IFERROR(LOOKUP(2, 1/(' + wsm + '2:' + wsm + '<>""), ' + wsm + '2:' + wsm + ') - ' +
      'INDEX(FILTER(' + wsm + '2:' + wsm + ', ' + wsm + '2:' + wsm + '<>""), 1), "—")'],
    ['Built (re-run to change metrics)', new Date()]
  );

  // setValues would treat '=...' strings as text in some locales; set one by one
  rows.forEach((row, i) => {
    sheet.getRange(1 + i, c).setValue(row[0]).setFontWeight('bold');
    const valCell = sheet.getRange(1 + i, c + 1);
    if (typeof row[1] === 'string' && row[1].startsWith('=')) {
      valCell.setFormula(row[1]);
    } else {
      valCell.setValue(row[1]);
    }
  });

  const winCell = sheet.getRange(1, c + 1);
  winCell.setNumberFormat('0').setFontWeight('bold');
  winCell.setBackground('#fef7e0').setNote(
    'Smoothing window in days. Every column and chart recalculates when you ' +
    'change this. 1 = raw daily values.'
  );
  sheet.getRange(2, c + 1, metrics.length, 1).setNumberFormat('0.0');
  sheet.getRange(2 + metrics.length, c + 1, 3, 1).setNumberFormat('0.00');
}

/**
 * One chart per selected metric, stacked down the sheet. Each chart pairs the
 * metric (left axis) with weight (right axis) so no chart ever mixes scales —
 * grams get their own properly-scaled axis instead of flatlining next to kcal.
 * Ranges are open-ended so charts grow as the date spine spills further.
 */
function tc_insertCharts_(sheet, metrics, meta, layout) {
  // ~21px per default row; step far enough that stacked charts don't overlap
  const rowsPerChart = Math.ceil(TC_CHART_HEIGHT / 21) + 2;
  const wdL = getColumnLetter(layout.weightDaily);
  const wsL = getColumnLetter(layout.weightSmooth);

  metrics.forEach((def, m) => {
    const mdL = getColumnLetter(layout.metricDaily(m));
    const msL = getColumnLetter(layout.metricSmooth(m));
    const vAxes = {
      0: { title: def.unit === 'g' ? def.label : 'kcal' },
      1: { title: 'Weight (lb)' },
    };
    if (meta.wtBounds) vAxes[1].viewWindow = { min: meta.wtBounds.min, max: meta.wtBounds.max };

    const chart = sheet.newChart()
      .setChartType(Charts.ChartType.LINE)
      .addRange(sheet.getRange('A1:A'))
      .addRange(sheet.getRange(mdL + '1:' + msL))
      .addRange(sheet.getRange(wdL + '1:' + wsL))
      .setPosition(layout.firstChartRow + m * rowsPerChart, layout.statsCol, 0, 0)
      .setOption('title', def.label + ' & weight — trailing moving average (see Window cell)')
      .setOption('interpolateNulls', true)
      .setOption('series', {
        0: { labelInLegend: def.label + ' (daily)', lineWidth: 0, pointSize: 2, color: def.colors[0], targetAxisIndex: 0 },
        1: { labelInLegend: def.label + ' (avg)', lineWidth: 3, pointSize: 0, color: def.colors[1], targetAxisIndex: 0 },
        2: { labelInLegend: 'Weight (daily)', lineWidth: 0, pointSize: 2, color: TC_WEIGHT_COLORS[0], targetAxisIndex: 1 },
        3: { labelInLegend: 'Weight (avg)', lineWidth: 3, pointSize: 0, color: TC_WEIGHT_COLORS[1], targetAxisIndex: 1 },
      })
      .setOption('vAxes', vAxes)
      .setOption('hAxis', { format: 'MMM yy' })
      .setOption('legend', { position: 'top' })
      .setOption('width', TC_CHART_WIDTH)
      .setOption('height', TC_CHART_HEIGHT)
      .build();
    sheet.insertChart(chart);
  });
}
