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

function sheetBucketsForMuscles_(muscles) {
  const buckets = new Set();
  for (const muscle of muscles || []) {
    const bucket = APP_MUSCLE_TO_SHEET_BUCKET[String(muscle || '').trim().toLowerCase()];
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

  return { status, row, exerciseName: name, written };
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
