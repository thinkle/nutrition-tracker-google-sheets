/*******************
 * SETUP
 *******************/
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ----- Create/Reset Log Sheet -----
  let logSheet = ss.getSheetByName('Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Log');
  }
  logSheet.clear();

  const logHeaders = [...FIXED_FIELDS, ...NUTRIENTS];
  logSheet.getRange(1, 1, 1, logHeaders.length).setValues([logHeaders]);

  // ----- Create/Reset Summary Sheet -----
  let summarySheet = ss.getSheetByName('Summary');
  if (!summarySheet) {
    summarySheet = ss.insertSheet('Summary');
  }
  summarySheet.clear();

  // Summary headers: 'Date' plus 'Total <nutrient>' for each nutrient
  const summaryHeaders = ['Date', ...NUTRIENTS.map(n => 'Total ' + n)];
  summarySheet.getRange(1, 1, 1, summaryHeaders.length).setValues([summaryHeaders]);

  // We assume 'Date' is always the second field in FIXED_FIELDS (ID, Date, ...)
  // Adjust if necessary. We rely on the position of 'Date' in the log sheet.
  // Find index of 'Date' in the log sheet:
  const dateColIndex = logHeaders.indexOf('Date') + 1; // 1-based index
  const dateColLetter = getColumnLetter(dateColIndex);

  // Put a UNIQUE function in the Summary sheet to list out the dates
  // We'll put it starting at A2
  summarySheet.getRange('A2').setFormula(`=UNIQUE(FILTER(Log!${dateColLetter}2:${dateColLetter}, LEN(Log!${dateColLetter}2:${dateColLetter})))`);

  // For each nutrient, create a SUMIF formula based on the date
  // Nutrient columns start after FIXED_FIELDS in the Log sheet.
  NUTRIENTS.forEach((nutrient, i) => {
    const nutrientIndex = logHeaders.indexOf(nutrient) + 1;
    const nutrientColLetter = getColumnLetter(nutrientIndex);

    // Summary sheet nutrient columns start at column 2 (B)
    // For the i-th nutrient in NUTRIENTS, the column in summary is i+2
    const summaryCol = i + 2; 
    const formula = `=IF(A2<>"",SUMIF(Log!$${dateColLetter}:$${dateColLetter},A2,Log!$${nutrientColLetter}:$${nutrientColLetter}),"")`;
    summarySheet.getRange(2, summaryCol).setFormula(formula);
  });

  SpreadsheetApp.getActive().toast('Setup complete!', 'Setup', 5);
}