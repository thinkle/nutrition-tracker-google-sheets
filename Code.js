/*******************
 * CONFIGURATION
 *******************/
const FIXED_FIELDS_SPEC = [
  { name: 'ID', type: 'string' },
  { name: 'Date', type: 'string', format: 'date' },
  { name: 'Meal', type: 'string' },
  { name: 'Food', type: 'string' },
  { name: 'Description', type: 'string' }
];

const NUTRIENTS_SPEC = [
  { name: 'kcal', type: 'number' },
  { name: 'protein', type: 'number' },
  { name: 'fat', type: 'number' },
  { name: 'carbs', type: 'number' },
  { name: 'added_sugar', type: 'number' },
  { name: 'fiber', type: 'number' },
  { name: 'alcohol', type: 'number' }
];

// Derived arrays of names for setup and data ops:
const FIXED_FIELDS = FIXED_FIELDS_SPEC.map(f => f.name);
const NUTRIENTS = NUTRIENTS_SPEC.map(n => n.name);

function getDeployedWebAppUrl () {
  //ScriptApp.getService().getUrl();
  //return 'https://script.google.com/macros/s/AKfycbzox3LwF2jBYnddsG9Rj7JLTVNr2t_CyaZe5HHyuJeqlRri0MnFvgQWcisAfiFFUjA/exec';
  return 'https://nutrition.tmhinkle.workers.dev/';
}





