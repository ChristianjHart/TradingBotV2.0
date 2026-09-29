import { evaluateOpenPredictions, getAccuracyStats } from '../services/evaluator.js';

const result = await evaluateOpenPredictions();
console.log('evaluated', result);
console.log('accuracy', getAccuracyStats());
process.exit(0);
