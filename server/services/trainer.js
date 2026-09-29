import { store } from '../db/store.js';

/**
 * Simple online weight update from resolved predictions.
 * Correct predictions reinforce the feature components that drove the call;
 * misses dampen them. This is intentionally lightweight and inspectable.
 */
export function trainFromOutcomes() {
  const model = store.getModel();
  const resolved = store.getPredictions().filter(
    (p) => p.status === 'resolved' && p.components && p.modelVersion === model.version,
  );

  // Also accept any resolved with components (retrain continuously)
  const pool = store.getPredictions().filter((p) => p.status === 'resolved' && p.components);
  if (!pool.length) return model;

  const lr = 0.04;
  const weights = { ...model.weights };
  let bias = model.bias || 0;
  let n = 0;

  // Use most recent 200 outcomes
  for (const p of pool.slice(0, 200)) {
    const target = p.correct ? 1 : -1;
    const c = p.components;
    const predSign = Math.sign(p.score) || 1;
    const error = target - predSign * Math.min(1, Math.abs(p.score));

    weights.momentum += lr * error * (c.momentum || 0);
    weights.rsi += lr * error * (c.rsiScore || 0);
    weights.macd += lr * error * (c.macdScore || 0);
    weights.volume += lr * error * (c.volumeScore || 0);
    weights.trend += lr * error * (c.trendScore || 0);
    weights.volatility += lr * error * -(c.volatilityPenalty || 0);
    bias += lr * error * 0.1;
    n += 1;
  }

  // Keep weights in a sane range
  for (const k of Object.keys(weights)) {
    weights[k] = Math.max(0.2, Math.min(2.5, weights[k]));
  }
  bias = Math.max(-0.5, Math.min(0.5, bias));

  const next = {
    ...model,
    version: model.version + (n >= 5 ? 1 : 0),
    weights,
    bias,
    trainedOn: (model.trainedOn || 0) + n,
    lastTrainedAt: new Date().toISOString(),
  };
  store.setModel(next);
  return next;
}
