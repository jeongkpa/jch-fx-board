# Hermes Forecast Evaluation Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Record Hermes daily USD/KRW 3-day, 7-day, and 14-day direction calls; automatically evaluate them against realized USD/KRW; and show quantitative forecast-review metrics on the JCH FX dashboard.

**Architecture:** Extend the existing protected `/api/hermes-report` feed with forecast fields and add a new protected/readable evaluation API backed by the same Vercel KV storage pattern. The morning cron will POST both the 차상무님-facing report and structured direction calls; an evaluation routine will close matured calls when actual rates are available. The dashboard will render a compact “Hermes 방향성 복기” card with recent hit rates and latest evaluations.

**Tech Stack:** Vercel serverless functions, Vercel KV/Upstash REST API, single-file SPA `public/index.html`, Node built-in test runner, existing Naver/Korea Eximbank FX APIs.

---

## Product Scope

### In scope

1. Store structured forecast calls generated with each scheduled Hermes FX report.
2. Evaluate each call at 3, 7, and 14 calendar-day horizons by comparing `base_rate` to an actual USD/KRW reference rate.
3. Normalize labels into `up`, `neutral`, and `down` for scoring.
4. Use a neutral band so tiny changes are not over-counted as correct/incorrect.
5. Expose aggregate metrics and recent evaluations to the dashboard.
6. Add a dashboard card for quantitative review.
7. Add tests for normalization, scoring, storage shape, and API behavior.

### Out of scope for Phase 1

1. No automated FX purchase execution.
2. No modification to the dashboard `recommend()` buying algorithm.
3. No machine-learning model training.
4. No deterministic future rate target such as “3일 뒤 1,510원”.
5. No public display of internal score components unless explicitly requested.

---

## Approved Phase 1 Decisions

This plan is approved for Phase 1 implementation with the following resolved design choices:

1. **Evaluation horizon:** Use **calendar days**: `created_at + 3/7/14 days`. If the reference-rate API has no rate for the target calendar date, use the latest available business-day close on or before that target date. Store both `target_date` and `actual_date` so weekend/holiday fallback is auditable.
2. **Reference source:** Use the same public reference family already used by the dashboard: Naver current rate for same-day/latest and Korea Eximbank history for historical evaluation where available. Store `actual_source` on every evaluation record.
3. **Neutral band:** Use **±3.0원** for Phase 1. Actual change `> +3.0원` = `up`; `< -3.0원` = `down`; `-3.0원 <= change <= +3.0원` = `neutral`. Boundary values exactly +3.0원 or -3.0원 remain neutral.
4. **Partial-miss treatment:** Track `partial_miss` separately when a directional call (`up`/`down`) is followed by a neutral actual. A neutral forecast followed by a directional actual is a full `miss`. A direct opposite direction is a full `miss`.
5. **Headline metric:** Dashboard headline hit rate is strict `hit / evaluated`, where `evaluated` includes `hit`, `miss`, and `partial_miss`. Also show the `partial_miss` count separately so the metric is not overstated.
6. **Storage:** Use Vercel KV if configured; memory fallback remains development-only.
7. **Dashboard placement:** Add the card visibly below the existing Hermes recent report section. Do not hide the whole card inside “자세한 근거 보기”; the card itself should be compact, with recent-evaluation details allowed to be collapsed if space becomes tight.
8. **Dashboard tone:** Use “복기”, “방향성 평가”, “적중률” rather than “예언/예측 성공률”. Keep it decision-support oriented.

---

## Data Model

### Forecast record

```json
{
  "id": "fc_...",
  "report_id": "hr_...",
  "type": "usdkrw_direction_forecast",
  "created_at": "2026-05-20T08:30:00+09:00",
  "base_date": "2026-05-20",
  "base_rate": 1506.5,
  "rate_source": "naver",
  "report_title": "JCH FX 오전 8:30 보고",
  "calls": [
    {
      "horizon": "3d",
      "target_date": "2026-05-23",
      "raw_label": "상승 우위",
      "normalized_direction": "up",
      "rationale_tags": ["USD/KRW 단기 평균 상회", "달러 강세"]
    },
    {
      "horizon": "7d",
      "target_date": "2026-05-27",
      "raw_label": "중립~상승 부담",
      "normalized_direction": "up",
      "rationale_tags": ["상단 유지 부담"]
    },
    {
      "horizon": "14d",
      "target_date": "2026-06-03",
      "raw_label": "중립",
      "normalized_direction": "neutral",
      "rationale_tags": ["랜덤워크 우세"]
    }
  ],
  "status": "open"
}
```

### Evaluation record per call

```json
{
  "forecast_id": "fc_...",
  "report_id": "hr_...",
  "horizon": "3d",
  "base_date": "2026-05-20",
  "target_date": "2026-05-23",
  "evaluated_at": "2026-05-24T08:30:00+09:00",
  "base_rate": 1506.5,
  "actual_date": "2026-05-23",
  "actual_rate": 1512.0,
  "actual_source": "koreaexim",
  "rate_change": 5.5,
  "predicted_direction": "up",
  "actual_direction": "up",
  "result": "hit",
  "neutral_band": 3.0
}
```

### Aggregate metrics

```json
{
  "window": "last_30_evaluated_calls",
  "neutral_band": 3.0,
  "overall": { "evaluated": 30, "hit": 18, "miss": 9, "partial_miss": 3, "hit_rate": 0.6 },
  "by_horizon": {
    "3d": { "evaluated": 10, "hit": 7, "hit_rate": 0.7 },
    "7d": { "evaluated": 10, "hit": 6, "hit_rate": 0.6 },
    "14d": { "evaluated": 10, "hit": 5, "hit_rate": 0.5 }
  },
  "by_direction": {
    "up": { "evaluated": 12, "hit": 8, "hit_rate": 0.667 },
    "neutral": { "evaluated": 8, "hit": 5, "hit_rate": 0.625 },
    "down": { "evaluated": 10, "hit": 5, "hit_rate": 0.5 }
  }
}
```

---

## API Design

### 1. Extend `POST /api/hermes-report`

Allow optional forecast payload in the same report POST:

```json
{
  "title": "JCH FX 오전 8:30 보고",
  "markdown": "...",
  "details_markdown": "...",
  "rate": 1506.5,
  "source": "naver",
  "forecast": {
    "base_date": "2026-05-20",
    "base_rate": 1506.5,
    "rate_source": "naver",
    "calls": [
      { "horizon": "3d", "raw_label": "상승 우위", "direction": "up", "rationale_tags": ["달러 강세"] },
      { "horizon": "7d", "raw_label": "상승 부담", "direction": "up", "rationale_tags": ["위안화 약세"] },
      { "horizon": "14d", "raw_label": "중립", "direction": "neutral", "rationale_tags": ["이벤트 대기"] }
    ]
  }
}
```

Response should include `forecast_id` if stored.

### 2. New `GET /api/hermes-forecast-eval`

Returns forecast review state:

```json
{
  "success": true,
  "storage": "vercel-kv",
  "metrics": { ... },
  "recent_evaluations": [ ... ],
  "open_forecasts": [ ... ],
  "server_time": "..."
}
```

### 3. New `POST /api/hermes-forecast-eval`

Protected by `HERMES_REPORT_TOKEN`. Evaluates matured forecasts. Two modes:

1. Explicit actual payload for reliable cron-side evaluation:

```json
{
  "actuals": [
    { "date": "2026-05-23", "rate": 1512.0, "source": "naver" }
  ],
  "neutral_band": 3.0
}
```

2. Server-side best-effort evaluation using existing historical rate endpoint logic. This is Phase 1.5 if code reuse becomes too large.

---

## Dashboard UX Design

Add a card near the Hermes report section:

```text
Hermes 방향성 복기
최근 30건 평가 기준: 전체 적중률 60.0%

3일  63.3%   19/30
7일  56.7%   17/30
14일 50.0%   15/30

최근 평가
2026-05-20 3일 전망: 상승 우위 → 실제 +5.5원 → 적중
2026-05-17 7일 전망: 중립 → 실제 +1.2원 → 중립 적정
```

Empty state:

```text
평가 대기 중입니다. 3일 전망은 첫 보고 후 3일이 지나면 자동 복기됩니다.
```

UX rules:

- No emojis in 차상무님-facing dashboard card.
- Keep 17px+ readable text.
- Korean financial color convention: positive USD/KRW change = red, negative = blue.
- Do not show internal Direction Score by default.

---

## Task Plan

### Task 1: Add forecast normalization and scoring helpers

**Objective:** Create pure functions for direction normalization, target-date calculation, actual-direction classification, and hit/miss scoring.

**Files:**
- Create: `api/lib/forecast-eval.js`
- Test: `tests/forecast-eval.test.mjs`

**Acceptance criteria:**
- `normalizeDirectionLabel('상승 우위') === 'up'`
- `normalizeDirectionLabel('하락 여지') === 'down'`
- `normalizeDirectionLabel('중립~상승 부담') === 'up'` for Phase 1 conservative mapping.
- `classifyActualDirection(1506.5, 1509.4, 3) === 'neutral'`
- `classifyActualDirection(1506.5, 1510.0, 3) === 'up'`
- `scoreDirection('up', 'up') === 'hit'`
- `scoreDirection('up', 'down') === 'miss'`
- `scoreDirection('up', 'neutral') === 'partial_miss'`

### Task 2: Refactor shared KV storage utilities

**Objective:** Avoid duplicating KV REST helpers between report storage and forecast evaluation storage.

**Files:**
- Create: `api/lib/kv-store.js`
- Modify: `api/hermes-report.js`
- Test: existing `tests/hermes-report-api.test.mjs`

**Acceptance criteria:**
- Existing Hermes report API tests pass unchanged.
- Storage mode remains `vercel-kv` when KV env vars exist and `memory` otherwise.
- No token values are logged.

### Task 3: Store forecast payload with Hermes report POST

**Objective:** When `/api/hermes-report` receives `forecast`, normalize and persist it in a dedicated forecast list.

**Files:**
- Modify: `api/hermes-report.js`
- Modify: `tests/hermes-report-api.test.mjs`

**Acceptance criteria:**
- POST without `forecast` behaves exactly as today.
- POST with valid `forecast.calls` returns `forecast_id`.
- Invalid horizons are ignored or rejected with 400 depending on helper validation.
- Stored calls include `target_date` for 3d, 7d, 14d.

### Task 4: Add forecast evaluation API

**Objective:** Implement `GET/POST /api/hermes-forecast-eval` for metrics and matured-call evaluation.

**Files:**
- Create: `api/hermes-forecast-eval.js`
- Create/modify: `tests/hermes-forecast-eval-api.test.mjs`

**Acceptance criteria:**
- GET returns `{ success, storage, metrics, recent_evaluations, open_forecasts }`.
- POST requires valid token.
- POST evaluates matured calls using provided actuals and writes evaluation records.
- Repeated POST is idempotent for already evaluated `forecast_id + horizon`.

### Task 5: Add dashboard “Hermes 방향성 복기” card

**Objective:** Render forecast metrics and recent evaluations in `public/index.html`.

**Files:**
- Modify: `public/index.html`

**Acceptance criteria:**
- Card has an empty state when no evaluations exist.
- Card displays overall and horizon-specific hit rates when data exists.
- Recent evaluations show date, horizon, forecast label, actual change, and result.
- Font size remains 17px+ and mobile layout is readable.

### Task 6: Wire dashboard fetch and safe rendering

**Objective:** Fetch `/api/hermes-forecast-eval` on page load and periodic refresh, without breaking current report rendering.

**Files:**
- Modify: `public/index.html`

**Acceptance criteria:**
- API failure does not break the page.
- Existing Hermes recent report card still renders Markdown safely.
- Metrics card shows “복기 데이터 수신 대기” on fetch failure.

### Task 7: Update scheduled Hermes cron prompt

**Objective:** Ensure the morning report POST includes structured `forecast` payload and either triggers evaluation or posts actuals for matured calls.

**Files/Systems:**
- Hermes cron job prompt, not committed to repo.

**Acceptance criteria:**
- Discord delivery remains primary.
- Dashboard POST failure does not appear in 차상무님-facing report.
- Forecast payload includes `base_rate`, `base_date`, `rate_source`, and exactly 3 calls: 3d, 7d, 14d.

### Task 8: Verify locally and live

**Objective:** Run automated tests, syntax checks, API smoke tests, and live deployment verification.

**Commands:**

```bash
npm test -- --test-reporter=spec
python - <<'PY'
from pathlib import Path
html = Path('public/index.html').read_text()
start = html.index('<script>') + len('<script>')
end = html.index('</script>', start)
Path('/tmp/jch-fx-board-index-script.js').write_text(html[start:end])
print('extracted script chars', end-start)
PY
node --check /tmp/jch-fx-board-index-script.js
git diff --check
curl -fsS https://jch-fx-board.vercel.app/api/fx-rate | python -m json.tool | head -80
curl -fsS 'https://jch-fx-board.vercel.app/api/hermes-forecast-eval' | python -m json.tool | head -120
```

**Acceptance criteria:**
- Tests pass.
- JS syntax check passes.
- Live API returns expected shape after deploy.
- Existing `/api/hermes-report` still works.

---

## Kanban Priority

1. **P0 — Forecast evaluation design and acceptance criteria**
2. **P1 — Pure evaluation helpers and tests**
3. **P1 — Forecast storage in report API**
4. **P1 — Forecast evaluation API**
5. **P2 — Dashboard review card**
6. **P2 — Cron prompt update**
7. **P2 — Live verification and monitoring**

---

## Phase 1 Approval

The P0 design questions are resolved and this plan is ready for implementation.

| Decision area | Approved Phase 1 choice |
|---|---|
| Evaluation basis | Calendar-day horizons: 3d, 7d, 14d |
| Weekend/holiday handling | Use latest available business-day close on or before target date; store `actual_date` |
| Neutral band | ±3.0원, inclusive at both boundaries |
| `partial_miss` | Directional forecast followed by neutral actual; included in evaluated denominator, reported separately |
| Headline hit rate | Strict `hit / evaluated`; do not count `partial_miss` as a hit |
| Dashboard placement | Visible compact card below the Hermes recent report section |

Implementation may proceed without further product clarification unless Phase 1 scope changes.
