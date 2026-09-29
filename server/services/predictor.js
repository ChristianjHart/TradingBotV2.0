import { extractFeatures } from './indicators.js';

// Fixed rule weights (the old self-training loop was retired; this is only the rules fallback).
const MODEL = { version: 1, bias: 0, weights: { momentum: 1, rsi: 1, macd: 1, volume: 1, volatility: 1, trend: 1 } };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function scoreFromFeatures(features, weights, bias = 0) {
  // Normalize feature contributions into roughly [-1, 1] space
  const momentum = clamp(features.momentum5 * 25 + features.momentum20 * 10, -1.5, 1.5);
  const rsiScore = clamp((50 - features.rsi) / 30, -1.5, 1.5); // oversold → bullish
  const macdScore = clamp(features.macdHist / (features.price * 0.002 || 1), -1.5, 1.5);
  const volumeScore = clamp((features.volumeRatio - 1) * 0.8, -1, 1.5);
  const volatilityPenalty = clamp(features.volatility * 8, 0, 1.2);
  const trendScore = clamp(features.trend * 40 + features.aboveSma50 * 5, -1.5, 1.5);

  const raw =
    weights.momentum * momentum +
    weights.rsi * rsiScore +
    weights.macd * macdScore +
    weights.volume * volumeScore +
    weights.trend * trendScore -
    weights.volatility * volatilityPenalty +
    bias;

  return {
    raw,
    components: { momentum, rsiScore, macdScore, volumeScore, volatilityPenalty, trendScore },
  };
}

function directionFromScore(raw) {
  if (raw >= 0.35) return 'long';
  if (raw <= -0.35) return 'short';
  return 'neutral';
}

function confidenceFromScore(raw, components) {
  const magnitude = Math.abs(raw);
  const agreement =
    [components.momentum, components.rsiScore, components.macdScore, components.trendScore]
      .map((v) => Math.sign(v) === Math.sign(raw) || Math.abs(v) < 0.05)
      .filter(Boolean).length / 4;
  return clamp(0.45 + magnitude * 0.25 + agreement * 0.2, 0.4, 0.96);
}

/**
 * Human-readable reasons that agree with the chosen direction. Bullish signals (momentum up, RSI oversold = bounce setup,
 * MACD up, EMA trend up) are listed for longs, bearish ones (fading momentum, RSI overbought, MACD down, trend down) for shorts;
 * signals pointing the other way are never listed as reasons. Neutral keeps a single 'mixed' note.
 */
export function reasonsFor(direction, features, components) {
  if (direction === 'neutral') return ['mixed signals — low edge'];
  const bull = [];
  const bear = [];
  if (components.momentum > 0.3) bull.push('strong short-term momentum');
  if (components.momentum < -0.3) bear.push('fading momentum');
  if (features.rsi < 35) bull.push('RSI oversold (bounce setup)');
  if (features.rsi > 65) bear.push('RSI overbought (pullback setup)');
  if (components.macdScore > 0.2) bull.push('MACD histogram expanding up');
  if (components.macdScore < -0.2) bear.push('MACD histogram expanding down');
  if (components.trend > 0.25) bull.push('EMA9 > EMA21 trend up');
  if (components.trend < -0.25) bear.push('EMA9 < EMA21 trend down');
  const reasons = direction === 'long' ? bull : bear;
  if (features.volumeRatio > 1.4) reasons.push('elevated volume');
  if (!reasons.length) reasons.push(`composite score favours ${direction}`);
  return reasons;
}

export function predictFromBars(symbol, bars, { horizonHours } = {}) {
  const model = MODEL;
  const features = extractFeatures(bars);
  const { raw, components } = scoreFromFeatures(features, model.weights, model.bias);
  const direction = directionFromScore(raw);
  const confidence = confidenceFromScore(raw, components);
  const horizon = horizonHours || 24;
  const expectedMovePct = clamp(raw * 1.8 * (1 + features.volatility * 5), -8, 8);
  const targetPrice = features.price * (1 + expectedMovePct / 100);

  const reasons = reasonsFor(direction, features, components);

  return {
    id: `pred_${Date.now()}_${symbol.replace('/', '')}_${Math.random().toString(36).slice(2, 6)}`,
    symbol,
    assetClass: symbol.includes('/') ? 'crypto' : 'equity',
    direction,
    confidence: +confidence.toFixed(3),
    score: +raw.toFixed(4),
    entryPrice: +features.price.toFixed(4),
    targetPrice: +targetPrice.toFixed(4),
    expectedMovePct: +expectedMovePct.toFixed(3),
    horizonHours: horizon,
    createdAt: new Date().toISOString(),
    resolveAt: new Date(Date.now() + horizon * 3600_000).toISOString(),
    status: direction === 'neutral' ? 'skipped' : 'open',
    outcome: null,
    actualPrice: null,
    actualMovePct: null,
    correct: null,
    reasons,
    features: {
      rsi: +features.rsi.toFixed(2),
      momentum5: +features.momentum5.toFixed(4),
      momentum20: +features.momentum20.toFixed(4),
      macdHist: +features.macdHist.toFixed(4),
      volumeRatio: +features.volumeRatio.toFixed(2),
      volatility: +features.volatility.toFixed(4),
      trend: +features.trend.toFixed(4),
    },
    components,
    modelVersion: model.version,
  };
}

export function rankCandidates(preds) {
  return [...preds]
    .filter((p) => p.direction !== 'neutral')
    .sort((a, b) => b.confidence * Math.abs(b.score) - a.confidence * Math.abs(a.score));
}
