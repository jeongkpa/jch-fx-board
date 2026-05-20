import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { normalizeReport, normalizeForecast, sanitizeMarkdown, sanitizeEvidenceTags, sanitizeSignalBasis } from '../api/hermes-report.js';
import { createJsonListStore } from '../api/lib/kv-store.js';

function createRes(){
  const headers = {};
  return {
    statusCode: 200,
    body: undefined,
    headers,
    setHeader(k, v){ headers[k] = v; },
    status(code){ this.statusCode = code; return this; },
    json(payload){ this.body = payload; return this; },
    end(){ return this; }
  };
}

test('normalizeReport keeps the Discord markdown body and fills metadata', () => {
  const report = normalizeReport({
    type: 'noon_report',
    title: 'JCH FX 오후 12:00 보고',
    markdown: '차상무님 보고 본문',
    details_markdown: '## 자세한 근거\n- 대시보드 전용 근거',
    evidence_tags: ['USD/KRW 상단 유지', '달러 강세'],
    signal_basis: {
      technical: { direction: '상승 압력', note: '5일선 상회' },
      dollar_rates: '상승 부담',
      risk_sentiment: { direction: '중립', note: 'KOSPI 혼조' },
      event: { direction: '변동성 유의' }
    },
    rate: 1506.5,
    source: 'naver'
  });

  assert.equal(report.type, 'noon_report');
  assert.equal(report.title, 'JCH FX 오후 12:00 보고');
  assert.equal(report.markdown, '차상무님 보고 본문');
  assert.equal(report.details_markdown, '## 자세한 근거\n- 대시보드 전용 근거');
  assert.deepEqual(report.evidence_tags, ['USD/KRW 상단 유지', '달러 강세']);
  assert.equal(report.signal_basis.technical.direction, '상승 압력');
  assert.equal(report.signal_basis.dollar_rates.direction, '상승 부담');
  assert.equal(report.rate, 1506.5);
  assert.equal(report.source, 'naver');
  assert.match(report.id, /^hr_/);
  assert.match(report.created_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('dashboard-only evidence helpers clamp detail metadata without scores', () => {
  assert.deepEqual(sanitizeEvidenceTags(['  A  ', '', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(sanitizeEvidenceTags('USD/KRW 상단 유지|달러 강세'), ['USD/KRW 상단 유지', '달러 강세']);

  const basis = sanitizeSignalBasis({
    technical: { direction: '상승 압력', note: '점수 숫자는 저장하지 않음', score: 99 },
    dollar_rates: { value: '상승 부담' },
    unknown: { direction: '무시' }
  });
  assert.deepEqual(Object.keys(basis), ['technical', 'dollar_rates']);
  assert.equal(basis.technical.label, '기술적 흐름');
  assert.equal(basis.technical.direction, '상승 압력');
  assert.equal(basis.technical.score, undefined);
});

test('sanitizeMarkdown rejects empty or oversized report bodies', () => {
  assert.throws(() => sanitizeMarkdown(''), /markdown is required/);
  assert.throws(() => sanitizeMarkdown('x'.repeat(12001)), /markdown too long/);
});

test('kv-store memory fallback reads and truncates JSON lists without KV env', async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete globalThis.__KV_STORE_TEST_REPORTS;

  const store = createJsonListStore({
    key: 'test:key',
    maxItems: 2,
    memoryKey: '__KV_STORE_TEST_REPORTS'
  });

  assert.equal(store.storageMode(), 'memory');
  assert.deepEqual(await store.readList(), []);
  assert.deepEqual(await store.writeList([{ id: 1 }, { id: 2 }, { id: 3 }]), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await store.readList(), [{ id: 1 }, { id: 2 }]);
});

test('handler stores and returns the latest report when token matches', async () => {
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.__JCH_HERMES_REPORTS = [];

  const postRes = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: { title: '테스트 보고', markdown: '본문입니다', type: 'test' }
  }, postRes);
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.success, true);
  assert.equal(postRes.body.report.title, '테스트 보고');

  const getRes = createRes();
  await handler({ method: 'GET', headers: {}, query: { limit: '5' } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.latest.title, '테스트 보고');
  assert.equal(getRes.body.reports.length, 1);
});


test('handler stores optional structured forecast payload with the report', async () => {
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.__JCH_HERMES_REPORTS = [];
  globalThis.__JCH_HERMES_FORECASTS = [];

  const postRes = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: {
      title: 'JCH FX 오전 8:30 보고',
      markdown: '본문입니다',
      rate: 1506.5,
      source: 'naver',
      created_at: '2026-05-20T08:30:00+09:00',
      forecast: {
        base_date: '2026-05-20',
        calls: [
          { horizon: '3d', raw_label: '상승 우위' },
          { horizon: '7d', raw_label: '중립~상승 부담' },
          { horizon: '14d', raw_label: '중립' }
        ]
      }
    }
  }, postRes);

  assert.equal(postRes.statusCode, 200);
  assert.match(postRes.body.forecast_id, /^fc_/);
  assert.equal(postRes.body.forecast.report_id, postRes.body.report.id);
  assert.deepEqual(postRes.body.forecast.calls.map((call) => call.horizon), ['3d', '7d', '14d']);
  assert.deepEqual(globalThis.__JCH_HERMES_FORECASTS.map((forecast) => forecast.id), [postRes.body.forecast_id]);
});

test('normalizeForecast stores 3d/7d/14d calls with target dates and normalized directions', () => {
  const report = normalizeReport({
    title: 'JCH FX 오전 8:30 보고',
    markdown: '본문입니다',
    rate: 1506.5,
    source: 'naver',
    created_at: '2026-05-20T08:30:00+09:00'
  });

  const forecast = normalizeForecast({
    base_date: '2026-05-20',
    calls: [
      { horizon: '3d', raw_label: '상승 우위', rationale_tags: ['달러 강세'] },
      { horizon: '7d', raw_label: '중립~상승 부담' },
      { horizon: '14d', raw_label: '중립' }
    ]
  }, { report });

  assert.match(forecast.id, /^fc_/);
  assert.equal(forecast.report_id, report.id);
  assert.equal(forecast.base_date, '2026-05-20');
  assert.equal(forecast.base_rate, 1506.5);
  assert.equal(forecast.rate_source, 'naver');
  assert.equal(forecast.status, 'open');
  assert.deepEqual(forecast.calls.map((call) => call.horizon), ['3d', '7d', '14d']);
  assert.deepEqual(forecast.calls.map((call) => call.target_date), ['2026-05-23', '2026-05-27', '2026-06-03']);
  assert.deepEqual(forecast.calls.map((call) => call.normalized_direction), ['up', 'up', 'neutral']);
});

test('handler stores optional forecast payload and remains backward compatible without it', async () => {
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.__JCH_HERMES_REPORTS = [];
  globalThis.__JCH_HERMES_FORECASTS = [];

  const noForecastRes = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: { title: '기존 보고', markdown: '본문입니다', rate: 1500.1, source: 'naver' }
  }, noForecastRes);
  assert.equal(noForecastRes.statusCode, 200);
  assert.equal(noForecastRes.body.success, true);
  assert.equal(noForecastRes.body.forecast_id, undefined);
  assert.equal(globalThis.__JCH_HERMES_FORECASTS.length, 0);

  const forecastRes = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: {
      title: '전망 포함 보고',
      markdown: '본문입니다',
      rate: 1506.5,
      source: 'naver',
      forecast: {
        base_date: '2026-05-20',
        calls: [
          { horizon: '3d', raw_label: '상승 우위' },
          { horizon: '7d', raw_label: '중립~상승 부담' },
          { horizon: '14d', raw_label: '중립' }
        ]
      }
    }
  }, forecastRes);

  assert.equal(forecastRes.statusCode, 200);
  assert.match(forecastRes.body.forecast_id, /^fc_/);
  assert.equal(forecastRes.body.report.forecast_id, forecastRes.body.forecast_id);
  assert.equal(forecastRes.body.forecast.calls[0].target_date, '2026-05-23');
  assert.equal(forecastRes.body.forecast_count, 1);
  assert.equal(globalThis.__JCH_HERMES_FORECASTS[0].id, forecastRes.body.forecast_id);
});

test('handler rejects forecast payload with unsupported horizon', async () => {
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.__JCH_HERMES_REPORTS = [];
  globalThis.__JCH_HERMES_FORECASTS = [];

  const res = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: {
      title: '잘못된 전망',
      markdown: '본문입니다',
      rate: 1506.5,
      forecast: { base_date: '2026-05-20', calls: [{ horizon: '5d', raw_label: '상승 우위' }] }
    }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /horizon must be one of/);
  assert.equal(globalThis.__JCH_HERMES_FORECASTS.length, 0);
});

test('handler rejects POST when token is wrong', async () => {
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  const res = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer wrong' },
    body: { title: '거절', markdown: '본문' }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});
