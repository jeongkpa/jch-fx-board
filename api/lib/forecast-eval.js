const DIRECTIONS = new Set(['up', 'neutral', 'down']);
const RESULT_CLASSES = new Set(['hit', 'miss', 'partial_miss']);
const HORIZON_DAYS = Object.freeze({
  '3d': 3,
  '7d': 7,
  '14d': 14
});
const DEFAULT_NEUTRAL_BAND = 3.0;

function assertValidDirection(direction, fieldName = 'direction'){
  if (!DIRECTIONS.has(direction)){
    throw new Error(`${fieldName} must be one of: up, neutral, down`);
  }
}

function parseDateOnly(value, fieldName = 'date'){
  if (value instanceof Date){
    if (Number.isNaN(value.getTime())) throw new Error(`${fieldName} must be a valid date`);
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  if (typeof value !== 'string'){
    throw new Error(`${fieldName} must be a YYYY-MM-DD string`);
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match){
    throw new Error(`${fieldName} must be a YYYY-MM-DD string`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ){
    throw new Error(`${fieldName} must be a real calendar date`);
  }
  return date;
}

function formatDateOnly(date){
  if (!(date instanceof Date) || Number.isNaN(date.getTime())){
    throw new Error('date must be a valid Date');
  }
  return date.toISOString().slice(0, 10);
}

function normalizeText(value){
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeDirectionLabel(label){
  const text = normalizeText(label);
  if (!text) return null;

  if (DIRECTIONS.has(text)) return text;

  const hasUp = /상승|상단|강세|오름|오를|up|upside|higher|bull/.test(text);
  const hasDown = /하락|하단|약세|내림|내릴|down|downside|lower|bear/.test(text);
  const hasNeutral = /중립|랜덤워크|방향성\s*약함|보합|횡보|neutral|flat|sideways/.test(text);

  if (hasUp && !hasDown) return 'up';
  if (hasDown && !hasUp) return 'down';

  // Phase 1 conservative mapping: mixed neutral/upside-risk wording such as
  // "중립~상승 부담" is evaluated as up because the operating implication is defensive.
  if (hasNeutral && hasUp && !hasDown) return 'up';
  if (hasNeutral && hasDown && !hasUp) return 'down';

  if (hasNeutral && !hasUp && !hasDown) return 'neutral';

  return null;
}

export function parseHorizonDays(horizon){
  if (typeof horizon === 'number' && Number.isInteger(horizon) && horizon > 0){
    return horizon;
  }

  const text = normalizeText(horizon);
  if (Object.hasOwn(HORIZON_DAYS, text)) return HORIZON_DAYS[text];

  const match = text.match(/^(\d+)\s*(d|day|days|일)$/);
  if (match){
    const days = Number(match[1]);
    if (days > 0) return days;
  }

  throw new Error('horizon must be a positive day horizon such as 3d, 7d, or 14d');
}

export function addCalendarDays(dateValue, days){
  if (!Number.isInteger(days)){
    throw new Error('days must be an integer');
  }
  const date = parseDateOnly(dateValue);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

export function targetDateForHorizon(baseDate, horizon){
  return addCalendarDays(baseDate, parseHorizonDays(horizon));
}

export function buildTargetDates(baseDate, horizons = Object.keys(HORIZON_DAYS)){
  return Object.fromEntries(horizons.map((horizon) => [String(horizon), targetDateForHorizon(baseDate, horizon)]));
}

export function classifyActualDirection(baseRate, actualRate, neutralBand = DEFAULT_NEUTRAL_BAND){
  const base = Number(baseRate);
  const actual = Number(actualRate);
  const band = Number(neutralBand);

  if (!Number.isFinite(base)) throw new Error('baseRate must be a finite number');
  if (!Number.isFinite(actual)) throw new Error('actualRate must be a finite number');
  if (!Number.isFinite(band) || band < 0) throw new Error('neutralBand must be a non-negative number');

  const change = actual - base;
  if (change > band) return 'up';
  if (change < -band) return 'down';
  return 'neutral';
}

export function rateChange(baseRate, actualRate){
  const base = Number(baseRate);
  const actual = Number(actualRate);
  if (!Number.isFinite(base)) throw new Error('baseRate must be a finite number');
  if (!Number.isFinite(actual)) throw new Error('actualRate must be a finite number');
  return Math.round((actual - base) * 10) / 10;
}

export function scoreDirection(predictedDirection, actualDirection){
  assertValidDirection(predictedDirection, 'predictedDirection');
  assertValidDirection(actualDirection, 'actualDirection');

  if (predictedDirection === actualDirection) return 'hit';
  if (predictedDirection !== 'neutral' && actualDirection === 'neutral') return 'partial_miss';
  return 'miss';
}

export function summarizeScores(evaluations = []){
  const summary = { evaluated: 0, hit: 0, miss: 0, partial_miss: 0, hit_rate: null };

  for (const evaluation of evaluations){
    const result = evaluation?.result;
    if (!RESULT_CLASSES.has(result)) continue;
    summary.evaluated += 1;
    summary[result] += 1;
  }

  summary.hit_rate = summary.evaluated > 0 ? summary.hit / summary.evaluated : null;
  return summary;
}

export function selectActualOnOrBefore(targetDate, actuals = []){
  const target = parseDateOnly(targetDate, 'targetDate');
  let selected = null;

  for (const actual of actuals){
    if (!actual || actual.date == null || actual.rate == null) continue;
    const date = parseDateOnly(actual.date, 'actual.date');
    if (date > target) continue;
    if (!selected || date > selected._date){
      selected = { ...actual, _date: date };
    }
  }

  if (!selected) return null;
  const { _date, ...actual } = selected;
  return actual;
}

export function evaluateDirectionCall(call, actual, options = {}){
  if (!call || !actual) throw new Error('call and actual are required');

  const baseRate = options.base_rate ?? options.baseRate ?? call.base_rate ?? call.baseRate;
  const actualRate = actual.rate ?? actual.actual_rate ?? actual.actualRate;
  const predictedDirection = call.normalized_direction ?? call.direction ?? normalizeDirectionLabel(call.raw_label);
  const neutralBand = options.neutral_band ?? options.neutralBand ?? DEFAULT_NEUTRAL_BAND;

  assertValidDirection(predictedDirection, 'predictedDirection');

  const actualDirection = classifyActualDirection(baseRate, actualRate, neutralBand);
  return {
    horizon: call.horizon,
    target_date: call.target_date,
    actual_date: actual.date ?? actual.actual_date,
    actual_rate: Number(actualRate),
    actual_source: actual.source ?? actual.actual_source,
    rate_change: rateChange(baseRate, actualRate),
    predicted_direction: predictedDirection,
    actual_direction: actualDirection,
    result: scoreDirection(predictedDirection, actualDirection),
    neutral_band: Number(neutralBand)
  };
}

function cleanString(value, max = 160){
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function generatedId(prefix){
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function normalizeForecastPayload(input = {}, context = {}){
  if (!input || typeof input !== 'object' || Array.isArray(input)){
    throw new Error('forecast must be an object');
  }

  const report = context.report || {};
  const createdAt = cleanString(input.created_at ?? input.createdAt ?? report.created_at ?? new Date().toISOString(), 80);
  const parsedCreatedAt = new Date(createdAt);
  const createdIso = Number.isNaN(parsedCreatedAt.getTime()) ? new Date().toISOString() : parsedCreatedAt.toISOString();
  const baseDate = cleanString(input.base_date ?? input.baseDate ?? createdIso.slice(0, 10), 10);
  // Validate early so target-date derivation errors are clear.
  parseDateOnly(baseDate, 'forecast.base_date');

  const baseRate = Number(input.base_rate ?? input.baseRate ?? context.defaultBaseRate ?? report.rate ?? NaN);
  if (!Number.isFinite(baseRate)) throw new Error('forecast.base_rate must be a finite number');

  const rawCalls = input.calls ?? input.horizons ?? [];
  if (!Array.isArray(rawCalls) || rawCalls.length === 0){
    throw new Error('forecast.calls must be a non-empty array');
  }

  const calls = rawCalls.map((call, index) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)){
      throw new Error(`forecast.calls[${index}] must be an object`);
    }
    const horizon = cleanString(call.horizon ?? call.term ?? call.days, 20);
    const days = parseHorizonDays(horizon);
    if (![3, 7, 14].includes(days)){
      throw new Error('horizon must be one of 3d, 7d, or 14d in Phase 1');
    }
    const normalizedHorizon = `${days}d`;
    const rawLabel = cleanString(call.raw_label ?? call.rawLabel ?? call.label ?? call.direction_label ?? call.direction ?? '', 80);
    const directionInput = call.normalized_direction ?? call.normalizedDirection ?? call.direction ?? rawLabel;
    const normalizedDirection = DIRECTIONS.has(String(directionInput).trim())
      ? String(directionInput).trim()
      : normalizeDirectionLabel(directionInput);
    if (!normalizedDirection){
      throw new Error(`forecast.calls[${index}].direction could not be normalized`);
    }

    return {
      horizon: normalizedHorizon,
      target_date: cleanString(call.target_date ?? call.targetDate ?? targetDateForHorizon(baseDate, normalizedHorizon), 10),
      raw_label: rawLabel || normalizedDirection,
      normalized_direction: normalizedDirection,
      rationale_tags: Array.isArray(call.rationale_tags ?? call.rationaleTags)
        ? (call.rationale_tags ?? call.rationaleTags).map((tag) => cleanString(tag, 60)).filter(Boolean).slice(0, 8)
        : []
    };
  });

  const seen = new Set();
  for (const call of calls){
    if (seen.has(call.horizon)) throw new Error(`duplicate forecast horizon: ${call.horizon}`);
    seen.add(call.horizon);
    parseDateOnly(call.target_date, 'forecast.call.target_date');
  }

  return {
    id: generatedId('fc'),
    report_id: report.id ?? cleanString(input.report_id ?? input.reportId, 80),
    type: 'usdkrw_direction_forecast',
    created_at: createdIso,
    base_date: baseDate,
    base_rate: Math.round(baseRate * 10) / 10,
    rate_source: cleanString(input.rate_source ?? input.rateSource ?? context.defaultRateSource ?? report.source ?? '', 80),
    report_title: cleanString(input.report_title ?? input.reportTitle ?? report.title ?? '', 160),
    calls,
    status: 'open'
  };
}

export function evaluationKey(evaluation){
  return `${evaluation.forecast_id}:${evaluation.horizon}`;
}

export function buildMetrics(evaluations = [], { limit = 30 } = {}){
  const sorted = [...evaluations]
    .filter((item) => item && RESULT_CLASSES.has(item.result))
    .sort((a, b) => String(b.evaluated_at ?? '').localeCompare(String(a.evaluated_at ?? '')));
  const recent = Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;

  const byHorizon = {};
  const byDirection = {};
  for (const horizon of ['3d', '7d', '14d']) byHorizon[horizon] = summarizeScores([]);
  for (const direction of ['up', 'neutral', 'down']) byDirection[direction] = summarizeScores([]);

  for (const horizon of ['3d', '7d', '14d']){
    byHorizon[horizon] = summarizeScores(recent.filter((evaluation) => evaluation.horizon === horizon));
  }
  for (const direction of ['up', 'neutral', 'down']){
    byDirection[direction] = summarizeScores(recent.filter((evaluation) => evaluation.predicted_direction === direction));
  }

  return {
    window: `last_${recent.length}_evaluated_calls`,
    neutral_band: recent[0]?.neutral_band ?? DEFAULT_NEUTRAL_BAND,
    overall: summarizeScores(recent),
    by_horizon: byHorizon,
    by_direction: byDirection
  };
}

export { DEFAULT_NEUTRAL_BAND, HORIZON_DAYS };

