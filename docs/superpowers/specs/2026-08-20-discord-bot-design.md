# Discord Interactions Bot Design Specification

- Date: 2026-08-20 KST
- Topic: Serverless Discord Interactions Bot for BGMS
- Hosting: Vercel Serverless (Next.js App Router: `/api/discord/interactions`)
- Cost: 0 KRW (Stateless HTTP Interactions, DB-first caching, No Direct LLM in Discord)

---

## 1. 개요 및 목적
1. 목적: 디스코드 서버 내 배틀그라운드 게이머들이 슬래시 커맨드로 빠르게 전적/최근 매치 요약을 조회하고, 상세 3D 리플레이 및 AI 정밀 코칭을 보기 위해 웹사이트로 유입되도록 유도하는 무인 바이럴 봇 구축.
2. 비용 및 수익성 방어 원칙:
   - 디스코드 내에서는 Gemini LLM API를 직접 호출하지 않고, 기존 DB 캐시 및 전술 지표(AnalysisEngine 산출값)만 0.2~0.3초 내 초고속 응답.
   - 디스코드 메시지 하단에 웹사이트 링크 버튼을 배치하여 유저가 웹으로 진입해 광고 시청 및 AI 코칭을 이용하도록 유입 퍼널(Funnel) 극대화.
   - 24시간 상시 가동 서버리스 구조(Vercel HTTP Webhook)로 인프라 유지비 0원 달성.

---

## 2. 시스템 아키텍처 및 보안

```
[Discord User]
       │ Slash Command (/전적, /방금판, /연동)
       ▼
[Discord Gateway Server]
       │ HTTP POST (Interaction Payload)
       ▼
[Next.js API: /api/discord/interactions]
       │ ed25519 Signature Verification (tweetnacl)
       ▼
[Command Router & Player Identity Resolver]
  ├─ 1순위: 명령어 인자 직접 입력
  ├─ 2순위: discord_user_links 매핑 테이블 조회
  └─ 3순위: Discord Guild Nickname(서버 별명) 자동 감지
       │
[Internal Service Call: DB Cache & AnalysisEngine]
       │ (0.3s 이내 응답)
       ▼
[Discord Interaction Response (Embed + Link Buttons)]
       │
[사용자 웹사이트 방문: /stat?nickname=...&matchId=...]
```

### 2.1 보안 및 유효성 검증
- ed25519 서명 검증: Discord에서 전송한 X-Signature-Ed25519 및 X-Signature-Timestamp 헤더를 tweetnacl로 검증. 위조된 요청은 401 Unauthorized 즉시 반환.
- PING/PONG 핸들링: Discord 등록 시 전송되는 type: 1 (PING) 요청에 type: 1 (PONG)으로 즉시 응답.

### 2.2 필요 환경변수
- DISCORD_APPLICATION_ID: Discord Developer Portal 애플리케이션 ID
- DISCORD_PUBLIC_KEY: Interaction 서명 검증용 Public Key
- DISCORD_BOT_TOKEN: 슬래시 커맨드 일괄 등록/수정용 봇 토큰 (CLI 스크립트용)
- NEXT_PUBLIC_APP_URL: 웹사이트 기본 URL (예: https://bgms.kr)

---

## 3. 데이터베이스 스키마 (discord_user_links)

```sql
create table if not exists public.discord_user_links (
  discord_user_id text primary key,
  pubg_nickname text not null,
  pubg_platform text not null default 'steam',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discord_user_links_nickname_idx
  on public.discord_user_links (pubg_platform, lower(btrim(pubg_nickname)));

alter table public.discord_user_links enable row level security;

-- service_role만 읽기/쓰기 허용
create policy discord_user_links_service_role_all
  on public.discord_user_links
  to service_role
  using (true)
  with check (true);
```

---

## 4. 슬래시 커맨드 상세 명세

### 4.1 /연동 [배그닉네임] [플랫폼(선택)]
- 설명: 디스코드 계정과 배틀그라운드 닉네임을 1회 연동하여 향후 닉네임 입력 없이 명령어 사용.
- 옵션:
  - nickname (문자열, 필수): 배그 닉네임
  - platform (선택지: steam, kakao, 콘솔 등, 기본값: steam)
- 결과: 연동 완료 안내 메시지

### 4.2 /전적 [닉네임(선택)] [플랫폼(선택)]
- 동작:
  - 닉네임 미입력 시 discord_user_links 조회 -> 없으면 디스코드 서버 별명 사용.
  - 최근 20경기 기준 티어, KDA, 승률, 딜량, 1:1 승률 요약 카드 출력.
- 버튼 액션:
  - [웹에서 전체 전적 & AI 스타일 보기] -> https://bgms.kr/stat?nickname={encoded}&platform={platform}

### 4.3 /방금판 [닉네임(선택)] [플랫폼(선택)]
- 동작:
  - 가장 최근 1경기 기본 정보(순위, 맵, 킬, 딜량, 팀 내 비중) 및 핵심 전술 팩트(백업 딜레이, 1:1 승률, 고립도) 출력.
- 버튼 액션:
  - [이 판 AI 매운맛 코칭 & 3D 리플레이 보기] -> https://bgms.kr/stat?nickname={encoded}&platform={platform}&matchId={matchId}

---

## 5. 구현 컴포넌트 목록
1. app/api/discord/interactions/route.ts: Discord Interactions Webhook 수신, 서명 검증, 커맨드 라우팅.
2. lib/discord/verify.ts: ed25519 서명 검증 유틸리티.
3. lib/discord/commands/: link.ts, stats.ts, recentMatch.ts 커맨드 핸들러.
4. lib/discord/userResolver.ts: 닉네임 3단계 감지(인자 -> DB 연동 -> 서버 별명) 모듈.
5. scripts/register_discord_commands.ts: Discord API에 슬래시 커맨드 글로벌 등록용 CLI 스크립트.
6. supabase/migrations/20260820120000_discord_user_links.sql: Supabase 매핑 테이블 마이그레이션.

---

## 6. 검증 계획
1. 단위 테스트:
   - tests/discord-verify.test.ts: ed25519 서명 유효/무효 검증 테스트.
   - tests/discord-commands.test.ts: 각 커맨드별 Embed 생성 및 Link 버튼 포맷 테스트.
   - tests/discord-user-resolver.test.ts: 3단계 닉네임 감지 우선순위 테스트.
2. 엔드투엔드 검증:
   - Discord PING/PONG 요청 200 반환 검증.
   - 실제 PUBG API/DB 캐시 연동 응답 시간 1초 미만 검증.
