import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays,
  buildTargetDates,
  classifyActualDirection,
  evaluateDirectionCall,
  normalizeDirectionLabel,
  parseHorizonDays,
  rateChange,
  scoreDirection,
  selectActualOnOrBefore,
  summarizeScores,
  targetDateForHorizon,
  normalizeForecastPayload,
  buildMetrics
} from '../api/lib/forecast-eval.js';

test('normalizeDirectionLabel maps Korean report wording to evaluation directions', () => {
  assert.equal(normalizeDirectionLabel('상승 우위'), 'up');
  assert.equal(normalizeDirectionLabel('상승 압력'), 'up');
  assert.equal(normalizeDirectionLabel('상승 부담'), 'up');
  assert.equal(normalizeDirectionLabel('상단 유지'), 'up');
  assert.equal(normalizeDirectionLabel('중립~상승 부담'), 'up');

  assert.equal(normalizeDirectionLabel('하락 우위'), 'down');
  assert.equal(normalizeDirectionLabel('하락 압력'), 'down');
  assert.equal(normalizeDirectionLabel('하락 여지'), 'down');

  assert.equal(normalizeDirectionLabel('중립'), 'neutral');
  assert.equal(normalizeDirectionLabel('랜덤워크 우세'), 'neutral');
  assert.equal(normalizeDirectionLabel('방향성 약함'), 'neutral');
});

test('normalizeDirectionLabel accepts canonical labels and returns null for unknown input', () => {
  assert.equal(normalizeDirectionLabel('up'), 'up');
  assert.equal(normalizeDirectionLabel('neutral'), 'neutral');
  assert.equal(normalizeDirectionLabel('down'), 'down');
  assert.equal(normalizeDirectionLabel('현 수준 관찰'), null);
  assert.equal(normalizeDirectionLabel(''), null);
});

test('classifyActualDirection uses an inclusive neutral band', () => {
  assert.equal(classifyActualDirection(1506.5, 1509.4, 3), 'neutral');
  assert.equal(classifyActualDirection(1506.5, 1509.5, 3), 'neutral');
  assert.equal(classifyActualDirection(1506.5, 1503.5, 3), 'neutral');
  assert.equal(classifyActualDirection(1506.5, 1510.0, 3), 'up');
  assert.equal(classifyActualDirection(1506.5, 1503.4, 3), 'down');
});

test('scoreDirection returns hit, miss, and partial_miss according to Phase 1 rules', () => {
  assert.equal(scoreDirection('up', 'up'), 'hit');
  assert.equal(scoreDirection('down', 'down'), 'hit');
  assert.equal(scoreDirection('neutral', 'neutral'), 'hit');

  assert.equal(scoreDirection('up', 'down'), 'miss');
  assert.equal(scoreDirection('down', 'up'), 'miss');
  assert.equal(scoreDirection('neutral', 'up'), 'miss');
  assert.equal(scoreDirection('neutral', 'down'), 'miss');

  assert.equal(scoreDirection('up', 'neutral'), 'partial_miss');
  assert.equal(scoreDirection('down', 'neutral'), 'partial_miss');
});

test('target-date helpers add calendar-day horizons and reject invalid dates', () => {
  assert.equal(parseHorizonDays('3d'), 3);
  assert.equal(parseHorizonDays('7 days'), 7);
  assert.equal(parseHorizonDays('14일'), 14);
  assert.equal(addCalendarDays('2026-05-20', 3), '2026-05-23');
  assert.equal(targetDateForHorizon('2026-05-20', '7d'), '2026-05-27');
  assert.deepEqual(buildTargetDates('2026-05-20', ['3d', '7d', '14d']), {
    '3d': '2026-05-23',
    '7d': '2026-05-27',
    '14d': '2026-06-03'
  });
  assert.throws(() => targetDateForHorizon('2026-02-30', '3d'), /real calendar date/);
  assert.throws(() => parseHorizonDays('week'), /horizon/);
});

test('selectActualOnOrBefore picks the latest available actual not after target date', () => {
  const actuals = [
    { date: '2026-05-22', rate: 1508.0, source: 'koreaexim' },
    { date: '2026-05-21', rate: 1507.0, source: 'koreaexim' },
    { date: '2026-05-24', rate: 1510.0, source: 'naver' }
  ];

  assert.deepEqual(selectActualOnOrBefore('2026-05-23', actuals), {
    date: '2026-05-22',
    rate: 1508.0,
    source: 'koreaexim'
  });
  assert.equal(selectActualOnOrBefore('2026-05-20', actuals), null);
});

test('evaluateDirectionCall combines normalization, actual classification, and scoring', () => {
  const evaluation = evaluateDirectionCall(
    { horizon: '3d', target_date: '2026-05-23', raw_label: '상승 우위' },
    { date: '2026-05-23', rate: 1512.0, source: 'koreaexim' },
    { base_rate: 1506.5, neutral_band: 3.0 }
  );

  assert.deepEqual(evaluation, {
    horizon: '3d',
    target_date: '2026-05-23',
    actual_date: '2026-05-23',
    actual_rate: 1512.0,
    actual_source: 'koreaexim',
    rate_change: 5.5,
    predicted_direction: 'up',
    actual_direction: 'up',
    result: 'hit',
    neutral_band: 3.0
  });

  assert.equal(rateChange(1506.55, 1509.04), 2.5);
});

test('summarizeScores uses strict hit over evaluated denominator', () => {
  const summary = summarizeScores([
    { result: 'hit' },
    { result: 'miss' },
    { result: 'partial_miss' },
    { result: 'ignored' }
  ]);

  assert.deepEqual(summary, {
    evaluated: 3,
    hit: 1,
    miss: 1,
    partial_miss: 1,
    hit_rate: 1 / 3
  });
});


test('normalizeForecastPayload builds auditable 3d/7d/14d forecast records', () => {
  const forecast = normalizeForecastPayload({
    base_date: '2026-05-20',
    base_rate: 1506.5,
    rate_source: 'naver',
    calls: [
      { horizon: '3d', raw_label: '상승 우위', rationale_tags: ['달러 강세'] },
      { horizon: '7d', raw_label: '중립~상승 부담' },
      { horizon: '14d', raw_label: '중립' }
    ]
  }, {
    report: { id: 'hr_test', title: 'JCH FX 오전 8:30 보고', created_at: '2026-05-20T08:30:00+09:00' }
  });

  assert.match(forecast.id, /^fc_/);
  assert.equal(forecast.report_id, 'hr_test');
  assert.equal(forecast.base_date, '2026-05-20');
  assert.equal(forecast.base_rate, 1506.5);
  assert.equal(forecast.calls.length, 3);
  assert.deepEqual(forecast.calls.map((call) => call.target_date), ['2026-05-23', '2026-05-27', '2026-06-03']);
  assert.deepEqual(forecast.calls.map((call) => call.normalized_direction), ['up', 'up', 'neutral']);
});

test('buildMetrics summarizes strict hit rates by horizon and direction', () => {
  const metrics = buildMetrics([
    { horizon: '3d', predicted_direction: 'up', result: 'hit', evaluated_at: '2026-05-24T00:00:00Z', neutral_band: 3 },
    { horizon: '7d', predicted_direction: 'up', result: 'partial_miss', evaluated_at: '2026-05-23T00:00:00Z', neutral_band: 3 },
    { horizon: '14d', predicted_direction: 'neutral', result: 'miss', evaluated_at: '2026-05-22T00:00:00Z', neutral_band: 3 }
  ]);

  assert.equal(metrics.overall.evaluated, 3);
  assert.equal(metrics.overall.hit, 1);
  assert.equal(metrics.overall.partial_miss, 1);
  assert.equal(metrics.overall.hit_rate, 1 / 3);
  assert.equal(metrics.by_horizon['3d'].hit_rate, 1);
  assert.equal(metrics.by_direction.up.evaluated, 2);
});
