# Speediance API → MCP Handoff Notes

This document consolidates practical API knowledge gathered from this codebase and live probing (March 2026), so another agent can implement an MCP server around Speediance workouts.

---

## 1) Quick Context

- **Primary app API hosts**:
  - Global: `https://api2.speediance.com`
  - EU: `https://euapi.speediance.com`
- Region selection in existing code is based on config/env (`Global` vs `EU`).
- The app behaves like a mobile client, not a browser-only API consumer.

---

## 2) Authentication Flow (Working)

### 2.1 Verify account identity

- **POST** `/api/app/v2/login/verifyIdentity`
- Body:
  ```json
  {
    "type": 2,
    "userIdentity": "user@example.com"
  }
  ```
- Used to check `isExist` and `hasPwd` before password login.

### 2.2 Password login

- **POST** `/api/app/v2/login/byPass`
- Body:
  ```json
  {
    "userIdentity": "user@example.com",
    "password": "...",
    "type": 2
  }
  ```
- Successful response contains:
  - `data.token`
  - `data.appUserId`

### 2.3 Authenticated request headers

Most authenticated calls require these headers:

- `App_user_id`: `<appUserId>`
- `Token`: `<token>`
- `Timestamp`: current epoch ms string
- `Versioncode`: `40304`
- `Mobiledevices`: `{"brand":"google","device":"emulator64_x86_64_arm64","deviceType":"sdk_gphone64_x86_64","os":"","os_version":"31","manufacturer":"Google"}`
- `Content-Type`: `application/json`
- `User-Agent`: `Dart/3.9 (dart:io)`
- `Host`: `api2.speediance.com` or `euapi.speediance.com`

### 2.4 Optional logout

- **POST** `/api/app/login/logout`

---

## 3) Device Type Semantics

These values are critical and appear in multiple endpoints/payloads:

- `deviceType: 1` = Gym Monster (GM)
- `deviceType: 2` = Gym Pal (GP)

Where used:

- Save workout payload (`deviceType`)
- Workout list query (`deviceTypes`)
- Calendar query (`selectedDeviceType`)
- Schedule payload (`deviceType`)

---

## 4) Key Endpoints for MCP

## 4.1 Exercise library

- **GET** `/api/app/actionLibraryTab/list?deviceType={1|2}`
  - Returns categories/tabs.

- **GET** `/api/app/actionLibraryGroup/trainingPartGroup?tabId={tabId}&deviceTypeList={1|2}`
  - Returns groups/exercises by category.

- **GET** `/api/app/actionLibraryGroup/{groupId}?isDisplay=1`
  - Exercise detail + action variants.

- **GET** `/api/app/actionLibraryGroup/list?ids={id1}&ids={id2}...`
  - Batch detail for multiple group IDs.

- **GET** `/api/app/accessories/list`
  - Accessory ID -> accessory name mapping.

## 4.2 Custom workouts / templates

- **GET** `/api/app/v4/customTrainingTemplate/appPage?pageNo=1&pageSize=-1&deviceTypes={1|2}`
  - List custom templates for a device type.

- **GET** `/api/app/v3/customTrainingTemplate/detailByCode?code={templateCode}`
  - Full template detail (includes `actionLibraryList`).

- **POST** `/api/app/v2/customTrainingTemplate`
  - Create/update template.

- **DELETE** `/api/app/customTrainingTemplate?ids={templateId}`
  - Delete template.

## 4.3 Scheduling / calendar

- **GET** `/api/app/v5/trainingCalendar/monthNew?date=YYYY-MM&selectedDeviceType={1|2}`
- **POST** `/api/app/templateReservation`
  - Body:
    ```json
    {
      "status": 1,
      "deviceType": 2,
      "thatDay": "2026-03-18",
      "templateCode": "..."
    }
    ```

## 4.4 History / reports

- **GET** `/api/mobile/v2/report/userTrainingDataRecord?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- **GET** `/api/mobile/v2/report/userTrainingDataStat?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- **GET** `/api/app/cttTrainingInfo/{trainingId}`
- **GET** `/api/app/trainingInfo/cttTrainingInfo/{trainingId}`
- **GET** `/api/app/trainingInfo/cttTrainingInfoDetail/{trainingId}`

---

## 5) Save Workout Payload (Important)

A working payload shape:

```json
{
  "name": "My Workout",
  "actionLibraryList": [
    {
      "groupId": 1464,
      "actionLibraryId": 714,
      "templatePresetId": -1,
      "setsAndReps": "10,10",
      "breakTime": "45,45",
      "breakTime2": "45,45",
      "sportMode": "1,1",
      "leftRight": "0,0",
      "selectCompletionMethod": "1,1",
      "completionMethod": "1,1",
      "countType": "1,1",
      "weights": "55,55",
      "counterweight2": "",
      "counterweight": "",
      "level": "0,0",
      "capacity": 1100
    }
  ],
  "totalCapacity": 1100,
  "deviceType": 2,
  "bgColor": 0
}
```

### Notes from legacy implementation

- For `templatePresetId == -1` (custom):
  - Legacy code converts entered weight with `* 2.2` before writing `weights`.
- For RM/preset mode (`templatePresetId != -1`):
  - `counterweight2` carries RM values (e.g., `"13,13"`).
  - Legacy sends dummy `weights` values and also sends both `counterweight2` + `counterweight`.
- `breakTime` and `breakTime2` are both sent.
- `actionLibraryId` should come from detail variant list, not assumed from `groupId`.

---

## 6) Response Handling Notes

- API often wraps payload in `{ code, message, data }`.
- Success is usually `code = 0`.
- Observed app-level codes:
  - `code = 0` success
  - `code = 20` not found (seen on some training detail fetches)
  - `code = 90` offline (observed when attempting GM template create from tested account/session)
  - `code = 91` unauthorized (handled in legacy wrapper)

---

## 7) Live Probe Findings (March 2026)

### Confirmed working

- GP (`deviceType = 2`) template create/list/detail/delete works.
- GP RM-style template save works (`templatePresetId = 1` and `counterweight2` present).
- GP workouts with obvious barbell movements persisted and read back correctly:
  - Barbell Biceps Curl
  - Barbell Bench Press
  - Barbell Back Squat

### Not confirmed / constrained

- GM (`deviceType = 1`) template create returned `code: 90` / `offline` in this environment.
- In this account’s fetched library snapshot, GM and GP `groupId` sets were fully overlapping (`1024` each, all shared), so proving an old “GM movement inside GP” hack requires deeper variant-level targeting.

### Practical implication

- At least for GP templates, data corruption is **not** consistently reproducible through save/readback in current tests.

---

## 8) Suggested MCP Tool Surface

A minimal useful MCP server can expose:

1. `speediance.login`
   - input: `email`, `password`, `region`
   - output: short-lived session handle (never expose token in logs)

2. `speediance.listLibrary`
   - input: `deviceType`, optional filters
   - output: category + exercise list

3. `speediance.getExerciseDetail`
   - input: `groupId`
   - output: detail + action variants

4. `speediance.listWorkouts`
   - input: `deviceType`
   - output: templates

5. `speediance.getWorkout`
   - input: `templateCode`
   - output: full template detail

6. `speediance.saveWorkout`
   - input: canonical workout model
   - output: created/updated template metadata

7. `speediance.deleteWorkout`
   - input: `templateId`

8. `speediance.scheduleWorkout`
   - input: `deviceType`, `date`, `templateCode`, `status`

9. `speediance.getCalendar`
   - input: `deviceType`, `month`

10. `speediance.getTrainingRecords`
    - input: date range

---

## 9) Canonical Internal Workout Model (for MCP)

Use a model independent of API CSV fields, then compile to API payload:

```json
{
  "name": "curl press squat GP",
  "deviceType": 2,
  "exercises": [
    {
      "groupId": 1366,
      "actionLibraryId": 725,
      "templatePresetId": -1,
      "sets": [
        { "reps": 10, "weight": 20, "rest": 45, "mode": 1, "unit": "reps" },
        { "reps": 10, "weight": 20, "rest": 45, "mode": 1, "unit": "reps" }
      ]
    }
  ]
}
```

Then compile to API strings:

- `setsAndReps = "10,10"`
- `weights = "..."`
- `breakTime = "45,45"`
- etc.

---

## 10) Security / Operational Guidance

- Do **not** hardcode credentials in code or repo.
- Read credentials from secure env/secret storage.
- Never log raw `Token`/password.
- Consider account lockouts/rate limits; add retry/backoff.
- Add a dry-run mode for create/update/delete tools.

---

## 11) Known Unknowns / Follow-up Work

1. Why GM create currently returns `code 90` (`offline`) in this environment.
2. Whether GM-vs-GP variant divergence still exists per movement at scale.
3. Whether mobile app transforms or remaps template actions post-save in edge cases.
4. Exact weight unit semantics for all device/preset combinations (legacy uses `* 2.2` conversion logic).

---

## 12) Suggested Handoff Prompt for Claude Code

Use this in your other project:

> Build an MCP server for Speediance using the attached API handoff markdown. Implement tools for login, library listing, exercise detail, workout list/detail/create/update/delete, schedule, calendar, and training records. Use a canonical internal workout model and compile to Speediance payload format. Include robust error handling for Speediance app-level codes (0/20/90/91). Do not log tokens or credentials. Add integration tests with mock responses and optional live smoke-test commands gated by env vars.

---

If needed, copy this file as-is into the new project and let Claude scaffold the MCP around it.
