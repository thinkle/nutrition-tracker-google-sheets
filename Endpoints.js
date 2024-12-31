function logError(message, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let errorSheet = ss.getSheetByName('ErrorLog');
  if (!errorSheet) {
    errorSheet = ss.insertSheet('ErrorLog'); // Create sheet if it doesn't exist
    errorSheet.appendRow(['Timestamp', 'Message', 'Details']); // Add headers
  }
  errorSheet.appendRow([new Date().toISOString(), message, JSON.stringify(details)]);
}


function sendJsonResponse(obj, status=200) {
  if (obj.error) {
    logError('Error',obj);
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
  if (path[0]==='/') {
    path = path.substr(1);
  }
  
  // Check token for protected endpoints
  //if (!checkToken(e)) return sendJsonResponse({error: 'Invalid token'}, 403);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('Log');
  const summarySheet = ss.getSheetByName('Summary');

  if (path === 'summaries') {
    // GET summaries
    const summaries = readSummaries(summarySheet);
    return sendJsonResponse(summaries);
  } else if (path === 'logs' || path === 'log') {
    // GET logs (optionally filter by id or date)
    const id = e.parameter.id;
    const dateParam = e.parameter.date;
    const logs = readLogs(logSheet);
    
    if (id) {
      const log = logs.find(l => l.ID == id);
      return log ? sendJsonResponse(log) : sendJsonResponse({error:'Not found',id},404);
    } else if (dateParam) {
      console.log('Filtering logs for date: ', dateParam);
      console.log('Dates we have are: ', logs.map((l) => formatAsDateString(l.Date)));

      const filtered = logs.filter(l => formatAsDateString(l.Date) === dateParam);
      return sendJsonResponse(filtered);
    }
    return sendJsonResponse(logs);
  }
  logError('Error in doGet', { parameters: e.parameter, error: 'Unknown endpoint' });
  return sendJsonResponse({error: 'Unknown endpoint', parameter: e.parameter,path}, 404);
}

function doPost(e) {
  console.log('doPost called with: ' + JSON.stringify(e.parameter));

  let path = e.parameter.path || '';
  if (path[0]==='/') {
    path = path.substr(1);
  }
  const method = e.parameter.method || 'POST'; // Could also rely solely on POST/PUT/DELETE logic

  //if (!checkToken(e)) return sendJsonResponse({error: 'Invalid token'}, 403);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('Log');


  if (path === 'logs'|| path === 'log') {
    const data = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};

    // Check if `data` is an array
    if (data.items && Array.isArray(data.items)) {
      console.log('Processing batch data');
      const items = data.items;
      const results = items.map(entry => {
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
      });
      return sendJsonResponse({ results: results });
    }

    // Single entry handling (default behavior)
    if (method === 'POST') {
      const id = createLog(logSheet, data);
      return sendJsonResponse({ status: 'created', id: id });
    } else if (method === 'PUT') {
      if (!data.ID) return sendJsonResponse({ error: 'ID required for update' }, 400);
      const success = updateLog(logSheet, data.ID, data);
      return success ? sendJsonResponse({ status: 'updated' }) : sendJsonResponse({ error: 'Not found' }, 404);
    } else if (method === 'DELETE') {
      if (!data.ID) return sendJsonResponse({ error: 'ID required for delete' }, 400);
      const success = deleteLog(logSheet, data.ID);
      return success ? sendJsonResponse({ status: 'deleted' }) : sendJsonResponse({ error: 'Not found' }, 404);
    }

    return sendJsonResponse({ error: 'Unknown method' }, 400);
  }

  return sendJsonResponse({error:'Unknown path',path},404);
}