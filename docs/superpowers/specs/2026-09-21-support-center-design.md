# BGMS 고객센터 및 전적 비공개 문의 설계

작성일: 2026-09-21
상태: 사용자 설계 승인 완료. 구현·배포 전 문서.

## 1. 합의한 목표

BGMS에서 이메일로 받던 전적 비공개 요청을 사이트 내부의 비공개 고객센터로 전환한다. 공개 FAQ와 로그인 사용자 전용 1:1 문의를 제공하고, 관리자만 문의 내용·증빙·처리 이력을 볼 수 있게 한다. 전적 비공개 요청은 PUBG 계정 소유권을 완전한 자동 인증으로 증명할 수 없으므로, 인게임 프로필 또는 최근 전적 화면 스크린샷을 필수 증빙으로 받아 관리자 수동 검증 후 처리한다.

성공 기준:

- 비로그인 사용자는 FAQ만 볼 수 있고 1:1 문의 내용에는 접근할 수 없다.
- 사용자는 본인 문의와 관리자 답변만 확인한다.
- 비공개 요청은 플랫폼·닉네임·서버가 조회한 `account_id`·스크린샷을 함께 보관한다.
- 검증 완료 전에 기존 비공개 플레이어 목록을 변경할 수 없다.
- 관리자는 문의 답변, 상태 변경, 비공개 등록을 한 흐름에서 처리하고 감사 로그를 남긴다.
- 이메일을 보내지 않고 기존 BGMS 알림과 고객센터 화면으로 답변을 전달한다.

## 2. 현재 코드 기반과 제약

- 커뮤니티는 `/board`와 `posts/comments`를 사용하는 공개 게시판이다. 게시판 RLS·비회원 작성·공개 이미지 저장소는 개인정보 문의와 분리한다.
- 인증은 Supabase Auth와 `profiles`를 사용하고, `profiles.role = 'admin'`이 관리자 권한 기준이다.
- 관리자 페이지는 `/admin/*`가 미들웨어로 보호되며, API에는 `withAuthGuard`와 `requireAdmin`이 있다.
- 전적 비공개 목록은 `system_settings.private_players_list`와 관리자 API로 관리된다. 기존 `addPrivatePlayer`를 재사용하되 고객센터 처리 이력과 연결한다.
- 기존 알림 테이블의 `post_id`는 nullable이므로 고객센터 알림을 추가할 수 있다. 헤더 알림 클릭은 게시글과 문의를 구분한다.
- 게시판 이미지 버킷 `board-images-v2`는 공개 버킷이므로 스크린샷 증빙에 재사용하지 않는다.
- PUBG 공식 문서는 API 키를 사용하는 서버 호출과 닉네임/`account_id` 조회를 설명한다. 사용자 OAuth 소유권 검증을 전제로 하지 않는다. API 조회 결과는 대상 식별에만 사용한다. [PUBG API 키 문서](https://documentation.pubg.com/en/api-keys.html), [플레이어 조회 문서](https://documentation.pubg.com/en/getting-started.html)

## 3. 선택한 접근과 비범위

기존 게시판에 비공개 카테고리를 넣지 않고 전용 고객센터를 만든다.

- 사용자 진입점: `/support`
- 사용자 문의 상세: `/support/[ticketId]`
- 관리자 화면: `/admin/support`
- FAQ와 문의 데이터는 별도 `support_*` 테이블로 관리한다.
- 증빙은 별도 private Storage 버킷에 저장한다.

이 구조는 공개 게시물 검색·댓글·이미지 정책과 개인정보 문의를 분리하고, 향후 계정 문의나 신고 이슈를 추가할 수 있다. 외부 티켓 SaaS, 이메일 발송, PUBG 계정 로그인 연동은 이번 범위에 포함하지 않는다. 비로그인 1:1 문의도 지원하지 않는다.

## 4. 제품 흐름

### 4.1 사용자

1. 푸터·모바일 메뉴·마이페이지의 `고객센터` 링크로 `/support`에 들어간다.
2. FAQ는 비로그인 상태에서도 카테고리 필터와 검색으로 조회한다.
3. `1:1 문의하기` 또는 `내 문의`는 로그인하지 않은 경우 로그인 화면으로 보낸다.
4. 문의 작성 시 유형·제목·본문을 입력한다. `전적 비공개 요청`이면 플랫폼(`steam` 또는 `kakao`)과 PUBG 닉네임을 입력한다.
5. 서버가 PUBG 플레이어를 조회해 canonical nickname과 `account_id`를 반환하고, 사용자가 대상을 확인한다.
6. 인게임 프로필 또는 최근 전적 화면에서 닉네임·플랫폼이 보이는 PNG/JPEG/WebP 스크린샷을 최소 1개 첨부한다. 증빙이 완료되지 않으면 해당 유형을 제출할 수 없다.
7. 제출 후 문의는 `new`, 검증은 `pending`으로 시작한다. 사용자는 문의 상세에서 답변·상태·증빙을 확인하고 추가 메시지를 보낼 수 있다.
8. 관리자가 답변하면 기존 알림 벨에 `support_reply` 알림이 생성되고 클릭 시 해당 문의로 이동한다. 이메일은 보내지 않는다.

스크린샷은 암호학적 소유권 증명이 아니다. 증빙이 부족하면 관리자는 `additional_info`로 전환하고 추가 정보를 요청한다. 스크린샷을 제공할 수 없으면 privacy 유형으로 제출할 수 없고 일반 문의에서 별도 안내를 받는다.

### 4.2 관리자

1. `/admin/support`에서 미처리·오래된 문의를 먼저 본다.
2. 문의 상세에서 요청자 프로필, 문의 내용, 대상 플랫폼·닉네임·`account_id`, 증빙 signed URL을 확인한다.
3. privacy 문의는 증빙과 PUBG API 조회 결과를 대조한 뒤 `verified`, `additional_info`, `rejected` 중 하나로 검증한다.
4. 검증 완료 상태에서만 `비공개 목록에 등록`을 누를 수 있다. 기존 `addPrivatePlayer`를 호출하고 성공하면 문의를 `resolved`로 바꾸며 감사 이벤트를 기록한다. 이미 등록된 계정은 중복 없이 완료로 표시한다.
5. 일반 문의와 검증 중 문의에는 사용자에게 보이는 답변을 남긴다. 사용자가 답변하면 `awaiting_user` 또는 `answered`에서 `in_progress`로 되돌린다.
6. FAQ 탭에서 질문·답변·카테고리·노출 순서·게시/숨김을 관리한다.

## 5. 상태와 기본 제한

문의 상태:

| 상태 | 의미 | 다음 상태 |
| --- | --- | --- |
| `new` | 새로 접수된 문의 | `in_progress`, `rejected` |
| `in_progress` | 관리자가 확인 중 | `awaiting_user`, `answered`, `resolved`, `rejected` |
| `awaiting_user` | 사용자 추가 정보 대기 | `in_progress`, `rejected` |
| `answered` | 관리자가 답변했고 사용자 확인 대기 | `in_progress`, `resolved` |
| `resolved` | 처리가 끝난 문의 | 사용자가 새 메시지를 보내면 `in_progress` |
| `rejected` | 요건 미충족 또는 처리 불가 | 사용자가 새 메시지를 보내면 `in_progress`로 재검토 |

전적 비공개 검증 상태는 문의 상태와 별도로 `not_required`, `pending`, `verified`, `additional_info`, `rejected`를 사용한다. `verified`가 아니면 비공개 등록 API가 거부된다.

초기 제한값:

- 제목 최대 120자, 본문 최대 5,000자
- 문의 한 건당 첨부 최대 3개, 파일당 3 MiB, 전체 9 MiB
- 허용 MIME은 `image/png`, `image/jpeg`, `image/webp`
- 사용자당 24시간 내 새 문의 최대 5건
- 동일 사용자가 같은 `(platform, account_id)`에 대해 처리 중인 privacy 요청은 1건
- 해결 또는 반려된 문의의 증빙은 종료 후 30일 뒤 삭제. 미종료 문의의 증빙은 처리될 때까지 보관

## 6. 데이터 모델

모든 ID는 UUID를 사용한다. `requester_id`, 메시지 `sender_id`, 첨부 `uploader_id`는 프로필 삭제 시 `SET NULL`로 바뀌며, 삭제된 계정의 문의는 관리자 처리와 보존 정책을 위해 남을 수 있다.

### `support_faqs`

```text
id uuid primary key
category text check (category in ('stats', 'account', 'community', 'feature'))
question text not null
answer text not null                 -- plain text, 줄바꿈 보존
sort_order integer not null default 0
is_published boolean not null default false
created_by uuid references profiles(id) on delete set null
updated_by uuid references profiles(id) on delete set null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

초기 FAQ 질문:

- 전적 비공개 요청은 어디에서 하나요?
- 비공개 요청에 어떤 증빙이 필요한가요?
- 비공개 처리까지 얼마나 걸리나요?
- 닉네임을 바꾸면 비공개 상태가 유지되나요?
- 계정·커뮤니티 문의는 어디로 보내나요?

이 다섯 행은 seed migration에서 `is_published = true`로 생성하고, 각 답변에는 문의 경로·필수 스크린샷·처리 상태·닉네임 변경 시 `account_id` 기준 처리·일반 문의 안내를 각각 명시한다. 관리자는 배포 후 문구를 수정할 수 있다.

### `support_tickets`

```text
id uuid primary key
requester_id uuid references profiles(id) on delete set null
category text check (category in ('privacy', 'account', 'community', 'bug', 'other'))
subject text not null
status text not null default 'new'
verification_status text not null default 'not_required'
target_platform text                 -- privacy 유형에서만 steam/kakao
target_nickname text
target_account_id text
target_resolved_nickname text
target_resolved_at timestamptz
last_message_at timestamptz not null default now()
last_message_sender text check (last_message_sender in ('user', 'admin'))
user_last_read_at timestamptz
admin_last_read_at timestamptz
resolved_at timestamptz
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

`category = 'privacy'`일 때만 `verification_status = 'pending'`으로 만들고 target 필드와 ready 상태 증빙을 필수로 한다. 나머지 카테고리는 `verification_status = 'not_required'`를 사용한다. `target_account_id`는 제출 시 서버가 조회한 값을 저장해 닉네임 변경이나 재조회 결과가 달라도 처리 대상을 고정한다.

목록의 unread는 `last_message_sender = 'admin'`이고 `last_message_at > user_last_read_at`인 경우다. 문의 상세를 연 사용자는 `user_last_read_at`을 갱신하고, 관리자는 상세를 열 때 `admin_last_read_at`을 갱신한다.

### `support_messages`

```text
id uuid primary key
ticket_id uuid not null references support_tickets(id) on delete cascade
sender_id uuid references profiles(id) on delete set null
sender_type text not null check (sender_type in ('user', 'admin'))
body text not null
created_at timestamptz not null default now()
```

메시지는 사용자에게 보이는 대화만 저장한다. 관리자 내부 메모는 이번 범위에 넣지 않고 이벤트 로그의 구조화된 metadata로 대체한다.

### `support_attachments`

```text
id uuid primary key
ticket_id uuid references support_tickets(id) on delete cascade
message_id uuid references support_messages(id) on delete set null
uploader_id uuid references profiles(id) on delete set null
bucket_id text not null default 'support-evidence'
storage_key text not null unique
original_name text not null
mime_type text not null
byte_size integer not null
status text not null default 'pending' check (status in ('pending', 'ready', 'deleted'))
expires_at timestamptz
created_at timestamptz not null default now()
deleted_at timestamptz
```

첨부는 문의를 저장하기 전에 업로드할 수 있어야 하므로 `ticket_id`를 처음에는
`NULL`로 둔다. 예약 시 인증 사용자의 `uploader_id`와 `expires_at`을 기록하고,
문의 생성 transaction이 `ready` 상태이면서 `ticket_id is null`이고 요청자 소유인
첨부 ID만 새 ticket과 첫 메시지에 원자적으로 연결한다. 연결되지 않은 pending/ready
행은 만료 정리 대상이다. storage key는 ticket ID에 의존하지 않는 무작위 UUID 경로
(`attachments/<attachmentId>`)를 사용하므로 연결 전에 업로드할 수 있다.

### `support_ticket_events`

```text
id uuid primary key
ticket_id uuid not null references support_tickets(id) on delete cascade
actor_id uuid references profiles(id) on delete set null
event_type text not null
from_status text
to_status text
metadata jsonb not null default '{}'
created_at timestamptz not null default now()
```

이벤트 유형에는 `created`, `status_changed`, `verification_changed`, `attachment_added`, `privacy_player_registered`, `privacy_player_already_registered`, `retention_deleted`를 사용한다. 증빙 원문이나 API 키는 metadata에 넣지 않는다.

### 기존 `notifications` 확장

`notifications.support_ticket_id uuid references support_tickets(id) on delete cascade`를 nullable로 추가한다. 관리자 답변 시 `type = 'support_reply'`, `post_id = null`, `support_ticket_id = 문의 ID`로 service role이 생성한다. 기존 알림 RLS를 유지하고, 헤더는 `support_reply`를 `/support/[ticketId]`로 라우팅한다.

필수 인덱스와 무결성 제약:

- `support_tickets(requester_id, updated_at desc)`와 `(status, last_message_at)` 인덱스
- privacy 중복 방지를 위한 `(requester_id, target_platform, target_account_id)` 부분 unique 인덱스. `status not in ('resolved', 'rejected')`인 privacy 행만 대상
- `support_messages(ticket_id, created_at)`와 `support_attachments(ticket_id, status)` 인덱스
- 한 ticket에서 `privacy_player_registered` 또는 `privacy_player_already_registered` 중 하나만 생성되도록 `ticket_id` 기준 partial unique 인덱스
- `support_ticket_events(ticket_id, created_at)` 인덱스

## 7. RLS와 저장소 보안

- `support_faqs`: 공개 사용자는 `is_published = true` 행만 SELECT. INSERT/UPDATE/DELETE는 관리자만 가능하다.
- `support_tickets`: requester 본인 또는 관리자만 SELECT. 신규 INSERT의 requester는 인증 사용자 본인으로만 허용한다. 수정은 Route Handler와 service role을 통해서만 수행한다.
- `support_messages`: 문의 접근 권한이 있는 본인 또는 관리자만 SELECT. 사용자 INSERT는 본인 문의로 제한한다. 관리자 메시지는 관리자 API에서만 INSERT한다.
- `support_attachments`: 연결된 첨부는 문의 접근 권한이 있는 본인 또는 관리자만 행을 조회하고, 아직 `ticket_id`가 없는 pending/ready 첨부는 `uploader_id` 본인 또는 관리자만 조회한다. storage bucket은 private이며 public SELECT 정책을 만들지 않는다.
- `support_ticket_events`: 관리자 조회만 허용하고, 기록은 service role 또는 관리자 API에서만 생성한다.
- 모든 Route Handler는 쿠키 세션 또는 bearer 토큰을 `withAuthGuard`로 확인한다. 관리자 경로는 `requireAdmin`으로 한 번 더 확인한다. 문의 ID가 다른 사용자 소유이면 일반 사용자에게는 존재 여부가 드러나지 않도록 `404`를 반환한다.
- 첨부 signed URL의 TTL은 5분으로 고정한다. URL을 로그나 알림 미리보기에 넣지 않는다.
- 스크린샷은 전용 버킷의 `attachments/attachmentId` 경로에 저장한다. 업로드 예약·완료 Route Handler가 uploader 소유권과 파일 상태를 확인한 뒤에만 `ready`로 전환하고, 문의 생성 transaction이 ready 첨부를 ticket에 연결한다.

## 8. API와 데이터 흐름

### 사용자 API

- `GET /api/support/faqs?category=&q=`: 게시된 FAQ만 반환한다.
- `POST /api/support/player-target`: 로그인 사용자가 입력한 플랫폼·닉네임을 서버 PUBG 조회로 확인하고 canonical nickname과 `account_id`를 반환한다. 원본 API 응답은 반환하지 않는다.
- `POST /api/support/tickets`: 문의와 첫 메시지를 생성한다. privacy 유형은 서버 플레이어 조회 결과와 ready 첨부를 확인한다.
- `GET /api/support/tickets`: 현재 사용자 문의 목록과 unread 여부를 반환한다.
- `GET /api/support/tickets/[id]`: 소유자 문의의 메시지·첨부 메타데이터·상태를 반환한다.
- `POST /api/support/tickets/[id]/messages`: 본인 문의에 메시지를 추가하고 `last_message_*`를 갱신한다.
- `POST /api/support/attachments/reserve`: 인증 사용자, MIME, 크기를 검증하고 `ticket_id` 없는 pending attachment와 private bucket signed upload URL을 반환한다.
- `POST /api/support/attachments/complete`: 본인 pending attachment의 업로드 객체 존재를 확인하고 attachment를 `ready`로 전환한다.
- `GET /api/support/attachments/[id]/url`: 본인 또는 관리자에게만 5분 signed URL을 반환한다.

### 관리자 API

- `GET /api/admin/support/tickets?status=&category=&q=`: 관리자 문의함을 반환한다. 미처리와 오래된 문의를 먼저 정렬한다.
- `GET /api/admin/support/tickets/[id]`: 문의 전체 내용과 이벤트, 첨부 signed URL을 반환한다.
- `PATCH /api/admin/support/tickets/[id]`: 허용된 상태·검증 상태 전이를 실행하고 이벤트를 기록한다.
- `POST /api/admin/support/tickets/[id]/messages`: 관리자 답변을 추가하고 `support_reply` 알림을 생성한다.
- `POST /api/admin/support/tickets/[id]/privacy-action`: `verified` 문의에서만 기존 `addPrivatePlayer`를 호출한다. idempotent 결과와 이벤트를 저장한다.
- `GET/POST/PATCH/DELETE /api/admin/support/faqs`: FAQ 관리 API다. 답변은 plain text로 저장한다.

문의 생성 흐름은 `인증 → 입력 검증 → privacy면 PUBG 조회 → 요청자 소유의 미연결 첨부 ready 확인 → ticket/message/첨부 연결/RPC 이벤트 저장` 순서다. 관리자 비공개 처리는 `관리자 인증 → ticket 재조회 → verification=verified 확인 → addPrivatePlayer → privacy event → resolved` 순서로 실행한다. 이미 등록된 계정은 성공적인 no-op으로 취급한다.

## 9. UI 및 파일 경계

구현 시 기존 게시판 컴포넌트에 조건문을 추가하기보다 고객센터 전용 경계를 둔다.

- `app/support/page.tsx`: FAQ와 고객센터 진입 화면
- `app/support/new/page.tsx`: 문의 작성 화면
- `app/support/[ticketId]/page.tsx`: 문의 대화 화면
- `components/support/SupportCenter.tsx`: FAQ 검색·탭·링크
- `components/support/TicketForm.tsx`: 유형별 폼·플레이어 조회·첨부 업로드
- `components/support/TicketThread.tsx`: 메시지·상태·증빙 표시
- `app/admin/support/page.tsx`: 관리자 문의함과 FAQ 관리
- `components/admin/SupportInbox.tsx`, `components/admin/SupportTicketDetail.tsx`, `components/admin/SupportFaqEditor.tsx`: 관리자 화면 단위
- `lib/support/*`: 상태 전이, 입력 검증, 첨부 계약, FAQ 모델
- `supabase/migrations/*_support_center.sql`: 테이블·RLS·인덱스·알림 확장·private bucket 계약

공용 푸터·모바일 메뉴·마이페이지에는 `/support` 링크를 추가한다. 헤더의 알림 클릭 처리에는 `support_reply` 분기를 추가하되 기존 게시판 댓글 알림 동작은 유지한다.

## 10. 오류, 제한, 운영 정책

- 401: 로그인 필요, 403: 관리자 또는 소유권 부족, 404: 없는 문의 또는 접근 불가 문의, 409: 같은 대상의 처리 중 중복 privacy 문의, 413: 파일·본문 크기 초과, 429: 쓰기 빈도 초과, 503: storage/PUBG 조회 일시 장애로 구분한다.
- PUBG 조회 실패로 대상 `account_id`를 확정하지 못하면 문의를 저장하지 않고 재시도 안내를 표시한다. API 키·원본 응답은 클라이언트나 메시지에 노출하지 않는다.
- 업로드 완료 전에 문의 저장이 실패하면 pending attachment를 즉시 정리하거나 만료 작업 대상에 넣는다. 만료된 pending 행과 객체는 매일 정리한다.
- 관리자 답변이 중복 제출되어도 메시지 저장은 한 번만 실행하도록 버튼 잠금과 서버 idempotency key를 사용한다.
- privacy-action은 동일 ticket에서 한 번만 유효하게 실행된다. 재시도는 기존 event와 private player list를 확인해 중복 등록하지 않는다.
- 개인정보처리방침에 고객센터 문의·증빙의 수집 목적, 관리자 접근, 30일 종료 후 삭제 정책을 추가한다.

## 11. 테스트 기준

### DB/RLS

- 비로그인 사용자는 게시된 FAQ만 읽을 수 있다.
- 사용자 A는 사용자 B의 ticket, message, attachment, signed URL을 조회할 수 없다.
- 관리자는 모든 ticket과 이벤트를 조회할 수 있다.
- service role 외에는 이벤트·알림·비공개 처리 상태를 임의로 기록할 수 없다.

### API/통합

- 로그인·관리자 가드, 상태 전이, 중복 privacy 요청, 401/403/404/409/413/429/503 응답을 검증한다.
- privacy 생성은 플레이어 조회·account ID 확인·ready 스크린샷 없이는 성공하지 않는다.
- signed upload의 MIME·크기·소유권·완료 상태와 만료 정리를 검증한다.
- `스크린샷 첨부 → 관리자 verified → 비공개 목록 등록 → 감사 이벤트 → resolved`를 통합 테스트한다.
- 이미 비공개인 계정의 재시도는 중복 목록·중복 이벤트를 만들지 않는다.
- 관리자 답변은 `support_reply` 알림을 만들고 알림 클릭이 해당 문의로 이동한다.

### UI/회귀

- FAQ 검색·필터, 로그인 유도, 문의 생성·첨부 실패·추가 답변, 상태 배지를 검증한다.
- 관리자 문의 필터·상세·답변·증빙 미리보기·FAQ 편집을 검증한다.
- 기존 게시판 작성/댓글/이미지, 기존 댓글 알림, 관리자 대시보드·비공개 플레이어 관리가 회귀하지 않는지 확인한다.

## 12. 배포 순서

1. support 테이블, RLS, 인덱스, private bucket, `notifications.support_ticket_id` migration을 추가한다.
2. 서버 검증·API와 첨부 signed upload를 추가하고 RLS/API 테스트를 통과시킨다.
3. 사용자 FAQ·문의 화면을 추가하고 푸터·모바일 메뉴·마이페이지 링크를 연결한다.
4. 관리자 문의함·FAQ 편집·비공개 등록 액션을 추가한다.
5. 기존 notifications 헤더 분기와 개인정보처리방침을 배포한다.
6. FAQ 초기 데이터를 게시하고, 테스트 관리자 계정으로 privacy 전체 흐름을 dry-run한 뒤 운영을 시작한다.

초기 배포에서 기존 이메일 요청을 자동으로 이관하지 않는다. 이미 이메일로 받은 요청은 관리자가 새 문의로 수동 등록하거나 기존 방식으로 마무리한다. 고객센터가 안정화된 뒤에만 이메일 안내 문구를 “고객센터로 접수”로 변경한다.
