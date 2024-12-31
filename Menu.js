
/*******************
 * LIFECYCLE
 *******************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nutrition Tools')
    .addItem('Setup Spreadsheet', 'setupSpreadsheet')
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