// /api/hermes-report — Hermes 보고서 수신/조회 API
// Discord로 발송되는 동일 본문을 대시보드에 표시하기 위한 endpoint.
// Storage priority: Vercel KV/Upstash Redis → serverless memory fallback(dev/preview only).

import { normalizeForecastPayload } from './lib/forecast-eval.js';
import { createJsonListStore } from './lib/kv-store.js';

export const normalizeForecast = normalizeForecastPayload;

const REPORT_KEY = 'jch:fx-board:hermes-reports';
const FORECAST_KEY = 'jch:fx-board:hermes-forecasts';
const MAX_REPORTS = 20;
const MAX_FORECASTS = 200;
const MAX_MARKDOWN_CHARS = 12000;
const MAX_DETAILS_CHARS = 12000;
const MAX_EVIDENCE_TAGS = 8;

const reportStore = createJsonListStore({
  key: REPORT_KEY,
  maxItems: MAX_REPORTS,
  memoryKey: '__JCH_HERMES_REPORTS'
});

const forecastStore = createJsonListStore({
  key: FORECAST_KEY,
  maxItems: MAX_FORECASTS,
  memoryKey: '__JCH_HERMES_FORECASTS'
});

function nowIso(){ return new Date().toISOString(); }

function safeString(value, fallback = ''){
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function clampString(value, max, fallback = ''){
  const s = safeString(value, fallback);
  return s.length > max ? s.slice(0, max) : s;
}

export function sanitizeMarkdown(markdown){
  const body = safeString(markdown);
  if (!body) throw new Error('markdown is required');
  if (body.length > MAX_MARKDOWN_CHARS) {
    throw new Error(`markdown too long: max ${MAX_MARKDOWN_CHARS} chars`);
  }
  return body;
}

export function sanitizeDetailsMarkdown(detailsMarkdown){
  const body = safeString(detailsMarkdown);
  if (!body) return '';
  if (body.length > MAX_DETAILS_CHARS) {
    throw new Error(`details_markdown too long: max ${MAX_DETAILS_CHARS} chars`);
  }
  return body;
}

export function sanitizeEvidenceTags(tags){
  if (tags === null || tags === undefined || tags === '') return [];
  const rawTags = Array.isArray(tags) ? tags : String(tags).split('|');
  return rawTags
    .map((tag) => clampString(tag, 40, ''))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE_TAGS);
}

export function sanitizeSignalBasis(input){
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const allowed = [
    ['technical', '기술적 흐름'],
    ['dollar_rates', '달러·금리'],
    ['risk_sentiment', '위험심리'],
    ['event', '이벤트']
  ];
  const out = {};
  allowed.forEach(([key, label]) => {
    const item = input[key];
    if (item === null || item === undefined) return;
    if (typeof item === 'string') {
      const direction = clampString(item, 40, '');
      if (direction) out[key] = { label, direction, note: '' };
      return;
    }
    if (typeof item === 'object' && !Array.isArray(item)) {
      const direction = clampString(item.direction ?? item.value ?? item.label, 40, '');
      const note = clampString(item.note ?? item.reason ?? '', 160, '');
      if (direction || note) out[key] = { label, direction, note };
    }
  });
  return Object.keys(out).length ? out : null;
}

export function normalizeReport(input = {}){
  const markdown = sanitizeMarkdown(input.markdown ?? input.body ?? input.message);
  const detailsMarkdown = sanitizeDetailsMarkdown(input.details_markdown ?? input.detailsMarkdown ?? input.details);
  const createdAt = safeString(input.created_at || input.createdAt || nowIso());
  const parsedDate = new Date(createdAt);
  const iso = Number.isNaN(parsedDate.getTime()) ? nowIso() : parsedDate.toISOString();
  const rate = Number(input.rate ?? input.base_rate ?? NaN);

  return {
    id: 'hr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    type: clampString(input.type, 40, 'hermes_report') || 'hermes_report',
    title: clampString(input.title, 160, 'Hermes 보고') || 'Hermes 보고',
    markdown,
    details_markdown: detailsMarkdown,
    evidence_tags: sanitizeEvidenceTags(input.evidence_tags ?? input.evidenceTags),
    signal_basis: sanitizeSignalBasis(input.signal_basis ?? input.signalBasis),
    summary: clampString(input.summary, 500, ''),
    rate: Number.isFinite(rate) ? rate : null,
    source: clampString(input.source, 80, ''),
    severity: clampString(input.severity, 20, 'info') || 'info',
    created_at: iso,
    received_at: nowIso()
  };
}


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

async function readReports(){
  return reportStore.readList();
}

async function writeReports(reports){
  return reportStore.writeList(reports);
}

async function readForecasts(){
  return forecastStore.readList();
}

async function writeForecasts(forecasts){
  return forecastStore.writeList(forecasts);
}

function parseLimit(req){
  const raw = req.query?.limit ?? '5';
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 5;
  return Math.max(1, Math.min(20, n));
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Hermes-Token');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const limit = parseLimit(req);
      const reports = await readReports();
      return res.status(200).json({
        success: true,
        storage: reportStore.storageMode(),
        latest: reports[0] || null,
        reports: reports.slice(0, limit),
        count: reports.length,
        server_time: nowIso()
      });
    }

    if (req.method === 'POST') {
      assertAuthorized(req);
      const input = parseBody(req);
      const report = normalizeReport(input);
      let forecast = null;

      if (input.forecast || input.direction_forecast || input.directionForecast) {
        forecast = normalizeForecastPayload(input.forecast ?? input.direction_forecast ?? input.directionForecast, {
          report,
          defaultBaseRate: report.rate,
          defaultRateSource: report.source
        });
        report.forecast_id = forecast.id;
      }

      const reports = await readReports();
      const nextReports = await writeReports([report, ...reports].slice(0, MAX_REPORTS));

      let forecastCount = null;
      if (forecast) {
        const forecasts = await readForecasts();
        forecastCount = (await writeForecasts([forecast, ...forecasts].slice(0, MAX_FORECASTS))).length;
      }

      const payload = {
        success: true,
        storage: reportStore.storageMode(),
        report,
        count: nextReports.length,
        server_time: nowIso()
      };
      if (forecast) {
        payload.forecast_id = forecast.id;
        payload.forecast = forecast;
        payload.forecast_count = forecastCount;
      }
      return res.status(200).json(payload);
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (err) {
    const validationError = /forecast|horizon|base_rate|target_date|direction|calendar date/.test(err.message || '');
    const status = err.statusCode || (err instanceof SyntaxError || validationError ? 400 : 500);
    return res.status(status).json({
      success: false,
      error: err.message || String(err),
      server_time: nowIso()
    });
  }
}
