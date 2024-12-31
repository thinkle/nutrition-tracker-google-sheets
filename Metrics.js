/*******************
 * METRICS OPERATIONS
 *******************/

/**
 * Read all metrics into objects keyed by column header.
 */
function readMetrics(sheet, startDate, endDate) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return data.filter(row => {
    const date = new Date(row[0]);
    return (!startDate || date >= new Date(startDate)) && (!endDate || date <= new Date(endDate));
  }).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
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