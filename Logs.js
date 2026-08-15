
/*******************
 * DATA OPERATIONS
 *******************/

/**
 * Read all logs into objects keyed by column header.
 */
function readLogs(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift(); // remove headers
  const result = data.filter(row => row[0]) // row[0] = ID, ensure not empty
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  result.reverse();
  return result;
}

/**
 * Read summaries into objects keyed by column header.
 */
function readSummaries(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const result = data.filter(row => row[0]) // row[0] = Date
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  result.reverse();
  return result;
}

/**
 * Create a new log with a unique ID.
 */
function createLog(sheet, data) {
  const headers = sheet.getDataRange().getValues()[0];
  const lastRow = sheet.getLastRow();
  const nextRow = lastRow + 1;
  const newId = Utilities.getUuid();

  // Default a missing/blank Date to today. A blank Date matches no day in the
  // Summary formulas, so such an entry would silently count toward nothing.
  if (data.Date === undefined || data.Date === null || String(data.Date).trim() === '') {
    data = Object.assign({}, data, { Date: formatAsDateString(new Date()) });
  }

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
      const rowNum = i + 2;
      headers.forEach((h, idx) => {
        if (h === 'ID') return; // don't overwrite ID
        if (data[h] !== undefined) {
          sheet.getRange(rowNum, idx + 1).setValue(data[h]);
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
      const rowNum = i + 2;
      sheet.deleteRow(rowNum);
      return true;
    }
  }
  return false;
}

/**
 * One-time cleanup: fill any existing Log rows that have a blank Date with
 * today's date, so they stop being excluded from every daily total.
 * NOTE: this assigns TODAY to those rows — appropriate for a recent stray
 * entry, but it will misdate a genuinely old blank row. Review results after.
 * Returns { filled, date }.
 */
function fillMissingLogDates() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Log');
  if (!sheet) return { filled: 0, error: 'No Log sheet' };
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const dateCol = headers.indexOf('Date');
  const idCol = headers.indexOf('ID');
  if (dateCol < 0) return { filled: 0, error: 'No Date column' };
  const today = formatAsDateString(new Date());
  let filled = 0;
  for (var i = 1; i < values.length; i++) {
    // Skip fully-empty rows; only touch real entries (have an ID or any content).
    const hasContent = values[i].some(function (c) { return c !== '' && c !== null; });
    if (!hasContent) continue;
    if (idCol >= 0 && String(values[i][idCol]).trim() === '') continue;
    const d = values[i][dateCol];
    if (d === '' || d === null || String(d).trim() === '') {
      sheet.getRange(i + 1, dateCol + 1).setValue(today);
      filled++;
    }
  }
  SpreadsheetApp.getActive().toast('Filled ' + filled + ' blank Log date(s) with ' + today, 'Log cleanup', 5);
  return { filled: filled, date: today };
}