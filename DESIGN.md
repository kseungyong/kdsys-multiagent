# KDSys MultiAgent — 단기 개선 3건 설계서 (최종)

> 작성일: 2026-03-31
> 검증: OpenAI o3 + Gemini 2.5-pro (3 Rounds)

---

## 1. 프로젝트 개요

### 목표
kdsys-multiagent 오케스트레이터의 운영 안정성과 코드 품질을 높이기 위한 단기 개선 3건.

### 범위
1. **API 키 검증 및 Health 강화** — 서버 시작 시 Gemini/OpenAI/Anthropic 키 유효성 사전 검증
2. **PM2 프로세스 관리** — 자동 재시작, 로그 관리, Graceful Shutdown
3. **Jest 테스트 자동화** — 핵심 모듈 단위 테스트 + 통합 테스트 + CI

### 전제
- 현재 PM2 fork mode 단일 인스턴스 운영
- Tailscale VPN 내부망, 3대 Mac 연결
- 공유 메모리 API (port 3457) 운영 중

---

## 2. 아키텍처

```
PM2 (ecosystem.config.js)
  └─ server.js
       ├─ preflight.js ──→ Gemini/OpenAI/Anthropic 키 검증 (시작 시)
       ├─ GET /api/health (공개: status + uptime)
       ├─ GET /api/health/detail (JWT: 전체 상태)
       ├─ POST /api/health/recheck-keys (JWT + rate-limit)
       └─ Graceful Shutdown (SIGINT/SIGTERM)

Jest
  ├─ tests/unit/ (오프라인, CI GitHub Actions)
  └─ tests/integration/ (Tailscale 내부망, self-hosted runner)
```

---

## 3. 핵심 모듈 설계

### 3.1 `preflight.js` — API 키 사전 검증

```
runPreflight() → 3개 키 병렬 검증 (AbortController, 5초 타임아웃)
getKeyStatus() → 캐시된 결과 반환 (TTL: 1시간)
```

| 서비스 | 검증 방법 | 비용 |
|--------|-----------|------|
| Gemini | `GET /v1beta/models?key=` | 무료 |
| OpenAI | `GET /v1/models` | 무료 |
| Anthropic | 키 형식 검증 (sk-ant- prefix) | 무료 |

- 로그에 키 값 절대 미출력 (valid/invalid 상태만)
- 검증 실패해도 서버 정상 시작 (non-blocking, console.warn)

### 3.2 Health 엔드포인트

| 엔드포인트 | 인증 | 응답 |
|------------|------|------|
| `GET /api/health` | 없음 | `{ status: "ok", uptime: N }` |
| `GET /api/health/detail` | JWT | `{ apiKeys, pm2, bots, memoryApi, ... }` + `Cache-Control: no-store` |
| `POST /api/health/recheck-keys` | JWT + rate-limit | 키 재검증 → 캐시 갱신 |

- Shutdown 시 `/api/health` → `{ status: "shutting_down" }` + HTTP 503
- Rate-limit: IP별 분당 3회 (인메모리 Map, 단일 인스턴스 전제)
  - 클러스터 전환 시 Redis 기반으로 교체 계획

### 3.3 `ecosystem.config.js` — PM2 설정

```javascript
module.exports = {
  apps: [{
    name: 'kdsys-multiagent',
    script: 'server.js',
    instances: 1,              // fork mode
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,       // 3초
    max_memory_restart: '512M',
    kill_timeout: 15000,       // graceful shutdown 대기
    env: { NODE_ENV: 'production', PORT: 3456 },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './data/logs/error.log',
    out_file: './data/logs/out.log',
    merge_logs: true,
  }]
};
```

- `.env`로 시크릿 관리 (ecosystem에 키 미포함)
- kill_timeout: 15초 (graceful shutdown 10초 + 여유 5초)

### 3.4 Graceful Shutdown

```javascript
let isShuttingDown = false;

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[server] Graceful shutdown...');
  // 1. /api/health → 503 shutting_down (LB 즉시 제외)
  // 2. WebSocket 연결 종료
  wss.close();
  // 3. 진행 중 토론 상태 저장
  debateEngine.saveAll();
  // 4. HTTP 서버 종료 (in-flight 요청 완료 대기)
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000);
}
```

### 3.5 Jest 테스트

**단위 테스트 (오프라인):**

| 파일 | 테스트 항목 |
|------|-------------|
| `config.test.js` | 경로 존재, 기본값, DATA_PATH 오버라이드 |
| `summarizer.test.js` | extractSummary 규칙 패턴 (한국어/영어) |
| `shared-memory.test.js` | save/search/keywords/buildPriorContext |
| `debate-engine.test.js` | 합의 감지, Jaccard similarity, 라운드 제한 |

**통합 테스트 (RUN_INTEGRATION=true):**

| 파일 | 테스트 항목 |
|------|-------------|
| `openclaw-bridge.test.js` | ping, checkAll |
| `memory-sync.test.js` | syncConclusion → 공유 메모리 API |

**실행:**
```bash
npm test                           # 단위 테스트만
RUN_INTEGRATION=true npm test      # 전체
npm run test:watch                 # watch 모드
```

---

## 4. 시크릿 관리

- `.env` + `dotenv` 로딩 (기존)
- `.gitignore`에 `.env` 포함 (기존)
- `ecosystem.config.js`에 키 미포함
- preflight/health 로그에 키 값 미출력
- 장기: 프로덕션 시크릿 매니저(Vault 등) 고려

---

## 5. CI 파이프라인

```
GitHub Actions:
  Job 1: 단위 테스트 (ubuntu-latest)
    - npm ci
    - npm test
    - coverage report (70%+ gate)

  Job 2: 통합 테스트 (self-hosted, Tailscale 내부망)
    - RUN_INTEGRATION=true npm test
    - 에페머럴 환경, 장기 시크릿 미보관
```

---

## 6. 디렉토리 구조 (신규 파일)

```
kdsys-multiagent/
├── ecosystem.config.js    # [신규] PM2 설정
├── preflight.js           # [신규] API 키 검증
├── jest.config.js         # [신규] Jest 설정
├── DESIGN.md              # [신규] 이 문서
├── tests/
│   ├── unit/
│   │   ├── config.test.js
│   │   ├── summarizer.test.js
│   │   ├── shared-memory.test.js
│   │   └── debate-engine.test.js
│   └── integration/
│       ├── openclaw-bridge.test.js
│       └── memory-sync.test.js
├── server.js              # [수정] preflight + graceful shutdown + health 분리
└── package.json           # [수정] jest devDep + test scripts
```

---

## 리뷰 이력
- 총 리뷰 라운드: 3회
- OpenAI 최종 판정: APPROVED
- Gemini 최종 판정: APPROVED
- 확정 일시: 2026-04-01 00:30
