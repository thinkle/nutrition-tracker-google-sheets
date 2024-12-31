/*******************
 * LIFECYCLE
 *******************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrition Tools')
    .addItem('Setup Spreadsheet', 'setupSpreadsheet')
    .addItem('Setup Metrics Sheet', 'setupMetricsSheet')
    .addItem('Setup Goals Sheet', 'setupGoalsSheet')
    .addItem('Get API Info', 'showApiInfo')
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