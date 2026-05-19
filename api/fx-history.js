// /api/fx-history?days=30 — Vercel serverless function
// USD/KRW 일별 종가 시계열 (multi-source 어댑터)
//   Primary  : 한국수출입은행 (Korea Eximbank, 한국 공식 매매기준율) 🇰🇷
//   Fallback1: Frankfurter API (ECB cross-rate)
//   Fallback2: Yahoo Finance KRW=X (rate-limited 가능)
// 설계 근거: planning/data-integrity-architecture.md § 6 어댑터 패턴

import crypto from 'node:crypto';

const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 한국수출입은행 API key — 박정기 발급 (2026-05-19)
// 사용자 동의로 노출 허용. 추후 Vercel env var KOREAEXIM_API_KEY로 이관 가능.
const KOREAEXIM_KEY = process.env.KOREAEXIM_API_KEY || 'L9yVwr7icM0ZXdrd0wKxjmi0rO0UL2ba';

function sha256(text){
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function valid(n){
  return typeof n === 'number' && !isNaN(n) && n > 800 && n < 2000;
}

function parseKRW(s){
  // "1,503.4" → 1503.4
  if (typeof s !== 'string') return NaN;
  return parseFloat(s.replace(/,/g, ''));
}

function formatDateYYYYMMDD(date){
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// 오늘부터 거꾸로 N 영업일 (월~금)을 수집. KST 기준으로 보정.
function businessDaysBackward(count){
  const dates = [];
  // KST = UTC+9. Use KST 'today' as starting point.
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);
  const d = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));

  let safety = 0;
  while (dates.length < count && safety < 120) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {  // skip Sun(0), Sat(6)
      dates.push(new Date(d));
    }
    d.setUTCDate(d.getUTCDate() - 1);
    safety++;
  }
  return dates.reverse(); // oldest first
}

// =========================================================
// Adapter 1: 한국수출입은행 (NEW PRIMARY) 🇰🇷
//   - 한국 공식 매매기준율 (서울외국환중개와 동일)
//   - 영업일 11:00 KST 일 1회 갱신
//   - 일일 1,000회 호출 한도 (캐시로 절약)
// =========================================================
async function fetchKoreaEximbank(days){
  if (!KOREAEXIM_KEY) throw new Error('KOREAEXIM_API_KEY not configured');

  // 영업일 수 + 25% buffer (공휴일로 인한 EMPTY 응답 대비)
  const target = Math.ceil(days * 1.25);
  const dates = businessDaysBackward(target);
  const dateStrings = dates.map(formatDateYYYYMMDD);

  const baseUrl = 'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';

  const fetchOne = async (dateStr) => {
    const url = `${baseUrl}?authkey=${KOREAEXIM_KEY}&searchdate=${dateStr}&data=AP01`;
    try {
      const r = await fetchWithTimeout(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
      });
      if (!r.ok) return null;
      const data = await r.json();
      // Holiday/weekend: returns []
      if (!Array.isArray(data) || data.length === 0) return null;
      const usd = data.find(x => x.cur_unit === 'USD');
      if (!usd || usd.result !== 1) return null;

      const close = parseKRW(usd.deal_bas_r);
      if (!valid(close)) return null;

      const y  = dateStr.slice(0, 4);
      const mm = dateStr.slice(4, 6);
      const dd = dateStr.slice(6, 8);
      const tts = parseKRW(usd.tts);
      const ttb = parseKRW(usd.ttb);

      return {
        date: `${y}-${mm}-${dd}`,
        label: `${parseInt(mm, 10)}/${parseInt(dd, 10)}`,
        close,
        tts: valid(tts) ? tts : null,
        ttb: valid(ttb) ? ttb : null
      };
    } catch (err) {
      return null; // 개별 실패는 silent skip
    }
  };

  // 30+ 병렬 fetch
  const results = await Promise.allSettled(dateStrings.map(fetchOne));

  const series = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value) series.push(r.value);
  });

  if (series.length === 0) throw new Error('Korea Eximbank: no valid business days returned');

  // Sort ascending by date
  series.sort((a, b) => a.date.localeCompare(b.date));

  // Trim to requested days
  const trimmed = series.slice(-days);

  return {
    series: trimmed,
    source: 'koreaexim',
    source_url: baseUrl,
    raw_hash: sha256(JSON.stringify(trimmed.map(s => s.date + ':' + s.close)))
  };
}

// =========================================================
// Adapter 2: Frankfurter (ECB business-day rates) — FALLBACK
// =========================================================
async function fetchFrankfurter(days){
  const end = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - Math.ceil(days * 1.6));

  const isoDate = d => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const url = `https://api.frankfurter.dev/v1/${isoDate(start)}..${isoDate(end)}?base=USD&symbols=KRW`;
  const r = await fetchWithTimeout(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`Frankfurter HTTP ${r.status}`);
  const data = await r.json();
  const rates = data?.rates;
  if (!rates || typeof rates !== 'object') throw new Error('Frankfurter: malformed');

  const series = [];
  Object.keys(rates).sort().forEach(dateKey => {
    const close = rates[dateKey]?.KRW;
    if (valid(close)) {
      const [, mm, dd] = dateKey.split('-');
      series.push({
        date: dateKey,
        label: parseInt(mm, 10) + '/' + parseInt(dd, 10),
        close: Math.round(close * 100) / 100
      });
    }
  });
  if (series.length === 0) throw new Error('Frankfurter: no valid points');

  return {
    series: series.slice(-days),
    source: 'frankfurter',
    source_url: url,
    raw_hash: sha256(JSON.stringify(rates))
  };
}

// =========================================================
// Adapter 3: Yahoo Finance KRW=X — FALLBACK (rate-limited)
// =========================================================
function pickYRange(days){
  if (days <= 7)   return '5d';
  if (days <= 30)  return '1mo';
  if (days <= 90)  return '3mo';
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  return '2y';
}

async function fetchYFinance(days){
  const range = pickYRange(days);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1d&range=${range}`;
  const r = await fetchWithTimeout(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`YFinance HTTP ${r.status}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('YFinance: no chart.result');
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  if (!timestamps.length || !closes.length) throw new Error('YFinance: empty');

  const series = [];
  const len = Math.min(timestamps.length, closes.length);
  for (let i = 0; i < len; i++) {
    if (!valid(closes[i])) continue;
    const d = new Date(timestamps[i] * 1000);
    series.push({
      date: d.toISOString().slice(0, 10),
      label: (d.getMonth() + 1) + '/' + d.getDate(),
      close: Math.round(closes[i] * 100) / 100
    });
  }
  if (series.length === 0) throw new Error('YFinance: no valid points');

  return {
    series: series.slice(-days),
    source: 'yfinance',
    source_url: url,
    raw_hash: sha256(JSON.stringify(result.meta || {}))
  };
}

const ADAPTERS = [
  { name: 'koreaexim',   fn: fetchKoreaEximbank }, // 🇰🇷 Primary — 한국 공식
  { name: 'frankfurter', fn: fetchFrankfurter   }, // Fallback (ECB)
  { name: 'yfinance',    fn: fetchYFinance      }  // Last resort
];

// =========================================================
// Handler
// =========================================================
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 일별 종가는 영업일 마감 후만 변동 → 1시간 캐시 + 5분 SWR
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const daysRaw = req.query?.days ?? '30';
  const days = parseInt(daysRaw, 10);
  if (isNaN(days) || days < 1 || days > 730) {
    return res.status(400).json({
      success: false,
      error: 'days param must be integer 1-730',
      received: daysRaw
    });
  }

  const attempts = [];
  for (const adapter of ADAPTERS) {
    try {
      const t0 = Date.now();
      const out = await adapter.fn(days);
      const elapsed = Date.now() - t0;
      attempts.push({
        adapter: adapter.name,
        success: true,
        count: out.series.length,
        elapsed_ms: elapsed
      });
      return res.status(200).json({
        success: true,
        pair: 'USD/KRW',
        interval: '1d',
        count: out.series.length,
        requested_days: days,
        source: out.source,
        source_url: out.source_url,
        series: out.series,
        attempts,
        fetched_at: new Date().toISOString(),
        raw_hash: out.raw_hash
      });
    } catch (err) {
      attempts.push({
        adapter: adapter.name,
        success: false,
        error: err.message || String(err)
      });
    }
  }

  return res.status(503).json({
    success: false,
    error: 'All history adapters failed',
    attempts,
    requested_days: days,
    fetched_at: new Date().toISOString()
  });
}
