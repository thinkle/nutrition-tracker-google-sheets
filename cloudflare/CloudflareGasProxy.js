export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);
    let queryString = incomingUrl.search; // Preserve existing query strings if present

    // Extract the path segment (ignoring root `/`)
    const path = incomingUrl.pathname.replace(/^\/|\/$/g, ''); // Removes leading/trailing slashes

    // If there is a path segment, rewrite it to `?path=foo`
    if (path) {
      queryString = `?path=${path}${queryString ? '&' + queryString.slice(1) : ''}`; // Append existing query if any
    }

    // Check if method is not GET or POST and append it as a query parameter
    if (request.method !== 'GET' && request.method !== 'POST') {
      queryString += `${queryString ? '&' : '?'}method=${request.method}`;
    }


    // Your Google Apps Script Web App URL:
    const targetUrl = 'GAS_EXEC_URL' + queryString;

    // Prepare fetch options
    const init = {
      method: ['GET', 'POST'].includes(request.method) ? request.method : 'POST',
      headers: request.headers,
      redirect: 'follow',
    };

    // If the request has a body (e.g., for POST/PUT/DELETE), forward it:
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const contentType = request.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const jsonBody = await request.json();
        init.body = JSON.stringify(jsonBody);
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const formData = await request.formData();
        const params = new URLSearchParams();
        for (const [key, value] of formData.entries()) {
          params.append(key, value);
        }
        init.body = params.toString();
      } else {
        // For other content types, pass through as-is (binary, text, etc.)
        const body = await request.arrayBuffer();
        init.body = body;
      }
    }

    const response = await fetch(targetUrl, init);

    // Create a new response and ensure JSON header
    const result = new Response(response.body, response);
    result.headers.set('Content-Type', 'application/json');

    return result;
  },
};
