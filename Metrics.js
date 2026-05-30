/*******************
 * METRICS OPERATIONS
 *******************/

function testReadMetrics () {
  console.log("read metrics: ",readMetrics(SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Metrics")))
}

/**
 * Read all metrics into objects keyed by column header.
 */
function readMetrics(sheet, startDate, endDate) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  let result = data.filter(row => {
    const date = new Date(row[0]);
    return (!startDate || date >= new Date(startDate)) && (!endDate || date <= new Date(endDate));
  }).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  result.reverse();
  return result;
}

/**
 * Log a new metric.
 */
function logMetric(sheet, data) {
  const headers = sheet.getDataRange().getValues()[0];
  const lastRow = sheet.getLastRow();
  const nextRow = lastRow + 1;

  // Build row in correct order
  const rowData = headers.map(h => data[h] !== undefined ? data[h] : '');

  sheet.getRange(nextRow, 1, 1, rowData.length).setValues([rowData]);
  return true;
}

/**
 * Update an existing metric row for a date, or append one if absent.
 * Useful for correcting bad weight entries from agents.
 */
function upsertMetric(sheet, data) {
  if (!data.Date) return { status: 'error', message: 'Date required for metric upsert' };
  const allData = sheet.getDataRange().getValues();
  const headers = allData.shift();
  const dateIndex = headers.indexOf('Date');
  const targetDate = formatAsDateString(data.Date);
  let rowNum = -1;

  for (let i = 0; i < allData.length; i++) {
    if (formatAsDateString(allData[i][dateIndex]) === targetDate) {
      rowNum = i + 2;
    }
  }

  if (rowNum > 0) {
    headers.forEach((h, idx) => {
      if (data[h] !== undefined) {
        sheet.getRange(rowNum, idx + 1).setValue(data[h]);
      }
    });
    return { status: 'updated', Date: targetDate, row: rowNum };
  }

  const rowData = headers.map(h => data[h] !== undefined ? data[h] : '');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, rowData.length).setValues([rowData]);
  return { status: 'created', Date: targetDate, row: sheet.getLastRow() };
}

/**
 * Delete metric rows by Date, optionally narrowing by Weight.
 */
function deleteMetric(sheet, data) {
  if (!data.Date) return { status: 'error', message: 'Date required for metric delete' };
  const allData = sheet.getDataRange().getValues();
  const headers = allData.shift();
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);
  const targetDate = formatAsDateString(data.Date);
  const hasWeight = data.Weight !== undefined && data.Weight !== '';
  const targetWeight = hasWeight ? Number(data.Weight) : null;
  const rowsToDelete = [];

  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    if (formatAsDateString(row[idx.Date]) !== targetDate) continue;
    if (hasWeight && Number(row[idx.Weight]) !== targetWeight) continue;
    rowsToDelete.push(i + 2);
  }

  rowsToDelete.sort((a, b) => b - a).forEach(row => sheet.deleteRow(row));
  return { status: rowsToDelete.length ? 'deleted' : 'not_found', Date: targetDate, deleted: rowsToDelete.length };
}
