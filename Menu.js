/*******************
 * LIFECYCLE
 *******************/
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Nutrition Tools')
    .addItem('Setup Spreadsheet', 'setupSpreadsheet')
    .addItem('Setup Metrics Sheet', 'setupMetricsSheet')
    .addItem('Setup Goals Sheet', 'setupGoalsSheet')
    .addSeparator()
    .addItem('Setup Strength Sheets', 'setupStrengthSheets')
    .addSeparator()
    .addItem('Setup Activities Sheet', 'setupActivitiesSheet')
    .addItem('Setup Nutrition Settings Sheet', 'setupNutritionSettingsSheet')
    .addItem('Migrate Negative Log Rows to Activities', 'migrateNegativeLogRowsToActivitiesMenu')
    .addItem('Reconcile Strava Legacy Duplicates', 'reconcileStravaLegacyActivityDuplicatesMenu')
    .addItem('Reset Summary Formulas for Activities', 'resetSummaryFormulasForActivities')
    .addItem('Get API Info', 'showApiInfo')
    .addSeparator()
    .addSubMenu(
      ui.createMenu('Analysis')
        .addItem('Run Phase Analysis', 'runPhaseAnalysis')
        .addItem('Run Discount Sweep', 'runDiscountSweep')
        .addItem('Compute Target…', 'computeTarget')
    )
    .addToUi();
}

/*******************
 * MENU ACTIONS
 *******************/
function showApiInfo() {
  const token = getApiToken();
  const url = getDeployedWebAppUrl();
  SpreadsheetApp.getUi().alert('API Base URL: ' + url + '\nToken: ' + token);
}
