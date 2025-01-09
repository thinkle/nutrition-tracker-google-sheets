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

/************************************************
 * Helper function to log requests to a "Requests" sheet
 ************************************************/
function logRequestSheet(e, method, status, errMessage) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let requestSheet = ss.getSheetByName('Requests');
  if (!requestSheet) {
    requestSheet = ss.insertSheet('Requests');
    requestSheet.appendRow(['Timestamp', 'Method', 'Path', 'Parameters', 'ErrorMessage', 'Status']);
  }

  requestSheet.appendRow([
    new Date().toISOString(),
    method,
    e.parameter.path || '(no path)',
    JSON.stringify(e.parameter),
    errMessage || '',
    status
  ]);
}

/************************************************
 * Wrapper function that logs requests before/after
 ************************************************/
function withRequestLogging(e, method, internalFn) {
  try {
    const response = internalFn(e);
    // If the response includes an error, mark status accordingly
    if (response && response.getContent()) {
      const body = JSON.parse(response.getContent());
      if (body.error) {
        logRequestSheet(e, method, 'Failed', body.error);
      } else {
        logRequestSheet(e, method, 'Success');
      }
    } else {
      logRequestSheet(e, method, 'Success');
    }
    return response;
  } catch (err) {
    logRequestSheet(e, method, 'Exception', err.message);
    throw err; // re-throw to preserve existing error handling
  }
}

/************************************************
 * Original doGet/doPost renamed to internal 
 ************************************************/
function internalDoGet(e) {
  console.log('internalDoGet called with: ' + JSON.stringify(e.parameter));

  let path = e.parameter.path || '';
  if (!path) {
    return sendJsonResponse(getOpenApiSpec());
  }
  if (path[0] === '/') {
    path = path.substr(1);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (path === 'summaries') {
      return handleGetSummaries(ss);
    } else if (path === 'logs' || path === 'log') {
      return handleGetLogs(e, ss);
    } else if (path === 'metrics') {
      return handleGetMetrics(e, ss);
    } else if (path === 'goals') {
      return handleGetGoals(ss);
    } else if (path === 'goals/history') {
      return handleGetGoalHistory(ss);
    } 
  } catch (error) {
    const errorDetails = {
      parameters: e.parameter,
      error: error.message,
      stack: error.stack
    };
    logError('Error in internalDoGet', errorDetails);
    return sendJsonResponse({ error: 'Internal server error', details: errorDetails }, 500);
  }

  logError('Error in internalDoGet', { parameters: e.parameter, error: 'Unknown endpoint' });
  return sendJsonResponse({ error: 'Unknown endpoint', parameter: e.parameter, path }, 404);
}

function internalDoPost(e) {
  console.log('internalDoPost called with: ' + JSON.stringify(e.parameter));

  let path = e.parameter.path || '';
  if (path[0] === '/') {
    path = path.substr(1);
  }
  const method = e.parameter.method || 'POST';

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    if (path === 'log' || path === 'logs') {
      return handleLogRequest(e, ss, method);
    } else if (path === 'metrics') {
      return handlePostMetrics(e, ss);
    } else if (path === 'goals') {
      return handlePostGoals(e, ss);
    }
  } catch (error) {
    const errorDetails = {
      parameters: e.parameter,
      error: error.message,
      stack: error.stack
    };
    logError('Error in internalDoPost', errorDetails);
    return sendJsonResponse({ error: 'Internal server error', details: errorDetails }, 500);
  }

  logError('Error in internalDoPost', { parameters: e.parameter, error: 'Unknown endpoint' });
  return sendJsonResponse({ error: 'Unknown endpoint', parameter: e.parameter, path }, 404);
}

/************************************************
 * Public doGet/doPost calls the wrapper
 ************************************************/
function doGet(e) {
  return withRequestLogging(e, 'GET', internalDoGet);
}

function doPost(e) {
  // If method is PUT/DELETE, we’re still receiving it as a POST from Cloudflare
  const method = e.parameter.method || 'POST';
  return withRequestLogging(e, method, internalDoPost);
}

function handleLogRequest(e, ss, method) {
  const logSheet = ss.getSheetByName('Log');
  const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};

  // Check if `data` is an array
  if (data.items && Array.isArray(data.items)) {
    console.log('Processing batch data');
    const items = data.items;
    const results = items.map(entry => {
      return processLogEntry(logSheet, entry, method);
    });
    return sendJsonResponse({ results: results });
  }

  // Single entry handling (default behavior)
  return sendJsonResponse(processLogEntry(logSheet, data, method));
}

function processLogEntry(logSheet, entry, method) {
  if (method === 'POST') {
    const id = createLog(logSheet, entry);
    return { status: 'created', id: id };
  } else if (method === 'PUT') {
    if (!entry.ID) return { status: 'error', message: 'ID required for update' };
    const success = updateLog(logSheet, entry.ID, entry);
    return success ? { status: 'updated', id: entry.ID } : { status: 'error', message: 'Not found' };
  } else if (method === 'DELETE') {
    if (!entry.ID) return { status: 'error', message: 'ID required for delete' };
    const success = deleteLog(logSheet, entry.ID);
    return success ? { status: 'deleted', id: entry.ID } : { status: 'error', message: 'Not found' };
  }
  return { status: 'error', message: 'Unknown method' };
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