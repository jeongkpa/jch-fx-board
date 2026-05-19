// /api/fx-rate — Vercel serverless function
// FX 실시간 환율 어댑터 (네이버 primary, yfinance fallback)
// 설계 근거: planning/data-integrity-architecture.md § 6 어댑터 패턴

import crypto from 'node:crypto';

const NAVER_URL = 'https://finance.naver.com/marketindex/exchangeList.nhn';
const YFINANCE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d';
const TIMEOUT_MS = 5000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- utils ----------
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- naver adapter ----------
async function fetchNaver() {
  const r = await fetchWithTimeout(NAVER_URL, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Referer': 'https://finance.naver.com/'
    }
  });
  if (!r.ok) throw new Error(`Naver HTTP ${r.status}`);
  const html = await r.text();

  // 1순위 패턴: FX_USDKRW 링크 다음의 USD row 찾기
  const row = html.match(/FX_USDKRW[\s\S]{0,500}?<\/a>[\s\S]*?<\/tr>/);
  if (!row) throw new Error('Naver: USD/KRW row not found');

  // 천 단위 콤마 포함 소수점 숫자만 추출
  const nums = [...row[0].matchAll(/[\d,]+\.\d{2,4}/g)]
    .map(m => parseFloat(m[0].replace(/,/g, '')))
    .filter(n => n > 800 && n < 2000); // 환율 범위 sanity check

  if (nums.length < 5) {
    throw new Error(`Naver: only ${nums.length} numbers extracted, need 5+`);
  }

  // 네이버 컬럼 순서: 매매기준율 / 현찰사실때 / 현찰파실때 / 송금보내실때 / 송금받으실때
  const [base_rate, cash_buy, cash_sell, tt_send, tt_receive] = nums;

  // 스프레드 정합성 (smell test): cash_buy > tt_send > base_rate > tt_receive > cash_sell
  const spread_ok = cash_buy > tt_send && tt_send >= base_rate && base_rate >= tt_receive && tt_receive > cash_sell;

  return {
    pair: 'USD/KRW',
    base_rate,
    cash_buy,
    cash_sell,
    tt_send,
    tt_receive,
    spread_valid: spread_ok,
    source: 'naver',
    source_url: NAVER_URL,
    fetched_at: new Date().toISOString(),
    raw_hash: sha256(row[0])
  };
}

// ---------- yfinance adapter (fallback) ----------
async function fetchYFinance() {
  const r = await fetchWithTimeout(YFINANCE_URL, {
    headers: { 'User-Agent': UA }
  });
  if (!r.ok) throw new Error(`YFinance HTTP ${r.status}`);
  const data = await r.json();

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') {
    throw new Error('YFinance: malformed response');
  }

  const price = meta.regularMarketPrice;
  if (price < 800 || price > 2000) {
    throw new Error(`YFinance: price ${price} out of sanity range`);
  }

  return {
    pair: 'USD/KRW',
    base_rate: price,
    previous_close: meta.previousClose ?? null,
    day_high: meta.regularMarketDayHigh ?? null,
    day_low: meta.regularMarketDayLow ?? null,
    market_state: meta.marketState ?? null,
    source: 'yfinance',
    source_url: 'https://finance.yahoo.com/quote/KRW=X',
    fetched_at: new Date().toISOString(),
    raw_hash: sha256(JSON.stringify(meta))
  };
}

// ---------- handler ----------
const ADAPTERS = [
  { name: 'naver',    fn: fetchNaver,    weight: 1.0 },
  { name: 'yfinance', fn: fetchYFinance, weight: 0.95 }
];

export default async function handler(req, res) {
  // CORS (same-origin, but explicit)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  // Edge cache: 60초 fresh + 30초 stale-while-revalidate (네이버 보호)
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const results = [];
  let primary = null;

  for (const adapter of ADAPTERS) {
    try {
      const data = await adapter.fn();
      results.push({ adapter: adapter.name, weight: adapter.weight, success: true, data });
      if (!primary) primary = data;
    } catch (err) {
      results.push({
        adapter: adapter.name,
        weight: adapter.weight,
        success: false,
        error: err.message || String(err)
      });
    }
  }

  const server_time = new Date().toISOString();

  if (!primary) {
    return res.status(503).json({
      success: false,
      error: 'All FX adapters failed',
      attempts: results,
      server_time
    });
  }

  // Cross-check: naver와 yfinance 값 비교
  let cross_check = null;
  if (results.length >= 2 && results[0].success && results[1].success) {
    const a = results[0].data.base_rate;
    const b = results[1].data.base_rate;
    const gap = Math.abs(a - b);
    cross_check = {
      naver_rate: a,
      yfinance_rate: b,
      gap_krw: Number(gap.toFixed(2)),
      consistent: gap < 5.0
    };
  }

  return res.status(200).json({
    success: true,
    primary,
    cross_check,
    attempts: results.map(r => ({
      adapter: r.adapter,
      success: r.success,
      ...(r.success
        ? { base_rate: r.data.base_rate, source: r.data.source }
        : { error: r.error })
    })),
    server_time
  });
}
