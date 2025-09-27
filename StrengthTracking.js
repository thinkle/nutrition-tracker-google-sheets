/**
 * GET /strength/sets/filter
 * Query params:
 *   daysBack: integer (optional, default 7)
 *   focus: comma-separated list of body part columns (optional)
 *   movement: string (optional, matches Movement Type)
 *   exercise: string (optional, matches ExerciseName)
 * Returns all sets matching filters ("or" logic for focus columns)
 */
/**
 * Standalone filter for strength sets.
 * @param {number} daysBack - How many days back to include
 * @param {object} opts - { focus: [cols], movementType: str, exercise: str }
 * @returns {Array<Object>} matching set rows
 */
function getStrengthSets(daysBack, opts) {
  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_STRENGTH_SETS);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  opts = opts || {};
  const focusCols = (opts.focus || []).map(s => s.trim().toLowerCase());
  const movement = (opts.movementType || '').toLowerCase();
  const exercise = (opts.exercise || '').toLowerCase();

  // Date cutoff
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  // Find the timestamp column
  const tsCol = idx['endTimestamp'] !== undefined ? 'endTimestamp' : 'EndTimestamp';

  // Lowercase header map for focus matching
  const headerMap = {};
  headers.forEach((h, i) => headerMap[h.toLowerCase()] = i);

  // Filter rows
  const filtered = data.filter(row => {
    // Date filter
    const ts = Number(row[idx[tsCol]]);
    if (!ts || new Date(ts * 1000) < cutoff) return false;

    // Movement Type filter
    if (movement && String(row[idx['Movement Type']] || '').toLowerCase().indexOf(movement) === -1) return false;

    // ExerciseName filter
    if (exercise && String(row[idx['ExerciseName']] || '').toLowerCase().indexOf(exercise) === -1) return false;

    // Focus columns ("or" logic, case-insensitive)
    if (focusCols.length) {
      let found = false;
      for (let col of focusCols) {
        const i = headerMap[col];
        if (i !== undefined && Number(row[i]) === 1) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  });

  // Map to objects
  const out = filtered.map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return out;
}

function handleGetStrengthSetsFilter(e) {
  // Parse params
  const daysBack = Number(e.parameter.daysBack || 7);
  const focusRaw = e.parameter.focus || '';
  const focusCols = focusRaw.split(',').map(s => s.trim()).filter(Boolean);
  const movement = (e.parameter.movement || '');
  const exercise = (e.parameter.exercise || '');
  const out = getStrengthSets(daysBack, {
    focus: focusCols,
    movementType: movement,
    exercise: exercise
  });
  return sendJsonResponse(out);
}

function testStrengthSetFilter() {
  console.log('--- 7 days, arms/shoulders ---');
  console.log(getStrengthSets(7, { focus: ['arms', 'shoulders'] }));
  console.log('--- 14 days, movementType: Isolation ---');
  console.log(getStrengthSets(14, { movementType: 'Isolation' }));
  console.log('--- 21 days, exercise: squat ---');
  console.log(getStrengthSets(21, { exercise: 'squat' }));
}
/**
 * Strength workout ingestion: POST /logStrengthWorkout
 * Accepts either the wrapper {code,message,data} or just the data object.
 * - Saves Strength Workouts row by ID (create/update)
 * - Replaces Strength Sets rows for that WorkoutID with performed sets
 */

function handlePostStrengthWorkout(e) {
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : "{}";
    const parsed = JSON.parse(raw);
    const data = parsed && parsed.data ? parsed.data : parsed; // accept wrapper or raw

    if (!data || !data.id) {
      return sendJsonResponse({ error: "Missing data.id in payload" }, 400);
    }

    ensureStrengthSheetsExist_();

    const saveResult = saveStrengthWorkout_(data, raw);
    const replaceResult = replaceStrengthSets_(data);

    return sendJsonResponse(
      {
        status: saveResult.status,
        id: data.id,
        workoutRow: saveResult.rowNum,
        setsInserted: replaceResult.inserted,
        exercisesProcessed: replaceResult.exercises,
      },
      saveResult.status === "created" ? 201 : 200
    );
  } catch (err) {
    logError("Error in handlePostStrengthWorkout", {
      err: err.message,
      stack: err.stack,
    });
    return sendJsonResponse(
      { error: "Failed to ingest workout", message: err.message },
      500
    );
  }
}

/** Ensure strength sheets exist with headers; create if missing. */
function ensureStrengthSheetsExist_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let w = spreadsheet.getSheetByName(SHEET_STRENGTH_WORKOUTS);
  let s = spreadsheet.getSheetByName(SHEET_STRENGTH_SETS);
  if (!w || !s) {
    setupStrengthSheets();
    return;
  }
  // Ensure headers present
  if (w.getLastRow() === 0) {
    w.getRange(1, 1, 1, STRENGTH_WORKOUTS_HEADERS.length).setValues([
      STRENGTH_WORKOUTS_HEADERS,
    ]);
  }
  if (s.getLastRow() === 0) {
    s.getRange(1, 1, 1, STRENGTH_SETS_HEADERS.length).setValues([
      STRENGTH_SETS_HEADERS,
    ]);
  }
}

/** Create or update a single Strength Workouts row by ID. */
function saveStrengthWorkout_(d, rawJson) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sh = spreadsheet.getSheetByName(SHEET_STRENGTH_WORKOUTS);
  const headers = STRENGTH_WORKOUTS_HEADERS;
  const idx = getStrengthWorkoutsHeaderIndexMap();

  // Find existing row with matching ID
  const all = sh.getDataRange().getValues();
  const headerRow = all.shift();
  const idCol = headerRow.indexOf("ID");
  let rowNum = -1;
  for (let i = 0; i < all.length; i++) {
    if (String(all[i][idCol]) === String(d.id)) {
      rowNum = i + 2; // account for header
      break;
    }
  }

  const status = rowNum === -1 ? "created" : "updated";
  if (rowNum === -1) {
    rowNum = sh.getLastRow() + 1;
  }

  // Date from EndTimestamp
  const dateStr = d.endTimestamp
    ? Utilities.formatDate(
      new Date(d.endTimestamp * 1000),
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    )
    : "";

  const row = new Array(headers.length).fill("");
  row[idx["ID"] - 1] = d.id;
  row[idx["TemplateID"] - 1] = valOr_(d.templateId);
  row[idx["TemplateName"] - 1] = valOr_(d.templateName);
  row[idx["Name"] - 1] = valOr_(d.templateName);
  row[idx["CreateTime"] - 1] = valOr_(d.createTime);
  row[idx["StartTimestamp"] - 1] = valOr_(d.startTimestamp);
  row[idx["EndTimestamp"] - 1] = valOr_(d.endTimestamp);
  row[idx["Date"] - 1] = dateStr;
  row[idx["TrainingTime"] - 1] = valOr_(d.trainingTime);
  row[idx["Calories"] - 1] = valOr_(d.calorie);
  row[idx["TotalCapacity"] - 1] = valOr_(d.totalCapacity);
  row[idx["MaxWeight"] - 1] = valOr_(d.maxWeight);
  row[idx["AvgWeight"] - 1] = valOr_(d.avgWeight);
  row[idx["TrainingCount"] - 1] = valOr_(d.trainingCount);
  row[idx["FinishActionCount"] - 1] = valOr_(d.finishActionCount);
  row[idx["ActionTotalCount"] - 1] = valOr_(d.actionTotalCount);
  row[idx["NewCalorieRecord"] - 1] = valOr_(d.isNewCalorieRecord);
  row[idx["NewTotalCapacityRecord"] - 1] = valOr_(d.isNewTotalCapacityRecord);
  row[idx["NewMaxWeightRecord"] - 1] = valOr_(d.isNewMaxWeightRecord);
  row[idx["NewAvgWeightRecord"] - 1] = valOr_(d.isNewAvgWeightRecord);
  row[idx["UUID"] - 1] = valOr_(d.uuid);
  row[idx["Code"] - 1] = valOr_(d.code);
  row[idx["DeviceType"] - 1] = valOr_(d.deviceType);
  row[idx["DataVersion"] - 1] = valOr_(d.dataVersion);
  row[idx["WatchType"] - 1] = valOr_(d.watchType);
  row[idx["CreateUserId"] - 1] = valOr_(d.createUserId);
  row[idx["CoverImg"] - 1] = valOr_(d.coverImg);
  row[idx["NowTrainingTime"] - 1] = valOr_(d.nowTrainingTime);
  row[idx["NowCalorie"] - 1] = valOr_(d.nowCalorie);
  row[idx["NowTotalCapacity"] - 1] = valOr_(d.nowTotalCapacity);
  row[idx["JSON"] - 1] = rawJson;

  sh.getRange(rowNum, 1, 1, headers.length).setValues([row]);
  return { status, rowNum };
}

/** Replace all Strength Sets rows for a workout with performed sets from payload. */
function replaceStrengthSets_(d) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sh = spreadsheet.getSheetByName(SHEET_STRENGTH_SETS);
  const headers = STRENGTH_SETS_HEADERS;
  const idx = getStrengthSetsHeaderIndexMap();

  // Delete existing rows for this WorkoutID (bottom-up)
  const all = sh.getDataRange().getValues();
  const header = all.shift();
  const workoutIdCol = header.indexOf("WorkoutID");
  for (let r = sh.getLastRow(); r >= 2; r--) {
    const val = sh.getRange(r, workoutIdCol + 1).getValue();
    if (String(val) === String(d.id)) {
      sh.deleteRow(r);
    }
  }

  const exercises = Array.isArray(d.cttActionLibraryTrainingInfoList)
    ? d.cttActionLibraryTrainingInfoList
    : [];
  let inserted = 0;
  let exercisesCount = 0;

  const rows = [];
  exercises.forEach((ex) => {
    const sets = Array.isArray(ex.finishedReps) ? ex.finishedReps : [];
    // If no performed signal across exercise or any set, skip entirely
    if (!isPerformedExercise_(ex)) return;
    exercisesCount++;
    sets.forEach((set) => {
      if (!isPerformedSet_(set)) return;
      const row = new Array(headers.length).fill("");
      row[idx["WorkoutID"] - 1] = d.id;
      row[idx["ExerciseInstanceID"] - 1] = valOr_(ex.id);
      row[idx["ActionLibraryId"] - 1] = valOr_(ex.actionLibraryId);
      row[idx["ExerciseName"] - 1] = valOr_(ex.actionLibraryName);
      row[idx["SetIndex"] - 1] = valOr_(set.ix);
      row[idx["LeftRight"] - 1] = valOr_(set.leftRight, 0);
      row[idx["TargetCount"] - 1] = valOr_(set.targetCount);
      row[idx["FinishedCount"] - 1] = valOr_(set.finishedCount);
      row[idx["Time"] - 1] = valOr_(set.time);
      row[idx["Capacity"] - 1] = valOr_(set.capacity);
      row[idx["AvgWeight"] - 1] = valOr_(set.avgWeight);
      row[idx["MaxWeight"] - 1] = valOr_(ex.maxWeight);
      row[idx["MinWeight"] - 1] = valOr_(ex.minWeight);
      row[idx["WeightDetail"] - 1] = valOr_(set.weightDetail);
      row[idx["StartTime"] - 1] = valOr_(ex.startTime);
      row[idx["EndTime"] - 1] = valOr_(ex.endTime);
      row[idx["startTimestamp"] - 1] = valOr_(ex.startTimestamp);
      row[idx["endTimestamp"] - 1] = valOr_(ex.endTimestamp);
      row[idx["Calorie"] - 1] = valOr_(ex.calorie);
      row[idx["TotalCapacity"] - 1] = valOr_(ex.totalCapacity);
      row[idx["TrainingPartId2"] - 1] = valOr_(ex.trainingPartId2);
      row[idx["CategoryId"] - 1] = valOr_(ex.categoryId);
      row[idx["Img"] - 1] = valOr_(ex.img);
      row[idx["CompletionMethod"] - 1] = valOr_(ex.completionMethod);
      row[idx["SelectCompletionMethod"] - 1] = valOr_(
        set.selectCompletionMethod
      );
      row[idx["FinishGroupCount"] - 1] = valOr_(ex.finishGroupCount);
      row[idx["IsFinish"] - 1] = set.isFinish ? 1 : 0;
      rows.push(row);
    });
  });

  if (rows.length) {
    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
    inserted = rows.length;
  }
  return { inserted, exercises: exercisesCount };
}

function isPerformedSet_(set) {
  if (!set) return false;
  if (set.isFinish === true) return true;
  if (toNum_(set.time) > 0) return true;
  if (toNum_(set.finishedCount) > 0) return true;
  if (toNum_(set.capacity) > 0) return true;
  if (set.weightDetail && String(set.weightDetail).length > 0) return true;
  return false;
}

function isPerformedExercise_(ex) {
  if (!ex) return false;
  if (toNum_(ex.isFinish) === 1) return true;
  if (toNum_(ex.trainingTime) > 0) return true;
  if (toNum_(ex.calorie) > 0) return true;
  const reps = Array.isArray(ex.finishedReps) ? ex.finishedReps : [];
  return reps.some(isPerformedSet_);
}

function toNum_(v) {
  return v ? Number(v) : 0;
}
function valOr_(v, def) {
  return v === undefined || v === null ? (def !== undefined ? def : "") : v;
}

/**
 * GET: /strength/workouts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns compact workout summaries.
 */
function handleGetStrengthWorkouts(e) {
  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_STRENGTH_WORKOUTS);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));

  const start = e.parameter.startDate || e.parameter.start_date;
  const end = e.parameter.endDate || e.parameter.end_date;

  const items = data
    .filter((row) => row[idx['ID']] !== '')
    .map((row) => ({
      ID: row[idx['ID']],
      Date: row[idx['Date']],
      TemplateName: row[idx['TemplateName']],
      TrainingTime: row[idx['TrainingTime']],
      Calories: row[idx['Calories']],
      TotalCapacity: row[idx['TotalCapacity']],
      MaxWeight: row[idx['MaxWeight']],
      AvgWeight: row[idx['AvgWeight']],
      FinishActionCount: row[idx['FinishActionCount']],
      EndTimestamp: row[idx['EndTimestamp']],
    }))
    .filter((w) => {
      if (!start && !end) return true;
      const d = String(w.Date);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    })
    .sort((a, b) => String(a.Date).localeCompare(String(b.Date)));

  return sendJsonResponse(items);
}

/** GET: /strength/exercises - distinct exercises across sets */
function handleGetStrengthExercises() {
  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_STRENGTH_SETS);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  const seen = {};
  const out = [];
  data.forEach((row) => {
    const id = row[idx['ActionLibraryId']];
    if (!id) return;
    if (seen[id]) return;
    seen[id] = true;
    out.push({
      ActionLibraryId: id,
      ExerciseName: row[idx['ExerciseName']],
      TrainingPartId2: row[idx['TrainingPartId2']],
      CategoryId: row[idx['CategoryId']],
      Img: row[idx['Img']],
    });
  });
  return sendJsonResponse(out);
}

/** GET: /strength/workout?id=NNN - returns workout row and its sets */
function handleGetStrengthWorkout(e) {
  const id = e.parameter.id;
  if (!id) return sendJsonResponse({ error: 'Missing id' }, 400);
  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shW = ss.getSheetByName(SHEET_STRENGTH_WORKOUTS);
  const shS = ss.getSheetByName(SHEET_STRENGTH_SETS);

  const wData = shW.getDataRange().getValues();
  const wHeaders = wData.shift();
  const wIdx = {};
  wHeaders.forEach((h, i) => wIdx[h] = i);
  const workoutRow = wData.find(r => String(r[wIdx['ID']]) === String(id));
  if (!workoutRow) return sendJsonResponse({ error: 'Not found', id }, 404);
  const workout = {};
  wHeaders.forEach((h, i) => workout[h] = workoutRow[i]);

  const sData = shS.getDataRange().getValues();
  const sHeaders = sData.shift();
  const sIdx = {};
  sHeaders.forEach((h, i) => sIdx[h] = i);
  const sets = sData
    .filter(r => String(r[sIdx['WorkoutID']]) === String(id))
    .sort((a, b) => {
      const exA = a[sIdx['ExerciseInstanceID']] || 0;
      const exB = b[sIdx['ExerciseInstanceID']] || 0;
      if (exA !== exB) return exA - exB;
      return (a[sIdx['SetIndex']] || 0) - (b[sIdx['SetIndex']] || 0);
    })
    .map(r => {
      const obj = {};
      sHeaders.forEach((h, i) => obj[h] = r[i]);
      return obj;
    });

  return sendJsonResponse({ workout, sets });
}

/** GET: /strength/today - workouts within last 24h */
function handleGetStrengthToday() {
  ensureStrengthSheetsExist_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_STRENGTH_WORKOUTS);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 24 * 60 * 60;
  const items = data
    .filter(row => row[idx['ID']] !== '')
    .filter(row => Number(row[idx['EndTimestamp']]) >= cutoff)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      return obj;
    });
  return sendJsonResponse(items);
}

/** GET: /strength/exerciseData?exerciseId=...&exerciseName=... */
function handleGetStrengthExerciseData(e) {
  ensureStrengthSheetsExist_();
  const exId = e.parameter.exerciseId;
  const exName = e.parameter.exerciseName;
  if (!exId && !exName) return sendJsonResponse({ error: 'Provide exerciseId or exerciseName' }, 400);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_STRENGTH_SETS);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);
  const rows = data.filter(r => {
    if (exId && String(r[idx['ActionLibraryId']]) === String(exId)) return true;
    if (exName && String(r[idx['ExerciseName']]) === String(exName)) return true;
    return false;
  }).sort((a, b) => Number(a[idx['endTimestamp']]) - Number(b[idx['endTimestamp']]));
  const out = rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
  return sendJsonResponse(out);
}



// New end points for getting exercises... note that we have computed columns added to our 
// workout sets that help with analysis.

// Those columns look like this...
// 
/* Main Focus	Movement Type	Quads	Hams	Glutes	Chest	Back	Shoulders	Arms	Core	Calves
Quads	 Squat (bilateral)	1	0	1	0	0	0	0	0	0
Quads	 Squat (bilateral)	1	0	1	0	0	0	0	0	0
Quads	 Squat (bilateral)	1	0	1	0	0	0	0	0	0
*/
// They are computed by an internal function with this prompt:
/* =split(gemini("Generate a comma-separated list with the following fields:
Main Focus, Movement Type, Quads, Hamstrings, Glutes, Chest, Back, Shoulders, Arms, Core, Calves.
        •        Main Focus must always be one of: Quads, Hamstrings, Glutes, Chest, Back, Shoulders, Arms, Core, Calves.
        •        Movement Type must always be one of: Squat (bilateral), Squat (unilateral), Hinge, Push (horizontal), Push (vertical), Pull (horizontal), Pull (vertical), Core (flexion), Core (extension), Core (rotation), Core (anti-rotation), Core (isometric), Isolation, Mobility, Stretch.
        •        The muscle flags (Quads…Calves) are 1 if the exercise primarily trains that group, 0 otherwise.
        •        Do not mark stabilizers unless they are major contributors (e.g. Squat = Quads=1, Glutes=1; not every box). i.e. Do not mark 'core' for squats or else we'll end up tagging every exercise as a core exercise
        •        Isolation lifts should only flag a single muscle group.
        •        Mobility and Stretch should flag 0 for all muscle groups.",A2),",")
*/
