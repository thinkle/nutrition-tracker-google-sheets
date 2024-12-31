
/*******************
 * UTILITY
 *******************/

/**
 * Convert 1-based column index to a column letter (1 -> A, 2 -> B, etc.)
 */
function getColumnLetter(colIndex) {
  let temp = '';
  let letter = '';
  while (colIndex > 0) {
    temp = (colIndex - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colIndex = (colIndex - temp - 1) / 26;
  }
  return letter;
}

/**
 * Send JSON response.
 */

function formatAsDateString(date) {
  // If it's already a string in the correct format, return as is
  if (typeof date === 'string' && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return date;
  }

  // Convert JavaScript Date object to yyyy-MM-dd string
  const dateObj = new Date(date);
  return Utilities.formatDate(dateObj, 'America/New_York', 'yyyy-MM-dd');
}