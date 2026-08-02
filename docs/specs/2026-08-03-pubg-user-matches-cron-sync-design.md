 # 가입 회원 및 활성 유저 과거 전적 10일 주기 자동 수집 (Sync) 설계
 
 ## 1. 개요 (Overview)
 본 설계는 유저가 장기간 사이트에 접속하지 않더라도 14일 초과 매치가 소멸하는 것을 방지하기 위해, 매일 새벽 GitHub Actions를 통해 1순위(가입 회원) 및 2순위(고빈도 비회원 유저)의 전적을 10일 주기로 백그라운드 자동 수집하는 스펙입니다.
 
 ## 2. 핵심 목표 (Goals)
 - **1순위 (가입 회원)**: `profiles.pubg_nickname` 연동 회원 닉네임 최우선 자동 수집.
 - **2순위 (활성 비회원)**: `pubg_player_cache` 중 `search_count >= 3` 이고 최근 30일 내 검색된 유저 수집.
 - **스케줄링 & 보안**: 매일 새벽 3시(KST 04:00 / UTC 19:00) GitHub Actions에서 `scripts/sync_user_matches.ts` 자동 실행.
 - **API & DB 안정성**: 하루 15~20명 상한으로 PUBG API 사용량 0.1% 미만 유지 및 DB 부하 방지.
 
 ## 3. 아키텍처 및 데이터 처리 (Architecture)
 
 ### 3.1 수집 대상 추출 로직 (`scripts/sync_user_matches.ts`)
 ```typescript
 // 1순위: profiles 내 10일 이상 미갱신 회원 닉네임
 // 2순위: pubg_player_cache 내 search_count >= 3 & last_seen_at 30일 이내인 유저
 // 하루 15~20명 상한 분산 수집
 ```
 
 ### 3.2 GitHub Actions 통합 (`.github/workflows/daily-tasks.yml`)
 - `daily-tasks.yml` 워크플로우에 `sync-user-matches` 스텝 추가.
 - 백업 및 텔레메트리 클린업 직후 실행되도록 연결.
 - 실패 시 디스코드 장애 웹훅으로 자동 통보.
 
 ## 4. 검증 방안 (Verification)
 - **수집 스크립트 단위 테스트**: `tests/sync-user-matches.test.ts`
 - **GitHub Actions 워크플로우 구문 검증**: `.github/workflows/daily-tasks.yml`
