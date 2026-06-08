/**
 * Activity ledger: source-aware exercise/activity rows used for sync,
 * review, and nutrition summary formulas.
 */

const SHEET_ACTIVITIES = 'Activities';
const SHEET_ACTIVITY_MIGRATION_BACKUP = 'Activity Migration Backup';
const SHEET_ACTIVITY_MIGRATION_STATUS = 'Activity Migration Status';
const SHEET_SETTINGS = 'Settings';

const ACTIVITY_HEADERS = [
  'ActivityKey',
  'Date',
  'StartTime',
  'EndTime',
  'Type',
  'Name',
  'Description',
  'TotalKcal',
  'CarbGrams',
  'CreditOverrideKcal',
  'CreditPolicy',
  'Source',
  'SourceID',
  'StravaID',
  'XertID',
  'SpeedianceID',
  'LegacyLogID',
  'ProjectedLogID',
  'Review',
  'ReviewNote',
  'DistanceMeters',
  'DurationSec',
  'RawJSON',
  'UpdatedAt'
];

function setupActivitiesSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_ACTIVITIES);
  ensureHeaderRow_(sh, ACTIVITY_HEADERS);
  sh.setFrozenRows(1);
  setupNutritionSettingsSheet();
  SpreadsheetApp.getActive().toast('Activities sheet ready', 'Activity Setup', 5);
}

function setupNutritionSettingsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_SETTINGS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([['Key', 'Value', 'Description', 'UpdatedAt']]);
    sh.setFrozenRows(1);
  }
  const defaults = [
    ['activity_credit_mode', 'percent_total', 'percent_total, carb_only, or none'],
    ['activity_credit_rate', 0.5, 'Fraction of TotalKcal credited when activity_credit_mode is percent_total'],
    ['carb_kcal_per_gram', 3.75, 'Kcal per carb gram used for carb-only adjusted calorie math'],
    ['target_loss_rate_lb_per_week', 0.5, 'Default target loss rate for later phase analysis']
  ];
  const existing = getSettingsKeySet_(sh);
  const now = new Date().toISOString();
  const rows = defaults
    .filter(row => !existing[row[0]])
    .map(row => [row[0], row[1], row[2], now]);
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  }
}

function getSettingsKeySet_(settingsSheet) {
  const values = settingsSheet.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    if (values[i][0]) out[String(values[i][0])] = true;
  }
  return out;
}

function handleGetSettings(e) {
  return sendJsonResponse(readNutritionSettings(e));
}

function handlePostSettings(e, method) {
  const payload = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const requestMethod = String(payload.method || payload.action || method || 'POST').toUpperCase();
  if (requestMethod === 'DELETE' || requestMethod === 'REMOVE') {
    return sendJsonResponse(deleteNutritionSetting(payload));
  }
  return sendJsonResponse(updateNutritionSettings(payload));
}

function readNutritionSettings(e) {
  setupNutritionSettingsSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_SETTINGS);
  const key = e && e.parameter ? e.parameter.key : '';
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  const items = values
    .filter(row => row[0])
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    })
    .filter(row => !key || String(row.Key) === String(key));
  return key ? (items[0] || { error: 'not_found', key: key }) : { items: items };
}

function updateNutritionSettings(payload) {
  setupNutritionSettingsSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_SETTINGS);
  const updates = normalizeSettingsPayload_(payload);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  const now = new Date().toISOString();
  const results = [];

  updates.forEach(update => {
    if (!update.Key) {
      results.push({ status: 'error', message: 'Key required' });
      return;
    }

    let rowNum = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idx.Key]) === String(update.Key)) {
        rowNum = i + 1;
        break;
      }
    }

    const row = headers.map(h => {
      if (h === 'Key') return update.Key;
      if (h === 'Value') return update.Value;
      if (h === 'Description') return update.Description || (rowNum > 0 ? data[rowNum - 1][idx.Description] : '');
      if (h === 'UpdatedAt') return now;
      return update[h] !== undefined ? update[h] : '';
    });

    if (rowNum > 0) {
      sh.getRange(rowNum, 1, 1, headers.length).setValues([row]);
      results.push({ status: 'updated', key: update.Key });
    } else {
      sh.getRange(sh.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
      results.push({ status: 'created', key: update.Key });
    }
  });

  return payload.items || payload.settings ? { results: results } : results[0];
}

function normalizeSettingsPayload_(payload) {
  if (payload.items && Array.isArray(payload.items)) {
    return payload.items.map(normalizeSettingItem_);
  }
  if (payload.settings && typeof payload.settings === 'object') {
    return Object.keys(payload.settings).map(key => ({
      Key: key,
      Value: payload.settings[key],
      Description: payload.descriptions && payload.descriptions[key] ? payload.descriptions[key] : ''
    }));
  }
  return [normalizeSettingItem_(payload)];
}

function normalizeSettingItem_(item) {
  return {
    Key: item.Key || item.key,
    Value: item.Value !== undefined ? item.Value : item.value,
    Description: item.Description || item.description || ''
  };
}

function deleteNutritionSetting(payload) {
  const key = payload.Key || payload.key;
  if (!key) return { status: 'error', message: 'Key required for delete' };
  setupNutritionSettingsSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_SETTINGS);
  const data = sh.getDataRange().getValues();
  const idx = getHeaderIndexMap_(data[0]);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.Key]) === String(key)) {
      sh.deleteRow(i + 1);
      return { status: 'deleted', key: key };
    }
  }
  return { status: 'not_found', key: key };
}

function ensureActivitiesSheetExists_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_ACTIVITIES);
  ensureHeaderRow_(sh, ACTIVITY_HEADERS);
  return sh;
}

function ensureHeaderRow_(sheet, headers) {
  const existingLastCol = Math.max(sheet.getLastColumn(), headers.length);
  const existing = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, existingLastCol).getValues()[0]
    : [];

  if (sheet.getLastRow() === 0 || !existing[0]) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (!missing.length) return;

  const startCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
}

function getHeaderIndexMap_(headers) {
  const out = {};
  headers.forEach((h, i) => {
    if (h) out[h] = i;
  });
  return out;
}

function readSheetObjects_(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data.shift();
  return data
    .filter(row => row.some(v => v !== '' && v !== null))
    .map((row, i) => {
      const obj = { _rowNum: i + 2 };
      headers.forEach((h, col) => {
        if (h) obj[h] = row[col];
      });
      return obj;
    });
}

function readActivities(e) {
  const sh = ensureActivitiesSheetExists_();
  const rows = readSheetObjects_(sh);
  const params = (e && e.parameter) || {};
  const startDate = params.start_date || params.startDate;
  const endDate = params.end_date || params.endDate;
  const review = params.review;
  const date = params.date;

  const filtered = rows.filter(row => {
    const rowDate = formatAsDateString(row.Date);
    if (date && rowDate !== date) return false;
    if (startDate && rowDate < startDate) return false;
    if (endDate && rowDate > endDate) return false;
    if (review && String(row.Review || '') !== String(review)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const ad = String(a.Date || '');
    const bd = String(b.Date || '');
    const at = String(a.StartTime || '');
    const bt = String(b.StartTime || '');
    return (bd + bt).localeCompare(ad + at);
  });
  return filtered.map(row => {
    const clean = {};
    Object.keys(row).forEach(k => {
      if (k !== '_rowNum') clean[k] = row[k];
    });
    return clean;
  });
}

function handleGetActivities(e) {
  return sendJsonResponse(paginateArray(readActivities(e), e));
}

function handlePostActivity(e, method) {
  const payload = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const requestMethod = String(payload.method || payload.action || method || 'POST').toUpperCase();
  if (requestMethod === 'DELETE' || requestMethod === 'REMOVE') {
    if (payload.items && Array.isArray(payload.items)) {
      return sendJsonResponse({ results: payload.items.map(item => deleteActivity(item)) });
    }
    return sendJsonResponse(deleteActivity(payload));
  }
  if (payload.items && Array.isArray(payload.items)) {
    const results = upsertActivities(payload.items);
    return sendJsonResponse({ results: results });
  }
  return sendJsonResponse(upsertActivity(payload));
}

function upsertActivities(items) {
  return items.map(item => upsertActivity(item));
}

function upsertActivity(input) {
  const sh = ensureActivitiesSheetExists_();
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  const activity = normalizeActivityInput_(input);
  const disableLegacyMatch = toBool_(input && (input.DisableLegacyMatch !== undefined ? input.DisableLegacyMatch : input.disableLegacyMatch));

  if (!activity.ActivityKey) {
    return { status: 'error', message: 'ActivityKey or Source+SourceID required' };
  }

  let rowNum = -1;
  let matchedLegacy = false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.ActivityKey]) === String(activity.ActivityKey)) {
      rowNum = i + 1;
      break;
    }
  }

  if (rowNum < 0 && !disableLegacyMatch) {
    const legacyMatch = findLegacyActivityMatch_(data, idx, activity);
    if (legacyMatch.match) {
      rowNum = legacyMatch.match.rowNum;
      matchedLegacy = true;
      mergeLegacyIdentityIntoActivity_(activity, legacyMatch.match.row, idx);
    } else if (legacyMatch.ambiguousCount > 1) {
      markActivityAmbiguousLegacyMatch_(activity, legacyMatch.ambiguousCount);
    }
  }

  const now = new Date().toISOString();
  activity.UpdatedAt = activity.UpdatedAt || now;
  if (rowNum > 0) {
    removeImplicitActivityDefaultsForUpdate_(activity, input);
    activity.UpdatedAt = activity.UpdatedAt || now;
  }

  const row = headers.map(h => {
    if (!h) return '';
    if (activity[h] !== undefined) return activity[h];
    if (rowNum > 0) return data[rowNum - 1][idx[h]];
    return '';
  });

  if (rowNum > 0) {
    sh.getRange(rowNum, 1, 1, headers.length).setValues([row]);
    return {
      status: matchedLegacy ? 'matched_legacy' : 'updated',
      activityKey: activity.ActivityKey,
      row: rowNum
    };
  }

  rowNum = sh.getLastRow() + 1;
  sh.getRange(rowNum, 1, 1, headers.length).setValues([row]);
  return { status: 'created', activityKey: activity.ActivityKey, row: rowNum };
}

function findLegacyActivityMatch_(data, idx, activity) {
  if (!shouldMatchIncomingActivityToLegacy_(activity)) {
    return { match: null, ambiguousCount: 0 };
  }

  const matches = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!isUnclaimedLegacyActivityRow_(row, idx)) continue;
    if (!activityMatchesLegacyRow_(activity, row, idx)) continue;
    matches.push({ rowNum: i + 1, row: row });
  }

  return {
    match: matches.length === 1 ? matches[0] : null,
    ambiguousCount: matches.length
  };
}

function shouldMatchIncomingActivityToLegacy_(activity) {
  const source = String(activity.Source || '').toLowerCase();
  return source === 'strava' || source === 'xert' || source === 'speediance';
}

function isUnclaimedLegacyActivityRow_(row, idx) {
  const source = String(row[idx.Source] || '').toLowerCase();
  const policy = String(row[idx.CreditPolicy] || '').toLowerCase();
  const key = String(row[idx.ActivityKey] || '').toLowerCase();
  const hasExternalId = String(row[idx.StravaID] || row[idx.XertID] || row[idx.SpeedianceID] || '');

  if (hasExternalId) return false;
  return source === 'legacy_log' ||
    source === 'legacy_xert' ||
    policy === 'legacy' ||
    key.indexOf('legacy_log:') === 0 ||
    key.indexOf('legacy_xert:') === 0;
}

function activityMatchesLegacyRow_(activity, row, idx) {
  if (formatAsDateString(row[idx.Date]) !== formatAsDateString(activity.Date)) return false;
  if (!caloriesCloseForLegacyMatch_(activity.TotalKcal, row[idx.TotalKcal])) return false;

  const incomingCarbs = numberOrBlank_(activity.CarbGrams);
  const legacyCarbs = numberOrBlank_(row[idx.CarbGrams]);
  if (incomingCarbs !== '' && legacyCarbs !== '') {
    return numbersClose_(incomingCarbs, legacyCarbs, 1);
  }

  if (incomingCarbs === '' && legacyCarbs === '') {
    return activityTypesCompatible_(activity.Type, row[idx.Type]);
  }

  return false;
}

function numbersClose_(a, b, tolerance) {
  const left = numberOrBlank_(a);
  const right = numberOrBlank_(b);
  if (left === '' || right === '') return false;
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function caloriesCloseForLegacyMatch_(a, b) {
  const left = numberOrBlank_(a);
  const right = numberOrBlank_(b);
  if (left === '' || right === '') return false;
  const tolerance = Math.max(5, Math.max(Math.abs(Number(left)), Math.abs(Number(right))) * 0.01);
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function activityTypesCompatible_(a, b) {
  const left = normalizeActivityTypeForMatch_(a);
  const right = normalizeActivityTypeForMatch_(b);
  if (!left || !right) return true;
  if (left === right) return true;
  return (left === 'ride' && right === 'virtualride') ||
    (left === 'virtualride' && right === 'ride') ||
    (left === 'strength' && right === 'weighttraining') ||
    (left === 'weighttraining' && right === 'strength');
}

function normalizeActivityTypeForMatch_(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  if (text.indexOf('ride') !== -1 || text.indexOf('cycling') !== -1) return 'ride';
  if (text.indexOf('walk') !== -1) return 'walk';
  if (text.indexOf('hike') !== -1) return 'hike';
  if (text.indexOf('strength') !== -1 || text.indexOf('weighttraining') !== -1 || text.indexOf('lift') !== -1) return 'strength';
  return text;
}

function mergeLegacyIdentityIntoActivity_(activity, legacyRow, idx) {
  const legacyKey = legacyRow[idx.ActivityKey] || '';
  const legacyLogId = legacyRow[idx.LegacyLogID] || legacyRow[idx.SourceID] || '';
  const previousNote = String(legacyRow[idx.ReviewNote] || '');
  const matchNote = `Matched legacy activity ${legacyKey} by date/kcal/carbs`;

  activity.LegacyLogID = activity.LegacyLogID || legacyLogId;
  activity.ProjectedLogID = activity.ProjectedLogID || legacyRow[idx.ProjectedLogID] || '';
  activity.Review = 'source_matched';
  activity.ReviewNote = previousNote ? `${previousNote}; ${matchNote}` : matchNote;
}

function markActivityAmbiguousLegacyMatch_(activity, ambiguousCount) {
  const previousNote = String(activity.ReviewNote || '');
  const matchNote = `Found ${ambiguousCount} possible legacy matches by date/kcal/carbs; manual review required`;
  activity.Review = 'needs_review';
  activity.ReviewNote = previousNote ? `${previousNote}; ${matchNote}` : matchNote;
}

function reconcileStravaLegacyActivityDuplicates() {
  const sh = ensureActivitiesSheetExists_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { merged: 0, deleted: 0 };

  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  const rowsToDelete = [];
  const merged = [];

  for (let i = 1; i < data.length; i++) {
    const sourceRow = data[i];
    if (String(sourceRow[idx.Source] || '').toLowerCase() !== 'strava') continue;

    const activity = {};
    headers.forEach((h, col) => {
      if (h) activity[h] = sourceRow[col];
    });

    const candidates = [];
    for (let j = 1; j < data.length; j++) {
      if (j === i) continue;
      const legacyRow = data[j];
      if (!isUnclaimedLegacyActivityRow_(legacyRow, idx)) continue;
      if (!activityMatchesLegacyRow_(activity, legacyRow, idx)) continue;
      candidates.push({ rowIndex: j, rowNum: j + 1, row: legacyRow });
    }

    if (candidates.length !== 1) continue;

    const target = candidates[0];
    mergeLegacyIdentityIntoActivity_(activity, target.row, idx);
    activity.UpdatedAt = new Date().toISOString();
    const mergedRow = headers.map(h => activity[h] !== undefined ? activity[h] : '');
    sh.getRange(target.rowNum, 1, 1, headers.length).setValues([mergedRow]);
    rowsToDelete.push(i + 1);
    merged.push({ activityKey: activity.ActivityKey, legacyRow: target.rowNum, duplicateRow: i + 1 });

    data[target.rowIndex] = mergedRow;
  }

  deleteRowsDescendingInRuns_(sh, rowsToDelete);
  SpreadsheetApp.getActive().toast(
    `Merged ${merged.length} Strava duplicate activities`,
    'Activity Reconcile',
    8
  );
  return { merged: merged.length, deleted: rowsToDelete.length, details: merged };
}

function reconcileStravaLegacyActivityDuplicatesMenu() {
  const result = reconcileStravaLegacyActivityDuplicates();
  SpreadsheetApp.getUi().alert(
    `Merged ${result.merged} Strava rows into matching legacy activity rows and deleted ${result.deleted} duplicate rows.`
  );
}

function deleteActivity(input) {
  const source = input.Source || input.source;
  const sourceId = input.SourceID || input.sourceId || input.id;
  const key = input.ActivityKey || input.activityKey || (source && sourceId ? `${source}:${sourceId}` : '');
  if (!key) return { status: 'error', message: 'ActivityKey or Source+SourceID required for delete' };

  const sh = ensureActivitiesSheetExists_();
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idx.ActivityKey]) === String(key)) {
      sh.deleteRow(i + 1);
      return { status: 'deleted', activityKey: key, row: i + 1 };
    }
  }
  return { status: 'not_found', activityKey: key };
}

function normalizeActivityInput_(input) {
  const out = {};
  ACTIVITY_HEADERS.forEach(h => {
    if (input[h] !== undefined) out[h] = input[h];
  });

  out.Source = out.Source || input.source || '';
  out.SourceID = out.SourceID || input.sourceId || input.id || '';
  out.ActivityKey = out.ActivityKey || input.activityKey || (
    out.Source && out.SourceID ? `${out.Source}:${out.SourceID}` : ''
  );
  out.Date = out.Date || input.date || dateFromAny_(input.StartTime || input.startTime || input.start_date);
  out.StartTime = out.StartTime || input.startTime || input.start_date || '';
  out.EndTime = out.EndTime || input.endTime || input.end_date || '';
  out.Type = out.Type || input.type || input.sport_type || input.activityType || '';
  out.Name = out.Name || input.name || input.Food || '';
  out.Description = out.Description || input.description || input.Description || '';
  out.TotalKcal = numberOrBlank_(out.TotalKcal !== undefined ? out.TotalKcal : input.totalKcal);
  out.CarbGrams = numberOrBlank_(out.CarbGrams !== undefined ? out.CarbGrams : input.carbGrams);
  out.CreditOverrideKcal = numberOrBlank_(
    out.CreditOverrideKcal !== undefined
      ? out.CreditOverrideKcal
      : (input.CreditKcal !== undefined ? input.CreditKcal : input.creditKcal)
  );
  out.CreditPolicy = out.CreditPolicy || input.creditPolicy || '';
  out.Review = out.Review || input.review || 'ok';
  out.ReviewNote = out.ReviewNote || input.reviewNote || '';
  out.DistanceMeters = numberOrBlank_(out.DistanceMeters !== undefined ? out.DistanceMeters : input.distanceMeters);
  out.DurationSec = numberOrBlank_(out.DurationSec !== undefined ? out.DurationSec : input.durationSec);
  out.RawJSON = out.RawJSON || (input.RawJSON ? input.RawJSON : JSON.stringify(input));

  return out;
}

function removeImplicitActivityDefaultsForUpdate_(activity, input) {
  const explicit = {};
  Object.keys(input || {}).forEach(k => explicit[k] = true);

  const fieldAliases = {
    Date: ['Date', 'date', 'StartTime', 'startTime', 'start_date'],
    StartTime: ['StartTime', 'startTime', 'start_date'],
    EndTime: ['EndTime', 'endTime', 'end_date'],
    Type: ['Type', 'type', 'sport_type', 'activityType'],
    Name: ['Name', 'name', 'Food'],
    Description: ['Description', 'description'],
    TotalKcal: ['TotalKcal', 'totalKcal'],
    CarbGrams: ['CarbGrams', 'carbGrams'],
    CreditOverrideKcal: ['CreditOverrideKcal', 'CreditKcal', 'creditKcal'],
    CreditPolicy: ['CreditPolicy', 'creditPolicy'],
    Source: ['Source', 'source'],
    SourceID: ['SourceID', 'sourceId', 'id'],
    StravaID: ['StravaID'],
    XertID: ['XertID'],
    SpeedianceID: ['SpeedianceID'],
    LegacyLogID: ['LegacyLogID'],
    ProjectedLogID: ['ProjectedLogID'],
    Review: ['Review', 'review'],
    ReviewNote: ['ReviewNote', 'reviewNote'],
    DistanceMeters: ['DistanceMeters', 'distanceMeters'],
    DurationSec: ['DurationSec', 'durationSec'],
    RawJSON: ['RawJSON']
  };

  Object.keys(fieldAliases).forEach(field => {
    const wasProvided = fieldAliases[field].some(alias => explicit[alias]);
    if (!wasProvided) delete activity[field];
  });
}

function numberOrBlank_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function toBool_(v) {
  if (v === true || v === false) return v;
  if (v === null || v === undefined) return false;
  const text = String(v).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function dateFromAny_(value) {
  if (!value) return '';
  return formatAsDateString(value);
}

function isExerciseLogRow_(row, idx) {
  const kcal = Number(row[idx.kcal]);
  const carbs = Number(row[idx.carbs]);
  const meal = String(row[idx.Meal] || '').toLowerCase();
  return kcal < 0 || carbs < 0 || meal === 'exercise';
}

function migrateNegativeLogRowsToActivities() {
  return migrateNegativeLogRowsToActivitiesChunked_(500);
}

function migrateNegativeLogRowsToActivitiesChunked_(maxRows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const startedAt = new Date();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('Log');
    if (!logSheet) throw new Error('Log sheet not found');
    const activitySheet = ensureActivitiesSheetExists_();
    writeActivityMigrationStatus_('started', { maxRows: maxRows, startedAt: startedAt.toISOString() });

    const values = logSheet.getDataRange().getValues();
    if (values.length < 2) {
      writeActivityMigrationStatus_('done', { migrated: 0, deletedLogRows: 0, message: 'No log rows to migrate' });
      return { migrated: 0, deletedLogRows: 0, message: 'No log rows to migrate' };
    }

    const headers = values[0];
    const idx = getHeaderIndexMap_(headers);
    const required = ['ID', 'Date', 'Meal', 'Food', 'Description', 'kcal', 'carbs'];
    required.forEach(h => {
      if (idx[h] === undefined) throw new Error(`Log sheet missing ${h} column`);
    });

    const existingKeys = getExistingActivityKeySet_(activitySheet);
    const existingLegacySignatures = getExistingLegacyActivitySignatureSet_(activitySheet);
    const activityHeaders = activitySheet.getDataRange().getValues()[0];
    const activityRowsToAppend = [];
    const migrated = [];
    const rowsToDelete = [];
    const backupRows = [];
    for (let r = 1; r < values.length; r++) {
      if (rowsToDelete.length >= maxRows) break;
      const row = values[r];
      if (!isExerciseLogRow_(row, idx)) continue;

      const activity = buildLegacyActivityFromLogRow_(headers, row, idx, r + 1);
      const signature = getLegacyActivitySignature_(activity);
      if (!existingKeys[activity.ActivityKey] && !existingLegacySignatures[signature]) {
        const now = new Date().toISOString();
        activity.UpdatedAt = activity.UpdatedAt || now;
        activityRowsToAppend.push(activityHeaders.map(h => activity[h] !== undefined ? activity[h] : ''));
        existingKeys[activity.ActivityKey] = true;
        existingLegacySignatures[signature] = true;
        migrated.push({ status: 'created', activityKey: activity.ActivityKey });
      } else {
        migrated.push({ status: 'already_exists', activityKey: activity.ActivityKey });
      }
      rowsToDelete.push(r + 1);
      backupRows.push(row);
    }

    if (activityRowsToAppend.length) {
      activitySheet
        .getRange(activitySheet.getLastRow() + 1, 1, activityRowsToAppend.length, activityHeaders.length)
        .setValues(activityRowsToAppend);
    }
    writeActivityMigrationStatus_('activities_written', {
      scannedRows: values.length - 1,
      selectedLogRows: rowsToDelete.length,
      createdActivities: activityRowsToAppend.length
    });
    backupMigratedLogRows_(ss, headers, backupRows);
    writeActivityMigrationStatus_('backup_written', {
      backupRows: backupRows.length,
      rowsToDelete: rowsToDelete.length
    });
    deleteRowsDescendingInRuns_(logSheet, rowsToDelete);
    writeActivityMigrationStatus_('log_rows_deleted', {
      deletedLogRows: rowsToDelete.length
    });
    resetSummaryFormulasForActivities();
    writeActivityMigrationStatus_('summary_reset', {
      elapsedSeconds: Math.round((new Date().getTime() - startedAt.getTime()) / 1000)
    });

    SpreadsheetApp.getActive().toast(
      `Processed ${migrated.length} activity rows`,
      'Activity Migration',
      8
    );
    return {
      migrated: migrated.length,
      createdActivities: activityRowsToAppend.length,
      deletedLogRows: rowsToDelete.length,
      activitySheet: activitySheet.getName(),
      summaryUpdated: true,
      partial: rowsToDelete.length >= maxRows
    };
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

function getExistingLegacyActivitySignatureSet_(activitySheet) {
  const data = activitySheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  const out = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const source = String(row[idx.Source] || '');
    if (source !== 'legacy_xert' && source !== 'legacy_log') continue;
    const activity = {
      Date: row[idx.Date],
      Source: row[idx.Source],
      SourceID: row[idx.SourceID],
      LegacyLogID: row[idx.LegacyLogID],
      Name: row[idx.Name],
      TotalKcal: row[idx.TotalKcal],
      CarbGrams: row[idx.CarbGrams]
    };
    out[getLegacyActivitySignature_(activity)] = true;
  }
  return out;
}

function getLegacyActivitySignature_(activity) {
  return [
    formatAsDateString(activity.Date),
    String(activity.Source || ''),
    String(activity.SourceID || ''),
    String(activity.LegacyLogID || ''),
    String(activity.Name || ''),
    String(activity.TotalKcal || ''),
    String(activity.CarbGrams || '')
  ].join('|');
}

function getExistingActivityKeySet_(activitySheet) {
  const data = activitySheet.getDataRange().getValues();
  if (data.length < 2) return {};
  const headers = data[0];
  const idx = getHeaderIndexMap_(headers);
  const out = {};
  for (let i = 1; i < data.length; i++) {
    const key = data[i][idx.ActivityKey];
    if (key) out[String(key)] = true;
  }
  return out;
}

function buildLegacyActivityFromLogRow_(headers, row, idx, rowNum) {
  const id = String(row[idx.ID] || `row-${rowNum}`);
  const kcal = Number(row[idx.kcal]) || 0;
  const carbs = Number(row[idx.carbs]) || 0;
  const food = String(row[idx.Food] || '');
  const description = String(row[idx.Description] || '');
  const source = id.indexOf('xert-') === 0 ? 'legacy_xert' : 'legacy_log';
  const sourceId = id;
  const date = formatAsDateString(row[idx.Date]);
  return {
    ActivityKey: `${source}:${sourceId}:row${rowNum}`,
    Date: date,
    Type: inferActivityType_(food, description),
    Name: food || 'Legacy exercise',
    Description: description,
    TotalKcal: kcal < 0 ? Math.abs(kcal) : '',
    CarbGrams: carbs < 0 ? Math.abs(carbs) : '',
    CreditOverrideKcal: '',
    CreditPolicy: 'legacy',
    Source: source,
    SourceID: sourceId,
    XertID: id.indexOf('xert-') === 0 ? id : '',
    LegacyLogID: id,
    Review: 'legacy_only',
    ReviewNote: 'Migrated from negative Log row',
    RawJSON: JSON.stringify(logRowToObject_(headers, row))
  };
}

function backupMigratedLogRows_(ss, headers, rows) {
  if (!rows.length) return;
  const sh = ensureSheet_(ss, SHEET_ACTIVITY_MIGRATION_BACKUP);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length + 1).setValues([['MigratedAt'].concat(headers)]);
    sh.setFrozenRows(1);
  }
  const now = new Date().toISOString();
  const out = rows.map(row => [now].concat(row));
  sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
}

function migrateNegativeLogRowsToActivitiesMenu() {
  const result = migrateNegativeLogRowsToActivities();
  SpreadsheetApp.getUi().alert(
    `Processed ${result.migrated} activity rows, created ${result.createdActivities}, and removed ${result.deletedLogRows} negative Log rows.`
  );
}

function logRowToObject_(headers, row) {
  const out = {};
  headers.forEach((h, i) => {
    if (h) out[h] = row[i];
  });
  return out;
}

function deleteRowsDescendingInRuns_(sheet, rows) {
  if (!rows.length) return;
  const sorted = rows.slice().sort((a, b) => b - a);
  let runStart = sorted[0];
  let runEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i];
    if (row === runEnd - 1) {
      runEnd = row;
      continue;
    }
    sheet.deleteRows(runEnd, runStart - runEnd + 1);
    runStart = row;
    runEnd = row;
  }
  sheet.deleteRows(runEnd, runStart - runEnd + 1);
}

function writeActivityMigrationStatus_(phase, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_ACTIVITY_MIGRATION_STATUS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['Timestamp', 'Phase', 'Details']]);
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date().toISOString(), phase, JSON.stringify(details || {})]);
}

function inferActivityType_(name, description) {
  const text = `${name || ''} ${description || ''}`.toLowerCase();
  if (text.indexOf('hike') !== -1) return 'Hike';
  if (text.indexOf('walk') !== -1) return 'Walk';
  if (text.indexOf('strength') !== -1 || text.indexOf('lift') !== -1) return 'Strength';
  if (text.indexOf('ride') !== -1 || text.indexOf('xert') !== -1 || text.indexOf('tss') !== -1) return 'Ride';
  return 'Activity';
}

function resetSummaryFormulasForActivities() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  ensureActivitiesSheetExists_();
  setupNutritionSettingsSheet();

  const headers = [
    'Date',
    'Gross kcal',
    'Carb-credit kcal (gross - carb burn)',
    'Net kcal',
    'Effective kcal (gross - activity credit)',
    'Activity credit kcal',
    'Total protein',
    'Total fat',
    'Gross carbs',
    'Net carbs',
    'Total added_sugar',
    'Total fiber',
    'Total alcohol',
    'kcal burned',
    'carbs burned'
  ];
  summarySheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  summarySheet.getRange('A2').setFormula(
    '=SORT(UNIQUE(FILTER({Log!B2:B;Activities!B2:B},{Log!B2:B;Activities!B2:B}<>"")))'
  );
  summarySheet.getRange('B2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F>=0)),0))))'
  );
  summarySheet.getRange('C2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F>=0)),0)-((IFNA(SUM(FILTER(Activities!I:I,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I<0)),0))*3.75))))'
  );
  summarySheet.getRange('D2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F>=0)),0)-(IFNA(SUM(FILTER(Activities!H:H,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F<0)),0)))))'
  );
  summarySheet.getRange('E2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F>=0)),0)-IFNA(SUM(FILTER(Activities!J:J,Activities!B:B=d,Activities!J:J<>"",Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),IF(LOWER(VLOOKUP("activity_credit_mode",Settings!A:B,2,FALSE))="carb_only",(IFNA(SUM(FILTER(Activities!I:I,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I<0)),0))*VLOOKUP("carb_kcal_per_gram",Settings!A:B,2,FALSE),IF(LOWER(VLOOKUP("activity_credit_mode",Settings!A:B,2,FALSE))="none",0,(IFNA(SUM(FILTER(Activities!H:H,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F<0)),0))*VLOOKUP("activity_credit_rate",Settings!A:B,2,FALSE)))))))'
  );
  summarySheet.getRange('F2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Activities!J:J,Activities!B:B=d,Activities!J:J<>"",Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),IF(LOWER(VLOOKUP("activity_credit_mode",Settings!A:B,2,FALSE))="carb_only",(IFNA(SUM(FILTER(Activities!I:I,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I<0)),0))*VLOOKUP("carb_kcal_per_gram",Settings!A:B,2,FALSE),IF(LOWER(VLOOKUP("activity_credit_mode",Settings!A:B,2,FALSE))="none",0,(IFNA(SUM(FILTER(Activities!H:H,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F<0)),0))*VLOOKUP("activity_credit_rate",Settings!A:B,2,FALSE)))))))'
  );
  summarySheet.getRange('G2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!G:G,Log!B:B=d)),0))))'
  );
  summarySheet.getRange('H2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!H:H,Log!B:B=d)),0))))'
  );
  summarySheet.getRange('I2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I>=0)),0))))'
  );
  summarySheet.getRange('J2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I>=0)),0)-(IFNA(SUM(FILTER(Activities!I:I,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I<0)),0)))))'
  );
  summarySheet.getRange('K2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!J:J,Log!B:B=d)),0))))'
  );
  summarySheet.getRange('L2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!K:K,Log!B:B=d)),0))))'
  );
  summarySheet.getRange('M2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Log!L:L,Log!B:B=d)),0))))'
  );
  summarySheet.getRange('N2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Activities!H:H,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!F:F,Log!B:B=d,Log!F:F<0)),0))))'
  );
  summarySheet.getRange('O2').setFormula(
    '=MAP(A2:A,LAMBDA(d,IF(d="","",IFNA(SUM(FILTER(Activities!I:I,Activities!B:B=d,Activities!S:S<>"duplicate",Activities!S:S<>"ignore")),0)+IFNA(-SUM(FILTER(Log!I:I,Log!B:B=d,Log!I:I<0)),0))))'
  );

  SpreadsheetApp.getActive().toast('Summary formulas updated for Activities', 'Activity Setup', 5);
}
