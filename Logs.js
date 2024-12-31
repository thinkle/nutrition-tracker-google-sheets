
/*******************
 * DATA OPERATIONS
 *******************/

/**
 * Read all logs into objects keyed by column header.
 */
function readLogs(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift(); // remove headers
  return data.filter(row => row[0]) // row[0] = ID, ensure not empty
    .map(row => {
      const obj = {};
      headers.forEach((h,i) => { obj[h] = row[i]; });
      return obj;
    });
}

/**
 * Read summaries into objects keyed by column header.
 */
function readSummaries(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return data.filter(row => row[0]) // row[0] = Date
    .map(row => {
      const obj = {};
      headers.forEach((h,i) => { obj[h] = row[i]; });
      return obj;
    });
}

/**
 * Create a new log with a unique ID.
 */
function createLog(sheet, data) {
  const headers = sheet.getDataRange().getValues()[0];
  const lastRow = sheet.getLastRow();
  const nextRow = lastRow + 1;
  const newId = Utilities.getUuid();

  // Build row in correct order
  const rowData = headers.map(h => {
    if (h === 'ID') return newId;
    return data[h] !== undefined ? data[h] : '';
  });

  sheet.getRange(nextRow, 1, 1, rowData.length).setValues([rowData]);
  return newId;
}

/**
 * Update a log row by ID.
 */
function updateLog(sheet, id, data) {
  const allData = sheet.getDataRange().getValues();
  const headers = allData.shift();
  const idIndex = headers.indexOf('ID');

  for (var i = 0; i < allData.length; i++) {
    if (allData[i][idIndex] === id) {
      const rowNum = i+2;
      headers.forEach((h, idx) => {
        if (h === 'ID') return; // don't overwrite ID
        if (data[h] !== undefined) {
          sheet.getRange(rowNum, idx+1).setValue(data[h]);
        }
      });
      return true;
    }
  }
  return false;
}

/**
 * Delete a log row by ID.
 */
function deleteLog(sheet, id) {
  const allData = sheet.getDataRange().getValues();
  const headers = allData.shift();
  const idIndex = headers.indexOf('ID');

  for (var i = 0; i < allData.length; i++) {
    if (allData[i][idIndex] === id) {
      const rowNum = i+2;
      sheet.deleteRow(rowNum);
      return true;
    }
  }
  return false;
}