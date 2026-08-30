/**
 * ExerciseMapping: upserts muscle-group classification rows into the
 * "ExerciseMapping" sheet, keyed by exercise name (the sheet's "ActivityID"
 * column, despite the name — that's what's actually stored there).
 *
 * The sheet's columns are hand-maintained (it started life with an AI/Gemini
 * formula filling most of them), so nothing here assumes fixed column
 * positions — everything is looked up by header name at call time, and only
 * cells that are currently blank get written. A cell that already has a
 * value (manual correction or the old Gemini formula's output) is never
 * overwritten.
 */

const SHEET_EXERCISE_MAPPING = 'ExerciseMapping';
const EXERCISE_MAPPING_KEY_HEADER = 'ActivityID';
const EXERCISE_MAPPING_MAIN_FOCUS_HEADER = 'Main Focus';
const EXERCISE_MAPPING_MUSCLE_HEADERS = [
  'Quads', 'Hams', 'Glutes', 'Chest', 'Back', 'Shoulders', 'Arms', 'Core', 'Calves',
];

// Speediance-hardware app catalog muscles -> this sheet's coarser 9-bucket
// taxonomy. Muscles with no reasonable bucket (e.g. "neck") map to nothing.
const APP_MUSCLE_TO_SHEET_BUCKET = {
  quadriceps: 'Quads',
  hamstrings: 'Hams',
  glutes: 'Glutes',
  abductors: 'Glutes',
  adductors: 'Glutes',
  chest: 'Chest',
  lats: 'Back',
  'middle back': 'Back',
  'lower back': 'Back',
  traps: 'Back',
  shoulders: 'Shoulders',
  biceps: 'Arms',
  triceps: 'Arms',
  forearms: 'Arms',
  abdominals: 'Core',
  calves: 'Calves',
};

// The map above speaks the Speediance catalog's vocabulary, which is the only
// thing that fed it originally. Callers describing an exercise by hand reach
// for this sheet's own bucket names ("arms", "quads") or everyday synonyms
// ("abs", "biceps"), none of which were keys — so those tags were silently
// dropped and the mapping row came out half-filled and looking fine. Accept
// both vocabularies. Keys must be lowercase; values must be bucket headers.
const EXTRA_MUSCLE_ALIASES = {
  // this sheet's own bucket names, so a caller can echo back what it reads
  quads: 'Quads',
  hams: 'Hams',
  glutes: 'Glutes',
  chest: 'Chest',
  back: 'Back',
  shoulders: 'Shoulders',
  arms: 'Arms',
  core: 'Core',
  calves: 'Calves',
  // everyday synonyms
  quad: 'Quads',
  hamstring: 'Hams',
  ham: 'Hams',
  glute: 'Glutes',
  butt: 'Glutes',
  pecs: 'Chest',
  pectorals: 'Chest',
  lat: 'Back',
  'upper back': 'Back',
  rhomboids: 'Back',
  trapezius: 'Back',
  delts: 'Shoulders',
  deltoids: 'Shoulders',
  shoulder: 'Shoulders',
  arm: 'Arms',
  bicep: 'Arms',
  tricep: 'Arms',
  forearm: 'Arms',
  abs: 'Core',
  ab: 'Core',
  abdominal: 'Core',
  obliques: 'Core',
  calf: 'Calves',
};

/** The full lookup: Speediance catalog terms plus hand-written aliases. */
const MUSCLE_TO_SHEET_BUCKET = Object.assign(
  {}, APP_MUSCLE_TO_SHEET_BUCKET, EXTRA_MUSCLE_ALIASES,
);

/** Every muscle term this API accepts, for error messages and tool docs. */
function acceptedMuscleTerms_() {
  return Object.keys(MUSCLE_TO_SHEET_BUCKET).sort();
}

/** Muscle terms that matched nothing, so callers hear about it rather than
 *  silently getting a mapping row with fewer tags than they asked for. */
function unrecognizedMuscles_(muscles) {
  return (muscles || [])
    .map(m => String(m || '').trim())
    .filter(m => m && !MUSCLE_TO_SHEET_BUCKET[m.toLowerCase()]);
}

function sheetBucketsForMuscles_(muscles) {
  const buckets = new Set();
  for (const muscle of muscles || []) {
    const bucket = MUSCLE_TO_SHEET_BUCKET[String(muscle || '').trim().toLowerCase()];
    if (bucket) buckets.add(bucket);
  }
  return buckets;
}

function getExerciseMappingSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_EXERCISE_MAPPING);
}

/** Reads the CURRENT header row and returns {headerName: 1-based column index}. */
function getExerciseMappingHeaderIndexMap_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) return {};
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const map = {};
  headers.forEach((header, i) => {
    const name = String(header || '').trim();
    if (name) map[name] = i + 1;
  });
  return map;
}

function findExerciseMappingRow_(sheet, keyColumn, exerciseName) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const keys = sheet.getRange(2, keyColumn, lastRow - 1, 1).getValues();
  const target = String(exerciseName || '').trim().toLowerCase();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0] || '').trim().toLowerCase() === target) return i + 2; // 1-based row, +1 for header
  }
  return -1;
}

/**
 * Upserts a muscle-group classification for one exercise, keyed by name.
 * Only fills in currently-blank cells (checked cell-by-cell, not row-by-row)
 * so it never clobbers a manual or AI-generated classification already
 * there. Returns an error result rather than creating the sheet if it's
 * missing — its layout/formulas are hand-maintained and shouldn't be
 * recreated blind.
 *
 * Does NOT acquire the script lock itself — callers already inside a locked
 * section (like handlePostStrengthWorkout) can call this directly; the
 * standalone endpoint below acquires its own lock before calling in.
 */
function upsertExerciseMappingUnlocked_(exerciseName, { primaryMuscles = [], secondaryMuscles = [] } = {}) {
  const name = String(exerciseName || '').trim();
  if (!name) return { status: 'error', message: 'exerciseName is required' };

  const sheet = getExerciseMappingSheet_();
  if (!sheet) return { status: 'error', message: `Sheet "${SHEET_EXERCISE_MAPPING}" not found` };

  const headerIndex = getExerciseMappingHeaderIndexMap_(sheet);
  const keyColumn = headerIndex[EXERCISE_MAPPING_KEY_HEADER];
  if (!keyColumn) {
    return { status: 'error', message: `Column "${EXERCISE_MAPPING_KEY_HEADER}" not found` };
  }

  const buckets = sheetBucketsForMuscles_([...(primaryMuscles || []), ...(secondaryMuscles || [])]);
  const mainFocusBuckets = sheetBucketsForMuscles_(primaryMuscles);
  const mainFocus = mainFocusBuckets.size ? [...mainFocusBuckets][0] : '';

  let row = findExerciseMappingRow_(sheet, keyColumn, name);
  let status = 'updated';
  if (row === -1) {
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, keyColumn).setValue(name);
    status = 'created';
  }

  const written = [];
  const setIfBlank = (header, value) => {
    const column = headerIndex[header];
    if (!column || value === '' || value === undefined) return;
    const cell = sheet.getRange(row, column);
    if (String(cell.getValue() || '').trim() !== '') return; // never clobber an existing value
    cell.setValue(value);
    written.push(header);
  };

  if (mainFocus) setIfBlank(EXERCISE_MAPPING_MAIN_FOCUS_HEADER, mainFocus);
  for (const header of EXERCISE_MAPPING_MUSCLE_HEADERS) {
    if (buckets.has(header)) setIfBlank(header, 1);
  }

  const ignored = unrecognizedMuscles_([
    ...(primaryMuscles || []), ...(secondaryMuscles || []),
  ]);
  const result = { status, row, exerciseName: name, written };
  if (ignored.length) {
    result.ignoredMuscles = ignored;
    result.warning = `Unrecognized muscle term(s) ignored: ${ignored.join(', ')}. `
      + `Accepted terms: ${acceptedMuscleTerms_().join(', ')}.`;
  }
  if (!written.length && !ignored.length) {
    result.note = 'No cells written - every target cell already had a value (existing values are never overwritten).';
  }
  return result;
}

/**
 * Called from handlePostStrengthWorkout (already inside its own lock) for
 * every exercise in the incoming workout that carries muscle data — lets a
 * workout upload silently backfill the classification sheet for exercises
 * it doesn't have an entry for yet, without ever touching an entry that's
 * already there. Never throws: a single bad/missing sheet just means no
 * mappings get written, not a failed workout upload.
 */
function upsertExerciseMappingsFromWorkout_(workoutData) {
  const exercises = Array.isArray(workoutData && workoutData.cttActionLibraryTrainingInfoList)
    ? workoutData.cttActionLibraryTrainingInfoList
    : [];
  const results = [];
  for (const exercise of exercises) {
    const hasMuscleData = (exercise.primaryMuscles && exercise.primaryMuscles.length)
      || (exercise.secondaryMuscles && exercise.secondaryMuscles.length);
    if (!hasMuscleData) continue;
    try {
      results.push(upsertExerciseMappingUnlocked_(exercise.actionLibraryName, {
        primaryMuscles: exercise.primaryMuscles,
        secondaryMuscles: exercise.secondaryMuscles,
      }));
    } catch (err) {
      logError('Error in upsertExerciseMappingsFromWorkout_', {
        exercise: exercise.actionLibraryName,
        err: err.message,
      });
    }
  }
  return results;
}

/** POST /upsertExerciseMapping — body: {exerciseName, primaryMuscles, secondaryMuscles} */
function handlePostUpsertExerciseMapping(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const raw = e.postData && e.postData.contents ? e.postData.contents : '{}';
    const body = JSON.parse(raw);
    const result = upsertExerciseMappingUnlocked_(body.exerciseName, {
      primaryMuscles: body.primaryMuscles,
      secondaryMuscles: body.secondaryMuscles,
    });
    const responseStatus = result.status === 'error' ? 400 : result.status === 'created' ? 201 : 200;
    return sendJsonResponse(result, responseStatus);
  } catch (err) {
    logError('Error in handlePostUpsertExerciseMapping', { err: err.message, stack: err.stack });
    return sendJsonResponse({ error: 'Failed to upsert exercise mapping', message: err.message }, 500);
  } finally {
    try { lock.releaseLock(); } catch (releaseError) { /* ignore */ }
  }
}

/**
 * GET /strength/exercises/uncategorized
 *
 * Cross-references every distinct exercise name in the Strength Sets sheet
 * against the ExerciseMapping sheet and returns the ones carrying no muscle
 * tags. This is the worklist for "categorize my untagged exercises": hand it
 * to an agent, let it tag each one via POST /upsertExerciseMapping.
 *
 * Worth knowing: the Sets sheet resolves its focus columns by lookup against
 * ExerciseMapping at read time, so tagging an exercise here retroactively
 * categorizes every set ever logged under that name. There is no backfill to
 * run afterward.
 *
 * Params:
 *   includeCategorized=true  - return tagged exercises too, each with status
 *   daysBack=N               - only consider sets logged in the last N days
 */
function handleGetUncategorizedExercises(e) {
  const params = (e && e.parameter) || {};
  const includeCategorized = isTruthyParam_(params.includeCategorized || params.include_categorized);
  const daysBack = Number(params.daysBack || params.days_back || 0);

  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // --- distinct exercise names from the Sets sheet, with usage stats -------
  const setsSheet = ss.getSheetByName(SHEET_STRENGTH_SETS);
  const setsData = setsSheet.getDataRange().getValues();
  const setsHeaders = setsData.shift();
  const sIdx = {};
  setsHeaders.forEach((h, i) => (sIdx[h] = i));
  const tsCol = sIdx['endTimestamp'] !== undefined ? 'endTimestamp' : 'EndTimestamp';

  const cutoffMillis = (isFinite(daysBack) && daysBack > 0)
    ? Date.now() - daysBack * 24 * 60 * 60 * 1000
    : 0;

  const byName = {};
  setsData.forEach(row => {
    const name = String(row[sIdx['ExerciseName']] || '').trim();
    if (!name) return;
    const tsMillis = parseTimestampMillis_(row[sIdx[tsCol]]);
    if (cutoffMillis && (!tsMillis || tsMillis < cutoffMillis)) return;
    const entry = byName[name.toLowerCase()]
      || (byName[name.toLowerCase()] = { exerciseName: name, setCount: 0, lastSeen: '' });
    entry.setCount++;
    if (tsMillis) {
      const day = formatAsDateString(new Date(tsMillis));
      if (day > entry.lastSeen) entry.lastSeen = day;
    }
  });

  // --- the mapping sheet, read once (not once per exercise) ---------------
  const mapSheet = getExerciseMappingSheet_();
  if (!mapSheet) {
    return { error: `Sheet "${SHEET_EXERCISE_MAPPING}" not found`, items: [] };
  }
  const headerIndex = getExerciseMappingHeaderIndexMap_(mapSheet);
  const keyColumn = headerIndex[EXERCISE_MAPPING_KEY_HEADER];
  if (!keyColumn) {
    return { error: `Column "${EXERCISE_MAPPING_KEY_HEADER}" not found`, items: [] };
  }
  const lastRow = mapSheet.getLastRow();
  const lastCol = mapSheet.getLastColumn();
  const mapRows = lastRow > 1 ? mapSheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  const mapByName = {};
  mapRows.forEach(row => {
    const key = String(row[keyColumn - 1] || '').trim().toLowerCase();
    if (key) mapByName[key] = row;
  });

  // Only muscle-bucket columns that actually exist on the sheet today.
  const presentMuscleHeaders = EXERCISE_MAPPING_MUSCLE_HEADERS
    .filter(h => headerIndex[h]);

  const items = [];
  Object.keys(byName).forEach(key => {
    const entry = byName[key];
    const mapRow = mapByName[key];
    const tags = [];
    if (mapRow) {
      presentMuscleHeaders.forEach(h => {
        if (Number(mapRow[headerIndex[h] - 1]) === 1) tags.push(h);
      });
    }
    const mainFocus = (mapRow && headerIndex[EXERCISE_MAPPING_MAIN_FOCUS_HEADER])
      ? String(mapRow[headerIndex[EXERCISE_MAPPING_MAIN_FOCUS_HEADER] - 1] || '').trim()
      : '';

    const categorized = tags.length > 0;
    if (categorized && !includeCategorized) return;

    const item = {
      exerciseName: entry.exerciseName,
      setCount: entry.setCount,
      lastSeen: entry.lastSeen,
      categorized: categorized,
      status: !mapRow ? 'no_mapping_row'
        : (categorized ? 'categorized' : 'row_present_but_untagged'),
    };
    if (mainFocus) item.mainFocus = mainFocus;
    if (tags.length) item.tags = tags;
    items.push(item);
  });

  // Most-used first, then most-recent: the highest-value things to tag.
  items.sort((a, b) => (b.setCount - a.setCount)
    || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return items;
}
