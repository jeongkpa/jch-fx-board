# jch-fx-board

JCH 시스템 외환(FX) 의사결정 대시보드.

**🟢 Live**: https://jch-fx-board.vercel.app

---

## 누가 사용하나

| 역할 | 사용 시점 | 핵심 정보 |
|------|----------|----------|
| 차상무님 (FX 책임) | 매일 09:00 / 17:00 | 오늘 만기 도래 + 매입 추천 |
| 회장님 / 사장님 | 주간 보고 | 총 미체결 + 헷지 커버리지 |
| 박정기 (AX TF) | 운영 / 모니터링 | 데이터 정합성, 에러 |
| 5인 TF | Phase 1 이후 | (NAS 도착 후 활성화) |

---

## 핵심 데이터 소스 (현재)

| 데이터 | Source | 갱신 주기 |
|--------|--------|----------|
| **실시간 환율** | 네이버 finance scrape | 1분 polling |
| **30일 환율 차트** | 🇰🇷 **한국수출입은행 API** (PRIMARY) | 영업일 11AM KST |
| Cross-check | yfinance KRW=X | 1분 |
| Vendor / 만기 / 미체결 | 차상무님 워크북 v2 (mock) | NAS 도착 후 자동 sync 예정 |

---

## 기술 스택

- **Frontend**: 단일 페이지 SPA (`public/index.html`, HTML+CSS+JS embed)
- **Design**: Pretendard Variable + Toss-inspired design tokens
- **Charts**: Chart.js 4.4.1 (CDN)
- **API**: Vercel Serverless Functions (Node ESM)
- **Deploy**: Vercel (`main` push → auto-deploy)

---

## 디렉토리

```
jch-fx-board/
├── public/
│   └── index.html          ← 단일 SPA (CSS+JS 모두 inline)
├── api/
│   ├── fx-rate.js          ← 현재 환율 (네이버 primary)
│   └── fx-history.js       ← 30일 환율 (한국수출입은행 primary)
├── vercel.json             ← Headers + cleanUrls
├── .gitignore
├── README.md               ← 이 파일
└── HERMES_HANDOVER.md      ← 🤖 Hermes Agent 운영 가이드
```

---

## 로컬 개발

```bash
# Vercel CLI 설치 (한 번만)
npm i -g vercel

# 로컬 서버
cd jch-fx-board
vercel dev

# 배포 (자동: main push)
git push origin main
```

---

## 🤖 Hermes Agent 안내

이 저장소는 **Hermes Agent**가 직접 수정 가능. 작업 가이드는:

→ **[HERMES_HANDOVER.md](./HERMES_HANDOVER.md)** 필독

---

## 관련 문서 (Vault)

- 프로젝트 KB: `~/Documents/JCH_AI/30. Projects/2026-Q2-FX-DSS-PoC/planning/project-knowledge-base.md`
- Hermes 학습 컨텍스트: `~/Documents/JCH_AI/30. Projects/2026-Q2-FX-DSS-PoC/data/hermes-learning/01-CONTEXT.md`
- 차상무님 워크북 스키마: `~/Documents/JCH_AI/30. Projects/2026-Q2-FX-DSS-PoC/data/hermes-learning/02-WORKBOOK-SCHEMA.md`
- 4차 미팅 분석: `~/Documents/JCH_AI/30. Projects/2026-Q2-FX-DSS-PoC/meetings/2026-05-12-차상무님-4th-Meeting.md`

---

## License / 책임

내부 도구. 외부 공개 X.
대시보드의 모든 매수 추천은 **참고용**이며, 최종 결정은 차상무님께서 판단하십니다.

---

*Maintained by 박정기 (AX TF Team Lead). v1.0 (2026-05-19).*
