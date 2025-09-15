/**
 * Strength Tracking: Sheet Names and Headers
 * Constants here mirror the finalized schema in Strength_INtegration_TODO.md.
 * Update headers in one place if the schema changes.
 */

// Sheet names
const SHEET_STRENGTH_WORKOUTS = 'Strength Workouts';
const SHEET_STRENGTH_SETS = 'Strength Sets';

// Column headers for Strength Workouts
const STRENGTH_WORKOUTS_HEADERS = [
  'ID',
  'TemplateID',
  'TemplateName',
  'Name',
  'CreateTime',
  'StartTimestamp',
  'EndTimestamp',
  'Date',
  'TrainingTime',
  'Calories',
  'TotalCapacity',
  'MaxWeight',
  'AvgWeight',
  'TrainingCount',
  'FinishActionCount',
  'ActionTotalCount',
  'NewCalorieRecord',
  'NewTotalCapacityRecord',
  'NewMaxWeightRecord',
  'NewAvgWeightRecord',
  'UUID',
  'Code',
  'DeviceType',
  'DataVersion',
  'WatchType',
  'CreateUserId',
  'CoverImg',
  'NowTrainingTime',
  'NowCalorie',
  'NowTotalCapacity',
  'JSON'
];

// Column headers for Strength Sets (each row is one finished set)
const STRENGTH_SETS_HEADERS = [
  'WorkoutID',
  'ExerciseInstanceID',
  'ActionLibraryId',
  'ExerciseName',
  'SetIndex',
  'LeftRight',
  'TargetCount',
  'FinishedCount',
  'Time',
  'Capacity',
  'AvgWeight',
  'MaxWeight',
  'MinWeight',
  'WeightDetail',
  'StartTime',
  'EndTime',
  'startTimestamp',
  'endTimestamp',
  'Calorie',
  'TotalCapacity',
  'TrainingPartId2',
  'CategoryId',
  'Img',
  'CompletionMethod',
  'SelectCompletionMethod',
  'FinishGroupCount',
  'IsFinish'
];

/**
 * Create or get a sheet by name.
 */
function ensureSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/**
 * Create/reset the Strength Workouts sheet and write headers.
 */
function setupStrengthWorkoutsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_STRENGTH_WORKOUTS);
  sh.clear();
  sh.getRange(1, 1, 1, STRENGTH_WORKOUTS_HEADERS.length).setValues([STRENGTH_WORKOUTS_HEADERS]);
  sh.setFrozenRows(1);
}

/**
 * Create/reset the Strength Sets sheet and write headers.
 */
function setupStrengthSetsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ensureSheet_(ss, SHEET_STRENGTH_SETS);
  sh.clear();
  sh.getRange(1, 1, 1, STRENGTH_SETS_HEADERS.length).setValues([STRENGTH_SETS_HEADERS]);
  sh.setFrozenRows(1);
}

/**
 * Convenience function to set up both Strength sheets.
 */
function setupStrengthSheets() {
  setupStrengthWorkoutsSheet();
  setupStrengthSetsSheet();
  SpreadsheetApp.getActive().toast('Strength sheets ready', 'Strength Setup', 5);
}

/**
 * Optional helpers to access header indexes by name.
 */
function getStrengthWorkoutsHeaderIndexMap() {
  const map = {};
  STRENGTH_WORKOUTS_HEADERS.forEach((h, i) => { map[h] = i + 1; });
  return map; // 1-based indices
}

function getStrengthSetsHeaderIndexMap() {
  const map = {};
  STRENGTH_SETS_HEADERS.forEach((h, i) => { map[h] = i + 1; });
  return map; // 1-based indices
}

