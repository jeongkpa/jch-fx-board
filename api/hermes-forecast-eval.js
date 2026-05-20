// /api/hermes-forecast-eval — Hermes USD/KRW 방향성 복기 API
// Phase 1: evaluates stored 3d/7d/14d direction calls against explicit actual USD/KRW rates.

import {
  DEFAULT_NEUTRAL_BAND,
  buildMetrics,
  evaluateDirectionCall,
  evaluationKey,
  selectActualOnOrBefore
} from './lib/forecast-eval.js';
import { createJsonListStore } from './lib/kv-store.js';

const FORECAST_KEY = 'jch:fx-board:hermes-forecasts';
const EVALUATION_KEY = 'jch:fx-board:hermes-forecast-evaluations';
const MAX_FORECASTS = 200;
const MAX_EVALUATIONS = 600;

const forecastStore = createJsonListStore({
  key: FORECAST_KEY,
  maxItems: MAX_FORECASTS,
  memoryKey: '__JCH_HERMES_FORECASTS'
});

const evaluationStore = createJsonListStore({
  key: EVALUATION_KEY,
  maxItems: MAX_EVALUATIONS,
  memoryKey: '__JCH_HERMES_FORECAST_EVALUATIONS'
});

function nowIso(){ return new Date().toISOString(); }

function getAuthHeader(req){
  const headers = req.headers || {};
  return headers.authorization || headers.Authorization || '';
}

function tokenFromReq(req){
  const headers = req.headers || {};
  const auth = getAuthHeader(req);
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return headers['x-hermes-token'] || headers['X-Hermes-Token'] || req.query?.token || '';
}

function assertAuthorized(req){
  const expected = process.env.HERMES_REPORT_TOKEN;
  const isProduction = process.env.VERCEL_ENV === 'production';
  if (!expected) {
    if (isProduction) throw Object.assign(new Error('HERMES_REPORT_TOKEN is not configured'), { statusCode: 503 });
    return;
  }
  if (tokenFromReq(req) !== expected) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
}

function parseBody(req){
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}

function dateOnly(value = nowIso()){
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('as_of must be a valid date');
  return parsed.toISOString().slice(0, 10);
}

function parseLimit(req){
  const n = parseInt(req.query?.limit ?? '30', 10);
  if (Number.isNaN(n)) return 30;
  return Math.max(1, Math.min(100, n));
}

function normalizeActuals(input){
  const actuals = input.actuals ?? input.rates ?? [];
  if (!Array.isArray(actuals)) throw new Error('actuals must be an array');
  return actuals.map((actual, index) => {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)){
      throw new Error(`actuals[${index}] must be an object`);
    }
    const rate = Number(actual.rate ?? actual.actual_rate ?? actual.actualRate);
    if (!Number.isFinite(rate)) throw new Error(`actuals[${index}].rate must be a finite number`);
    return {
      date: String(actual.date ?? actual.actual_date ?? actual.actualDate ?? '').trim(),
      rate,
      source: String(actual.source ?? actual.actual_source ?? actual.actualSource ?? 'manual').trim() || 'manual'
    };
  });
}

function openCalls(forecasts, evaluations, asOfDate){
  const evaluatedKeys = new Set(evaluations.map(evaluationKey));
  const rows = [];
  for (const forecast of forecasts){
    for (const call of forecast.calls || []){
      const key = `${forecast.id}:${call.horizon}`;
      if (evaluatedKeys.has(key)) continue;
      rows.push({
        forecast_id: forecast.id,
        report_id: forecast.report_id,
        report_title: forecast.report_title,
        base_date: forecast.base_date,
        base_rate: forecast.base_rate,
        horizon: call.horizon,
        target_date: call.target_date,
        raw_label: call.raw_label,
        predicted_direction: call.normalized_direction,
        due: String(call.target_date) <= asOfDate
      });
    }
  }
  return rows.sort((a, b) => String(a.target_date).localeCompare(String(b.target_date)));
}

function buildEvaluation(forecast, call, actual, neutralBand){
  const evaluated = evaluateDirectionCall(call, actual, {
    base_rate: forecast.base_rate,
    neutral_band: neutralBand
  });
  return {
    id: `ev_${forecast.id}_${call.horizon}`,
    forecast_id: forecast.id,
    report_id: forecast.report_id,
    report_title: forecast.report_title,
    base_date: forecast.base_date,
    base_rate: forecast.base_rate,
    rate_source: forecast.rate_source,
    evaluated_at: nowIso(),
    ...evaluated
  };
}

function mergeEvaluations(existing, additions){
  const byKey = new Map();
  for (const item of existing) byKey.set(evaluationKey(item), item);
  for (const item of additions) byKey.set(evaluationKey(item), item);
  return [...byKey.values()]
    .sort((a, b) => String(b.evaluated_at ?? '').localeCompare(String(a.evaluated_at ?? '')))
    .slice(0, MAX_EVALUATIONS);
}

async function readState(){
  const [forecasts, evaluations] = await Promise.all([
    forecastStore.readList(),
    evaluationStore.readList()
  ]);
  return { forecasts, evaluations };
}

function responsePayload({ forecasts, evaluations, limit, asOf }){
  const asOfDate = dateOnly(asOf);
  const recentEvaluations = [...evaluations]
    .sort((a, b) => String(b.evaluated_at ?? '').localeCompare(String(a.evaluated_at ?? '')))
    .slice(0, limit);
  return {
    success: true,
    storage: evaluationStore.storageMode(),
    forecast_storage: forecastStore.storageMode(),
    metrics: buildMetrics(evaluations, { limit: 30 }),
    recent_evaluations: recentEvaluations,
    open_forecasts: openCalls(forecasts, evaluations, asOfDate),
    count: evaluations.length,
    server_time: nowIso()
  };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hermes-Token');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const state = await readState();
      return res.status(200).json(responsePayload({
        ...state,
        limit: parseLimit(req),
        asOf: req.query?.as_of || nowIso()
      }));
    }

    if (req.method === 'POST') {
      assertAuthorized(req);
      const input = parseBody(req);
      const asOf = dateOnly(input.as_of ?? input.asOf ?? nowIso());
      const neutralBand = Number(input.neutral_band ?? input.neutralBand ?? DEFAULT_NEUTRAL_BAND);
      if (!Number.isFinite(neutralBand) || neutralBand < 0) throw new Error('neutral_band must be a non-negative number');
      const actuals = normalizeActuals(input);
      const { forecasts, evaluations } = await readState();
      const evaluatedKeys = new Set(evaluations.map(evaluationKey));
      const additions = [];
      const skipped = [];

      for (const forecast of forecasts){
        if (input.forecast_id && forecast.id !== input.forecast_id) continue;
        for (const call of forecast.calls || []){
          if (input.horizon && call.horizon !== input.horizon) continue;
          const key = `${forecast.id}:${call.horizon}`;
          if (evaluatedKeys.has(key)) {
            skipped.push({ forecast_id: forecast.id, horizon: call.horizon, reason: 'already_evaluated' });
            continue;
          }
          if (String(call.target_date) > asOf) {
            skipped.push({ forecast_id: forecast.id, horizon: call.horizon, reason: 'not_due' });
            continue;
          }
          const actual = selectActualOnOrBefore(call.target_date, actuals);
          if (!actual) {
            skipped.push({ forecast_id: forecast.id, horizon: call.horizon, reason: 'no_actual_on_or_before_target' });
            continue;
          }
          additions.push(buildEvaluation(forecast, call, actual, neutralBand));
        }
      }

      const nextEvaluations = additions.length
        ? await evaluationStore.writeList(mergeEvaluations(evaluations, additions))
        : evaluations;

      return res.status(200).json({
        ...responsePayload({ forecasts, evaluations: nextEvaluations, limit: parseLimit(req), asOf }),
        evaluated_now: additions,
        skipped
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (err) {
    const validationError = /actuals|neutral_band|as_of|date|rate|horizon/.test(err.message || '');
    const status = err.statusCode || (err instanceof SyntaxError || validationError ? 400 : 500);
    return res.status(status).json({
      success: false,
      error: err.message || String(err),
      server_time: nowIso()
    });
  }
}
