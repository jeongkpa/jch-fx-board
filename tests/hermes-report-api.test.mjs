import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { normalizeReport, sanitizeMarkdown, sanitizeEvidenceTags, sanitizeSignalBasis } from '../api/hermes-report.js';

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
