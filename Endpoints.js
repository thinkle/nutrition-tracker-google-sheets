function logError(message, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let errorSheet = ss.getSheetByName('ErrorLog');
  if (!errorSheet) {
    errorSheet = ss.insertSheet('ErrorLog'); // Create sheet if it doesn't exist
    errorSheet.appendRow(['Timestamp', 'Message', 'Details']); // Add headers
  }
  errorSheet.appendRow([new Date().toISOString(), message, JSON.stringify(details)]);
}

function sendJsonResponse(obj, status = 200) {
  if (obj.error) {
    logError('Error', obj);
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  }

/*******************
 * WEB ENDPOINTS
 *******************/
function doGet(e) {
  console.log('doGet called with: ' + JSON.stringify(e.parameter));

  let path = e.parameter.path || '';

  // If no path, return the OpenAPI spec (no token required)
  if (!path) {
    return sendJsonResponse(getOpenApiSpec());
  }
  if (path[0] === '/') {
    path = path.substr(1);
  }

  // Check token for protected endpoints
  //if (!checkToken(e)) return sendJsonResponse({error: 'Invalid token'}, 403);

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (path === 'summaries') {
      // GET summaries
      return handleGetSummaries(ss);
    } else if (path === 'logs' || path === 'log') {
      // GET logs (optionally filter by id or date)
      return handleGetLogs(e, ss);
    } else if (path === 'metrics') {
      // GET metrics
      return handleGetMetrics(e, ss);
    } else if (path === 'goals') {
      // GET current goals
      return handleGetGoals(ss);
    } else if (path === 'goals/history') {
      // GET goal history
      return handleGetGoalHistory(ss);
    }
  } catch (error) {
    const errorDetails = {
      parameters: e.parameter,
      error: error.message,
      stack: error.stack
    };
    logError('Error in doGet', { parameters: e.parameter, error: error.message });
    return sendJsonResponse({ error: 'Internal server error',details:errorDetails }, 500);
  }

  logError('Error in doGet', { parameters: e.parameter, error: 'Unknown endpoint' });
  return sendJsonResponse({ error: 'Unknown endpoint', parameter: e.parameter, path }, 404);
}

function doPost(e) {
  console.log('doPost called with: ' + JSON.stringify(e.parameter));

  let path = e.parameter.path || '';
  if (path[0] === '/') {
    path = path.substr(1);
  }

  // Check token for protected endpoints
  //if (!checkToken(e)) return sendJsonResponse({error: 'Invalid token'}, 403);

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (path === 'log') {
      // POST log
      return handlePostLog(e, ss);
    } else if (path === 'logs') {
      // POST logs
      return handlePostLogs(e, ss);
    } else if (path === 'metrics') {
      // POST metrics
      return handlePostMetrics(e, ss);
    } else if (path === 'goals') {
      // POST goals
      return handlePostGoals(e, ss);
    }
  } catch (error) {
    logError('Error in doPost', { parameters: e.parameter, error: error.message });
    return sendJsonResponse({ error: 'Internal server error' }, 500);
  }

  logError('Error in doPost', { parameters: e.parameter, error: 'Unknown endpoint' });
  return sendJsonResponse({ error: 'Unknown endpoint', parameter: e.parameter, path }, 404);
}

function handlePostLog(e, ss) {
  const logSheet = ss.getSheetByName('Log');
  const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const newId = createLog(logSheet, data);
  return sendJsonResponse({ status: 'created', id: newId }, 201);
}

function handlePostLogs(e, ss) {
  const logSheet = ss.getSheetByName('Log');
  const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const ids = data.items.map(item => createLog(logSheet, item));
  return sendJsonResponse({ status: 'created', ids }, 201);
}

function handleGetLogs(e, ss) {
  const logSheet = ss.getSheetByName('Log');
  const id = e.parameter.id;
  const dateParam = e.parameter.date;
  const logs = readLogs(logSheet);

  if (id) {
    const log = logs.find(l => l.ID == id);
    return log ? sendJsonResponse(log) : sendJsonResponse({ error: 'Not found', id }, 404);
  } else if (dateParam) {
    console.log('Filtering logs for date: ', dateParam);
    console.log('Dates we have are: ', logs.map((l) => formatAsDateString(l.Date)));
    const filtered = logs.filter(l => formatAsDateString(l.Date) === dateParam);
    return sendJsonResponse(filtered);
  }
  return sendJsonResponse(logs);
}

function handleGetSummaries(ss) {
  const summarySheet = ss.getSheetByName('Summary');
  const summaries = readSummaries(summarySheet);
  return sendJsonResponse(summaries);
}

function handleGetMetrics(e, ss) {
  const metricsSheet = ss.getSheetByName('Metrics');
  const startDate = e.parameter.start_date;
  const endDate = e.parameter.end_date;
  const metrics = readMetrics(metricsSheet, startDate, endDate);
  return sendJsonResponse(metrics);
}

function handlePostMetrics(e, ss) {
  const metricsSheet = ss.getSheetByName('Metrics');
  const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const success = logMetric(metricsSheet, data);
  return sendJsonResponse({ status: success ? 'created' : 'error' });
}

function handleGetGoals(ss) {
  const goalsSheet = ss.getSheetByName('Goals');
  const currentGoals = getCurrentGoals(goalsSheet);
  return sendJsonResponse(currentGoals);
}

function handlePostGoals(e, ss) {
  const goalsSheet = ss.getSheetByName('Goals');
  const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  const success = logGoal(goalsSheet, data);
  return sendJsonResponse({ status: success ? 'created' : 'error' });
}

function handleGetGoalHistory(ss) {
  const goalsSheet = ss.getSheetByName('Goals');
  const goalHistory = getGoalHistory(goalsSheet);
  return sendJsonResponse(goalHistory);
}