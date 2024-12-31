
/*******************
 * TOKEN / SECURITY
 *******************/
function getApiToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('API_TOKEN', token);
  }
  return token;
}

function checkToken(e) {
  const provided = e.parameter.token;
  const expected = getApiToken();
  return (provided && provided === expected);
}