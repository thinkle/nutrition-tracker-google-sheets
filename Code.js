/*******************
 * CONFIGURATION
 *******************/
const FIXED_FIELDS_SPEC = [
  { name: 'ID', type: 'string' },
  { name: 'Date', type: 'string', format: 'date', required : true },
  { name: 'Meal', type: 'string' },
  { name: 'Food', type: 'string', required: true },
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

const METRICS_SPEC = [
  { name: 'Date', type: 'string', format: 'date', required: true },
  { name: 'Weight', type: 'number' },
  { name: 'Waist', type: 'number' },
  { name: 'OtherMeasurements', type: 'string' },
  { name: 'Notes', type: 'string' }
];

const GOALS_SPEC = [
  { name: 'Date', type: 'string', format: 'date', required: true },
  { name: 'WeightGoal', type: 'string' },
  { name: 'NutritionGoal', type: 'string' },
  { name: 'OtherGoal', type: 'string' },
  { name: 'Notes', type: 'string' },
  ...NUTRIENTS_SPEC
];

// Derived arrays of names for setup and data ops:
const FIXED_FIELDS = FIXED_FIELDS_SPEC.map(f => f.name);
const NUTRIENTS = NUTRIENTS_SPEC.map(n => n.name);
const METRICS = METRICS_SPEC.map(m => m.name);
const GOALS = GOALS_SPEC.map(g => g.name);

function getDeployedWebAppUrl () {
  //ScriptApp.getService().getUrl();
  //return 'https://script.google.com/macros/s/AKfycbzox3LwF2jBYnddsG9Rj7JLTVNr2t_CyaZe5HHyuJeqlRri0MnFvgQWcisAfiFFUjA/exec';
  return 'https://nutrition.tmhinkle.workers.dev/';
}





