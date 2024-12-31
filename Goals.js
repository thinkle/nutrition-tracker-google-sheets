/*******************
 * GOALS OPERATIONS
 *******************/

/**
 * Read all goals into objects keyed by column header.
 */
function readGoals(sheet, startDate, endDate) {
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
 * Log a new goal.
 */
function logGoal(sheet, data) {
  const headers = sheet.getDataRange().getValues()[0];
  const lastRow = sheet.getLastRow();
  const nextRow = lastRow + 1;

  // Build row in correct order
  const rowData = headers.map(h => data[h] !== undefined ? data[h] : '');

  sheet.getRange(nextRow, 1, 1, rowData.length).setValues([rowData]);
  return true;
}

/**
 * Get the most recent goal for each category.
 */
function getCurrentGoals(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const goals = {};

  data.forEach(row => {
    const date = new Date(row[0]);
    headers.forEach((header, index) => {
      if (header !== 'Date' && row[index]) {
        if (!goals[header] || new Date(goals[header].dateSet) < date) {
          goals[header] = { type: header, value: row[index], dateSet: date };
        }
      }
    });
  });

  return Object.values(goals);
}

/**
 * Get the full history of goals.
 */
function getGoalHistory(sheet) {
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}