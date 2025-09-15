🚀 Strength Tracking Integration TODOs

We will add strength training tracking with a convenience method for uploading a Speediance workout JSON, auto-parsing it, and logging to Google Sheets.

1. New Sheets

Create two new sheets in the Google Sheet backend (use these exact names):

• Strength Workouts
• Columns (final): - ID (Speediance data.id) [PK] - TemplateID - TemplateName - Name (alias of TemplateName unless we override) - CreateTime (string) - StartTimestamp (int) - EndTimestamp (int) - Date (derived from EndTimestamp; YYYY-MM-DD) - TrainingTime - Calories - TotalCapacity - MaxWeight - AvgWeight - TrainingCount - FinishActionCount - ActionTotalCount - NewCalorieRecord (0/1) - NewTotalCapacityRecord (0/1) - NewMaxWeightRecord (0/1) - NewAvgWeightRecord (0/1) - UUID - Code - DeviceType - DataVersion - WatchType - CreateUserId - CoverImg - NowTrainingTime (optional) - NowCalorie (optional) - NowTotalCapacity (optional) - JSON (full original, stringified)

• Strength Sets
• Each row is one finished set (from finishedReps) with exercise context denormalized for easy queries
• Columns (final): - WorkoutID (FK → Strength Workouts.ID) - ExerciseInstanceID (parent exercise id; actionLibraryTrainingInfo.id when present) - ActionLibraryId - ExerciseName - SetIndex (finishedReps.ix) - LeftRight (0/1/2) - TargetCount - FinishedCount - Time (seconds) - Capacity (float) - AvgWeight (int) - MaxWeight (from exercise) - MinWeight (from exercise) - WeightDetail (per-set; comma-separated) - StartTime (string) - EndTime (string) - startTimestamp (int) - endTimestamp (int) - Calorie (from exercise) - TotalCapacity (from exercise) - TrainingPartId2 (body part) - CategoryId - Img (URL) - CompletionMethod (exercise) - SelectCompletionMethod (set) - FinishGroupCount (exercise) - IsFinish (set 0/1)

Create convenience methods to create these sheets with the exact headers above, and helpers to upsert to Strength Workouts and append/replace to Strength Sets.

⸻

2. New Script File

Add a new file to the Apps Script project: StrengthTracking.gs.

⸻

3. GAS Endpoint: Ingest Workout JSON
   • Create POST endpoint: /logStrengthWorkout
   • Input: full Speediance workout JSON object (the wrapper with code/message/data is accepted; we use data)
   • Workflow:
   1. Extract workout-level metadata → upsert one row in Strength Workouts (ID = data.id).
   2. For each exercise in data.cttActionLibraryTrainingInfoList:
      - For each entry in finishedReps → append a row to Strength Sets.
      - Copy exercise-level attributes (times, max/min/avg weight, category, part, etc.) onto each set row.
   3. Store original JSON (string) in Strength Workouts.JSON.
      • Idempotency: if a workout with ID exists, update Strength Workouts and delete + re-insert all its Strength Sets.(consider comparing JSON first -- if unchanged don't bother re-inserting sets)
      • Units: if unit headers/fields are present from proxy, optionally store WeightUnit/LengthUnit at workout-level (future-proof).
      • Validation: reject payloads without data.id; tolerate missing finishedReps; default leftRight to 0 if absent. Ignore empty sets (Speediance will show exercises in the workout but not completed in the
      list, but we only care about exercises for which reps were done, as determined by isFinish = 1 OR trainingTime > 0 or weight > 0 or calorie > 0)

⸻

1. GAS Read Endpoints

Expose endpoints for querying the data:
• listWorkouts(startDate?, endDate?)

- Filter by Date using EndTimestamp-derived date; return a compact summary: ID, Date, TemplateName, TrainingTime, Calories, TotalCapacity, MaxWeight, AvgWeight, FinishActionCount.
  • listExercises()
- Distinct by ActionLibraryId; return ActionLibraryId, ExerciseName, TrainingPartId2, CategoryId, Img.
  • getWorkout(workoutId)
- Return one Strength Workouts row plus all Strength Sets for that WorkoutID, ordered by ExerciseInstanceID, then SetIndex.
  • getTodayWorkouts()
- Return workouts with EndTimestamp within the last 24h.
  • getExerciseData(exerciseName?, exerciseId?)
- Accept exerciseId (ActionLibraryId) to avoid name collisions; fallback to name. Return all matching sets sorted by EndTimestamp.

⸻

5. Edge Cases & Rules
   • Category handling: ingest ALL categories (0,1,2,3). Filtering to strength-only views happens in reporting/queries, not at ingest time.
   • Unilateral sets: respect LeftRight (1/2) and avoid double counting when aggregating both sides.
   • Zero times: finishedReps.time can be 0; still log the set.
   • Empty strings: WeightDetail may be empty; store as empty string.
   • Target vs finished mismatches: store both values; don’t infer.
   • Date derivation: Date column uses EndTimestamp in local timezone.

⸻

6. Implementation Notes
   • Add sheet-creation helpers and an idempotent upsert API for Strength Workouts and a replace-sets helper for Strength Sets.
   • Validate inputs and return structured errors (missing data.id, malformed arrays).
   • Add lightweight tests: ingest sample JSONs and verify row counts and key fields.
