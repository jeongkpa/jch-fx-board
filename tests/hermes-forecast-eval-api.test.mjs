import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/hermes-forecast-eval.js';

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

function resetForecastEvalState(){
  process.env.HERMES_REPORT_TOKEN = 'test-secret';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.__JCH_HERMES_FORECASTS = [];
  globalThis.__JCH_HERMES_FORECAST_EVALUATIONS = [];
}

function sampleForecast(overrides = {}){
  return {
    id: 'fc_eval_1',
    report_id: 'hr_eval_1',
    report_title: 'JCH FX 오전 8:30 보고',
    type: 'usdkrw_direction_forecast',
    created_at: '2026-05-20T08:30:00.000Z',
    base_date: '2026-05-20',
    base_rate: 1506.5,
    rate_source: 'naver',
    status: 'open',
    calls: [
      { horizon: '3d', target_date: '2026-05-23', raw_label: '상승 우위', normalized_direction: 'up' },
      { horizon: '7d', target_date: '2026-05-27', raw_label: '중립~상승 부담', normalized_direction: 'up' },
      { horizon: '14d', target_date: '2026-06-03', raw_label: '중립', normalized_direction: 'neutral' }
    ],
    ...overrides
  };
}

test('GET /api/hermes-forecast-eval returns empty metrics shape before evaluations', async () => {
  resetForecastEvalState();

  const res = createRes();
  await handler({ method: 'GET', headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.storage, 'memory');
  assert.equal(res.body.metrics.overall.evaluated, 0);
  assert.equal(res.body.metrics.overall.hit_rate, null);
  assert.deepEqual(res.body.recent_evaluations, []);
  assert.deepEqual(res.body.open_forecasts, []);
});

test('POST /api/hermes-forecast-eval requires the protected report token', async () => {
  resetForecastEvalState();

  const res = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer wrong-secret' },
    query: {},
    body: { actuals: [] }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test('POST evaluates due forecast calls from provided actuals and exposes metrics', async () => {
  resetForecastEvalState();
  globalThis.__JCH_HERMES_FORECASTS = [sampleForecast()];

  const res = createRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    query: {},
    body: {
      as_of: '2026-05-28',
      actuals: [
        { date: '2026-05-22', rate: 1508.0, source: 'koreaexim' },
        { date: '2026-05-23', rate: 1512.0, source: 'naver' },
        { date: '2026-05-27', rate: 1508.5, source: 'koreaexim' }
      ]
    }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.evaluated_now.map((item) => item.horizon), ['3d', '7d']);
  assert.equal(res.body.evaluated_now[0].forecast_id, 'fc_eval_1');
  assert.equal(res.body.evaluated_now[0].actual_date, '2026-05-23');
  assert.equal(res.body.evaluated_now[0].rate_change, 5.5);
  assert.equal(res.body.evaluated_now[0].result, 'hit');
  assert.equal(res.body.evaluated_now[1].actual_direction, 'neutral');
  assert.equal(res.body.evaluated_now[1].result, 'partial_miss');
  assert.equal(res.body.metrics.overall.evaluated, 2);
  assert.equal(res.body.metrics.overall.hit, 1);
  assert.equal(res.body.metrics.overall.partial_miss, 1);
  assert.equal(res.body.open_forecasts.length, 1);
  assert.equal(res.body.open_forecasts[0].horizon, '14d');
});

test('POST evaluation is idempotent by forecast_id and horizon', async () => {
  resetForecastEvalState();
  globalThis.__JCH_HERMES_FORECASTS = [sampleForecast()];

  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    query: {},
    body: {
      as_of: '2026-05-24',
      forecast_id: 'fc_eval_1',
      horizon: '3d',
      actuals: [{ date: '2026-05-23', rate: 1512.0, source: 'naver' }]
    }
  };

  const first = createRes();
  await handler(req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.evaluated_now.length, 1);

  const second = createRes();
  await handler(req, second);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body.evaluated_now, []);
  assert.deepEqual(second.body.skipped, [{ forecast_id: 'fc_eval_1', horizon: '3d', reason: 'already_evaluated' }]);
  assert.equal(second.body.recent_evaluations.length, 1);
  assert.equal(globalThis.__JCH_HERMES_FORECAST_EVALUATIONS.length, 1);
});
