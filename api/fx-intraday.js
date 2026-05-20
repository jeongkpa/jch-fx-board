// /api/fx-intraday?date=YYYY-MM-DD — KV에 누적된 오늘 환율 snapshot 시계열 반환
// /api/fx-rate가 호출될 때마다 KV에 60s throttled snapshot 저장됨.
// 이 endpoint는 그것을 읽어 chart 그리는 용.
//
// 차트 시계열 구성 원칙 (frontend에서 합성):
//   00:00 (전날 종가 = PREVIOUS_RATE) → 09:00 직전까지 flat
//   09:00 ~ 현재까지 실측 snapshot 값들 (1분 throttle)

function kvAvailable(){
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvRequest(path){
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const r = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
  return r.json();
}

async function kvGet(key){
  const data = await kvRequest(`get/${encodeURIComponent(key)}`);
  if (!data?.result) return null;
  if (typeof data.result === 'string') {
    try { return JSON.parse(data.result); } catch { return data.result; }
  }
  return data.result;
}

function kstToday(now = new Date()){
  const kst = new Date(now.getTime() + 9*60*60*1000);
  return kst.toISOString().slice(0, 10);
}

function isValidDate(s){
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 1분 fresh + 30초 SWR (대시보드 1분 polling과 align)
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const dateParam = req.query?.date;
  const date = (dateParam && isValidDate(dateParam)) ? dateParam : kstToday();

  if (!kvAvailable()) {
    return res.status(503).json({
      success: false,
      error: 'KV storage not configured',
      date,
      snapshots: []
    });
  }

  try {
    const key = `fx:intraday:${date}`;
    const list = await kvGet(key);
    const snapshots = Array.isArray(list) ? list : [];

    return res.status(200).json({
      success: true,
      date,
      count: snapshots.length,
      first_ts: snapshots[0]?.ts ?? null,
      last_ts: snapshots[snapshots.length - 1]?.ts ?? null,
      snapshots,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      success: false,
      error: err.message || String(err),
      date,
      snapshots: []
    });
  }
}
