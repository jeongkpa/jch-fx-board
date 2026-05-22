# Changelog

JCH FX Dashboard (`jch-fx-board`) 개발 진척 시간순 기록.

본 문서는 [Keep a Changelog](https://keepachangelog.com/) + [Semantic Versioning](https://semver.org/) 컨벤션을 따릅니다.
모든 날짜는 KST (UTC+9) 기준.

---

## [Unreleased] — 다음 변경 예정

### Planned
- IBK 기업은행 실 매수환율 API 연동 (D20)
- Supabase 환율 시계열 영구 저장 (D25)
- n8n 자동화 파이프라인 (시간당 환율 인제스천)
- NAS 자동 동기화 (차상무님 워크북 → DB → 대시보드)
- Hermes Agent 알고리즘 학습/개선 dashboard

---

## [1.3.2] — 2026-05-22 (D12)

### 🐛 Fixed
- **1개월 차트 baseline 라벨 잘림** (`65130b8`)
  - 증상 (차상무님 보고): "1개월 점선 짤려서 안보이는데"
  - 원인: 전일 종가 (예: 1503.40)가 Y축 max 근처 → label이 chart top 위로 솟아 잘림
  - 수정: baseline value를 **전일 종가 → 30일 평균값**으로 변경
    - 새 함수 `calc30DAverage()` (sanity filter 800-2000)
    - `renderM1Chart` + `fetchHistory30D` 둘 다 적용
    - label: "전일 X.XX" → "30일 평균 X.XX"

### 🔬 Verification
- 평균값 = 1,481.39 (실측 일치 100%)
- baseline yPx = 58 (chart height 106 중 중간 ≈ 55%)
- `label_visible = true` (chart top 7px + 15px 마진 충족)
- 현재 환율 1,508.10 vs 평균 1,481.39 → "1개월 강세 구간 +26.71원" 의사결정 anchor

### 💡 의미
- 30일 평균 baseline = 차상무님 의사결정 더 유용한 anchor
  - 전일 1포인트 변동에 흔들리지 않음
  - 1개월 추세 정중앙 → 강세/약세 직관적 판단

---

## [1.3.1] — 2026-05-21 (D11)

### 🐛 Fixed
- **새로고침 시 mock 차트 잠시 노출** (`797c61e`)
  - 증상: 페이지 로드 직후 5/12 mock 데이터 (1485~1492 범위) 잠시 표시 → fetchHistory30D 완료 시 한국수출입은행 실데이터 (1506+)로 교체되며 차트 모양 변화 → 사용자 인지 시간 1~2분
  - 원인: `RATES_30D` const 배열이 30개 mock 값으로 hardcoded되어 페이지 로드 즉시 mock 차트 출력
  - 수정: 빈 배열로 시작 + `localStorage` 캐시 `jch_30d_cache_v1` (24h TTL)
  - 효과: 두 번째 방문부터 즉시 어제 데이터 표시 (fresh fetch는 백그라운드, 사용자 거의 인지 X)

- **Hero intraday 차트 KST 09:00 분기** (`1742d41`)
  - 요구사항 (차상무님): "한국시간 09:00 이후엔 전날 데이터 없애고 오늘 데이터만"
  - 수정: `rebuildHeroChart()`에 `nowKstHour >= 9` 조건 추가
  - 09:00 전 → 전날 종가 flat (1503.80 등) / 09:00 후 → 오늘 snapshots만

- **TODAY_SNAPSHOTS 어제 데이터 누적** (`1cbdabd`)
  - 진단: `/api/fx-intraday`가 24h+ 누적 snapshots 반환 (500개, 어제 자정~오늘 14:10 모두)
  - 결과: "09시 이후 룰"이 무력화 (어제 자정~새벽 ~ 오늘 다 표시됨)
  - 수정: `rebuildHeroChart()`에 KST 오늘 날짜 (`YYYY-MM-DD`) 필터 추가
  - 매일 KST 자정 자동 reset (별도 cron 不요)

- **KST 09시 이전 새벽 snapshots 제외** (`de91253`)
  - 1단계 fix 후에도 KST 00:29~08:59 새벽 글로벌 시장 데이터 차트 노출
  - 추가 조건: `sKstHour >= 9` (KRX 거래 시간만)
  - 결과: 차트가 정확히 09:00부터 현재까지만 표시 (예: 214 points / 14:14 시점)

### ✨ Added
- **localStorage 캐시** (`jch_30d_cache_v1`, 24h TTL)
  - 구조: `{ v: number[], l: string[], ts: number }`
  - fetchHistory30D 완료 시 자동 저장
  - 두 번째 방문 시 cache 우선 적용 → fresh fetch 백그라운드

### 🔬 Verification (Claude-in-Chrome direct browser eval)
- T+0.1s ~ T+3s 시간대별 snapshot 캡처
- 차트 라벨 / 픽셀 위치 / 데이터 값 100% 일치 확인
- KST 09시 이전 라벨 수: 0 (의도 부합)

---

## [1.3.0] — 2026-05-20 (D10)

### 🐛 Fixed
- **Chart cubic spline overshoot** — 1개월 차트에서 데이터 값이 시각적으로 잘못 보이던 문제 해결 (`a5d7744`)
  - 증상: "1489원이 1510원보다 위에 있다"는 사용자 보고
  - 원인: Chart.js `tension: 0.35` default cubic spline mode가 급변 구간에서 overshoot
  - 수정: `cubicInterpolationMode: 'monotone'` 추가 → 곡선이 데이터 점을 절대 넘지 않음
  - 추가 UX: 마지막 점(오늘)에 4px dot 표시 (시각 anchor)

- **1개월 차트 5/19 데이터 보존** (`87a3965`)
  - 증상: 한국수출입은행이 오늘 데이터 안 줄 때 (11AM 전) 5/19 값이 라이브로 덮어쓰여 사라짐
  - 수정: 한국수출입은행 last가 오늘이면 override / 아니면 라이브를 새 entry '오늘'로 추가

- **1개월 차트 끝점 race condition** (`26c6274`)
  - 증상: `fetchLiveRate`가 `fetchHistory30D`보다 먼저 완료될 때 chart 끝점이 한국수출입은행 11AM 값으로 표시
  - 수정: `fetchHistory30D` 데이터 적용 후 라이브 환율이 이미 있으면 마지막 점 재적용

- **Hero intraday 차트 09시 점프** (`87a3965`)
  - 증상: 00:00 → 09:26 사이가 smooth curve로 부드럽게 올라가 보임 (실제는 09시 점프)
  - 수정: 첫 snapshot이 09시 이후면 08:59에 어제 종가 boundary 추가

### ✨ Added
- **1개월 차트 baseline (전일 종가)** (`8db7bca`)
  - Chart.js custom plugin `baselinePlugin` 추가
  - Dashed horizontal line + 우측 라벨 ("전일 1503.40 (5/19)")
  - 시각 anchor 제공 → 어제 대비 오늘 위치 직관적 파악
  - Chart height 64px → 120px 확장 (가독성)

- **Hero intraday chart KV 누적** (`33704b0`)
  - Vercel KV (Redis) 기반 시간당 환율 스냅샷
  - `api/fx-intraday.js` POST/GET endpoint
  - 09시 이전: 어제 종가 flat / 09시 이후: 라이브 누적

### 🔧 Changed
- Diagnosis & verification: Claude-in-Chrome으로 직접 브라우저 검증 → JS eval로 pixel 위치까지 확인
- 데이터 정합성 100% 보장 (min=1450.8 / max=1510.3 / 30 entries 모두 정확)

---

## [1.2.0] — 2026-05-19 (D9 저녁)

### ✨ Added
- **Outlook card 토스 스타일 재디자인** (`4c0c336`)
  - Hermes가 만든 v1 디자인 (4가지 colored background) → Toss v2 (subtle gray + 텍스트 색상)
  - Font weight 정리: 800/900 → 500/600/700
  - 단일 subtle 배경 + 1px divider lines
  - 모바일 breakpoint 자연스러운 변환
  - 색상 의미는 `.outlook-direction` 텍스트에만 적용

### 🐛 Fixed
- **Vendor 테이블 현재환율을 매매기준율로 통일** (`7aa841c`)
  - 이전 버그: `CURRENT_RATE = tt_send` (송금보내실때 1,522.60)
  - 차상무님은 IBK에서 매수 → 송금보내실때 무관
  - 수정: `CURRENT_RATE = base_rate` (매매기준율 1,507.90)
  - 매매기준율 = 서울외국환중개 = ERP 환율 = 워크북 "원가환율"
  - 갭 계산이 회계 손익과 일치 + Hero 환율과 vendor 테이블 일관성

- **R12M 롤링 tag 제거** (`759c37b`)
  - 헷지 커버리지 카드의 불필요한 tag 제거

### 🤖 Hermes Agent 협업 (5/19 새벽 자동 commit)
- `b9e1021` feat: Hermes forecast evaluation dashboard
- `011012a` fix: hide Hermes review behind footer button
- `cfc0f51` feat: Hermes short-term outlook card
- `e28f7eb` fix: remove confidence wording
- `1e809cb` feat: Hermes market signal badge
- `8794b5c` feat: render Hermes reports as markdown
- `6968761` feat: Hermes report dashboard feed

### 📚 Infra
- GitHub repo 생성: https://github.com/jeongkpa/jch-fx-board (public)
- Vercel ↔ GitHub auto-deploy 연결
- Hermes Agent를 collaborator로 추가 → direct push to main
- Vercel KV (Redis) 활성화 → Hermes report 영구 저장
- 환경변수: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KOREAEXIM_API_KEY`, `HERMES_REPORT_TOKEN`

---

## [1.1.0] — 2026-05-19 (D9 오전)

### ✨ Added
- **한국수출입은행 매매기준율 API 어댑터** — Primary source
  - `/api/fx-history` 한국수출입은행 PRIMARY → Frankfurter Fallback → yfinance Last Resort
  - 30 영업일 backward sweep, Promise.allSettled 병렬 fetch
  - TTS / TTB도 함께 수신 (향후 활용)
  - 한국 공식 매매기준율 = 서울외국환중개 동일

### 🔧 Changed
- 30일 환율 차트가 Frankfurter ECB cross-rate → 한국수출입은행 공식 매매기준율로 교체
- 데이터 정확도: 이전 ECB 기반 ±2원 오차 → 한국 시장 매매기준율 정확
- 1개월 변동 표시 정확도 ↑ (1503.40 → 1510.20 = +6.80원 — 실측 한국 시장)

---

## [1.0.0] — 2026-05-12 ~ 5/19 (D2~D9, 초기 배포)

### ✨ Added
- **Toss 스타일 단일 페이지 대시보드** (`public/index.html`)
  - 1280×720 Hero card + 3 metric cards + Vendor 테이블 + 선물환 포지션 + 최근 체결
  - Pretendard Variable 폰트 + Tailwind-free custom CSS tokens
  - 50대 시니어 가독성: 17px+ base font, tabular-nums 적용
  - 모바일 breakpoint (768px) 지원
  - 한국 금융 컨벤션: 상승=빨강 / 하락=파랑

- **네이버 finance scraper** (`/api/fx-rate`)
  - 1분 polling, base_rate / tt_send / tt_receive / cash_buy / cash_sell
  - yfinance cross-check
  - SHA256 source hashing

- **Mock data (워크북 v2 5/18 기반)**
  - 13 vendor (GIGABYTE / AMD / PNY V-COLOR / BIOSTAR / CommScope / ALSEYE / BOE / Perfect Display / OCEAN / HKC / KTC / Changjia / SANC)
  - § 3.5 AI 매수 추천 알고리즘 (5단계 분기: 100/80/70/50/보류)
  - 최근 체결 7건, 선물환 포지션 월별 분포

- **데이터 정합성**
  - § 3.5 차상무님 verbatim 알고리즘 그대로 구현
  - 모든 숫자에 출처 (셀 위치 또는 API source) 부착
  - Cross-check (네이버 vs yfinance) 자동 검증

### 🚀 Deployed
- Vercel: https://jch-fx-board.vercel.app
- 6 D7 users 접근 가능 (회장님/사장님/차상무님/이규림/소수석님/박정기)

---

## 📚 디버깅 / Lessons Learned

### 🪤 발견된 함정들

1. **Vercel serverless의 in-memory 저장은 deploy마다 wipe** (2026-05-19)
   - Hermes report POST 데이터가 dashboard에서 사라짐
   - 해결: Vercel KV (Redis) 또는 Supabase 영구 저장
   - 룰: storage='memory'를 production에서 발견하면 즉시 알림

2. **Race condition 패턴** (2026-05-20)
   - 두 async fetch가 같은 array를 mutate할 때
   - `fetchLiveRate` (1초)와 `fetchHistory30D` (1.5초) 병렬 실행
   - 완료 순서에 따라 마지막 entry 값이 결정됨
   - 해결: 모든 mutation path에서 라이브 값 보존 로직 추가

3. **Chart.js cubic spline overshoot** (2026-05-20)
   - `tension: 0.35` default mode가 급변 구간에서 곡선이 데이터 점을 넘김
   - 사용자 시각적 혼란 ("1489 > 1510") — 데이터는 정확하지만 곡선 모양 이상
   - 해결: `cubicInterpolationMode: 'monotone'` — 데이터 점 절대 넘지 않음

4. **두 다른 시장 환율 비교** (2026-05-19)
   - Vendor 테이블 "현재환율"이 네이버 송금보내실때 (tt_send)
   - 차상무님은 IBK에서 매수 → tt_send 무관
   - 해결: 매매기준율 (base_rate) 통일 — ERP 환율과 동일

5. **Frankfurter ECB cross-rate ≠ 한국 시장 환율** (2026-05-19)
   - 한국 시장 마감과 0.5~2원 차이
   - Cross-computed (USD/EUR × EUR/KRW)
   - 해결: 한국수출입은행 API primary로 교체

6. **Hermes hallucination** (2026-05-20)
   - "박변호사 시황 분석" 같은 존재하지 않는 인물이 보고에 등장
   - 해결: 사용자 신고 시 vault 전체 grep + 즉시 제거
   - 룰: Hermes는 검증된 인물/source만 인용

7. **Mock 초기값 즉시 노출 위험** (2026-05-21)
   - Hardcoded mock 배열 (5/12 RATES_30D)이 페이지 로드 즉시 차트로 출력
   - fetchHistory30D 완료 전까지 잘못된 데이터 표시
   - 해결: 빈 배열로 시작 + localStorage 캐시 (24h TTL)
   - 룰: production에서 hardcoded mock 사용 시 반드시 placeholder 또는 cache 동반

8. **KV 누적 시계열에서 어제 데이터 섞임** (2026-05-21)
   - `/api/fx-intraday`가 24h+ 누적 snapshots 반환
   - frontend에서 "오늘만" 의도해도 KV에 들어있는 어제 데이터까지 표시됨
   - 해결: frontend에서 KST 날짜 + 시간 (`YYYY-MM-DD` + hour >= 9) 기반 필터
   - 룰: KV/Redis 시계열 사용 시 frontend timezone 정합성 검증 필수

9. **Chart baseline 라벨 잘림** (2026-05-22)
   - 전일 종가가 Y축 max 근처면 label이 chart top 위로 솟아 잘림
   - 가변 값 (전일 1포인트)을 baseline에 쓰면 위치 예측 불가
   - 해결: 통계적으로 중간에 위치할 값 사용 (예: 30일 평균)
   - 룰: chart baseline은 데이터 범위 mid-point 근처에 위치하는 값 권장 (avg, median 등)

### 🛡 적용된 안전장치

- **데이터 검증**: API 응답 sanity (800~2000 KRW), SHA256 hash, ISO 8601 dates
- **Race condition fix**: 모든 mutation path에서 살아있는 라이브 값 보존
- **Chart 정확성**: monotone interpolation + 명시적 마지막 점 표시
- **출처 명시**: 모든 숫자에 source label (셀 위치 또는 API)
- **Fallback adapter**: Primary 실패 시 자동 secondary/tertiary
- **사용자 시각 anchor**: baseline reference line (전일 종가)

---

## 🔗 관련 자원

- **Live Production**: https://jch-fx-board.vercel.app
- **GitHub**: https://github.com/jeongkpa/jch-fx-board
- **D10 보고 deck**: https://jch-d10-brief.vercel.app
- **WBS 보드**: https://jch-wbs.vercel.app
- **회장님 4/29 슬라이드**: https://jch-hermes.vercel.app
- **프로젝트 KB**: `~/Documents/JCH_AI/30. Projects/2026-Q2-FX-DSS-PoC/planning/project-knowledge-base.md`
- **Hermes 핸드오버**: [`HERMES_HANDOVER.md`](./HERMES_HANDOVER.md)
- **운영자**: 박정기 (jeongkpa) · support@gracevantage.com
