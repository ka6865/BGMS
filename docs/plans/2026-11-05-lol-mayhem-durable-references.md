# 증바람 티어·아이템·과거 순위 영구 보존

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 외부 조회에 의존하는 티어·아이템·패치 순위를 수집 시점별로 보존하고 승인된 자료를 캐시해 제공한다.

**Architecture:** 기존 private `lol-augment-snapshots`에 내용 해시 기반 원본/정규화 JSON을 저장한다. DB release/publication에 패치·출처·자료일·수집일·권한 근거·공개 상태를 기록한다. 수집과 공개는 분리하고 이전 공개본은 수집 실패와 무관하게 유지한다.

**Tech Stack:** Next.js 16, Supabase Postgres/Storage, 기존 GitHub Actions·Vitest·격리 PostgreSQL 검증.

**Spec:** 대화에서 사용자가 선택한 Storage + DB 목록 + 캐시 방식.

## 비교와 결정

- 외부 API + 캐시: 현재 구현은 간단하지만 과거 수정본과 외부 삭제에 취약하다.
- 전부 통계 행으로 저장: 복잡한 SQL 집계에는 좋지만 현재 화면은 패치/챔피언 단위 조회이므로 불필요하다.
- 선택: 원본/정규화 파일 + DB 목록 + 캐시. 원본·정규화본이 모두 같으면 중복 저장하지 않고, 원본 메타데이터를 포함한 과거 파일 수정은 새 후보로 보존한다.

## Global Constraints

- 증바람 전용. 일반 칼바람·아레나 추정 자료는 추가하지 않는다.
- 머지·배포·운영 migration 적용은 하지 않는다. 기존 작업 트리를 이어서 사용한다.
- ARAMGG 챔피언 통계와 arammayhem.com 전체 증강 선택률을 혼합하지 않는다.
- ARAMGG 키·권한 근거·할당량 예비 25 credits·분당 60회 제한을 유지한다.
- 포로 간식 2052/220013, 추천 기본 장화 1001 제외를 유지한다. 제작 재료 장화는 유지한다.
- CC BY 4.0 출처 링크와 추정 통계일을 보존한다. 승률·티어가 없는 자료로 새 티어를 만들지 않는다.
- 새 영속 경로는 rollout 설정으로 전환한다. 설정을 켜면 사용자 조회에서 외부 통계 API를 호출하지 않는다.

## Review Focus

- 수집 실패/응답 변경/Storage 오류 때 공개본 유지.
- 같은 자료 중복 수집 및 과거 파일 수정 구분.
- 미승인 파일·다른 챔피언·다른 패치·잘못된 해시 노출 차단.
- 동시 공개/복구 충돌, 재공개, RLS/서비스 권한 검사.
- 소스별 버전·날짜·선택률 단위 보존, 조회와 자동 수집의 분리.

## 실행

- [x] Task 1: 공통 release/publication 및 review/lease RPC, 격리 DB 시나리오.
- [x] Task 2: 기존 파서 재사용 수집 어댑터 및 ARAMGG 목록 응답 재사용.
- [x] Task 3: 검증된 Storage 읽기/쓰기·후보 수집·6시간 스케줄·CLI.
- [x] Task 4: 공개 조회 전환·관리자 후보 검토/공개/복구 연결.
- [x] Task 5: 실패/중복/권한 단위 검증, verify:core/lol/migrations, 모바일/데스크톱 QA, 운영 문서.

## 추가 요청: 관리자 사용성

사용자가 기존 데이터 관리가 어렵다고 지적하여 자료 종류별 탭, 공개본/새 후보/기준일 요약, 상태에 맞는 다음 동작을 추가한다. 긴 기술 정보는 접되 검토·공개·복구 및 매핑 절차는 유지한다. 모바일 세 크기와 데스크톱에서 검증한다.

## 검증 결과

- `verify:core` 통과(기존 경고 43개), `verify:lol` 876개 통과/147개 opt-in 제외, `verify:admin` 433개 통과.
- 일회용 로컬 PostgreSQL `verify:migrations` 통과. 원본만 수정된 새 후보와 기존 공개본이 있는 상태의 승인도 검증했다.
- 브라우저 fixture 30개 통과: 375×667·390×844·430×932·1440×900, 관리자 탭·참고 자료·매핑·조작부 크기·가로 넘침 포함.
- 실제 IESDEV 173개 챔피언과 arammayhem.com 과거 12패치 읽기 검증 통과. 운영 DB·Storage 쓰기는 하지 않았다.
- 운영 migration/설정 활성화/최초 적재/머지/배포/실기기 검증은 미실행. 관리자 목록은 종류별 최근 500개이며 원본 보존에는 제한을 적용하지 않는다.
