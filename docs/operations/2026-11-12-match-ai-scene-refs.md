# 단일 경기 AI 코칭의 장면 근거 (2026-11-12)

## 출력 형식

단일 경기 코칭(`/api/pubg/ai-analyze`) 응답 JSON에 장면 근거를 병렬 필드로 더한다. 기존 필드는 그대로다.

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `briefFeedbackSceneIds` | `(string \| null)[]` | `briefFeedback`과 같은 순서·길이. 문장이 가리키는 장면 ID 또는 `null` |
| `actionItems[].sceneId` | `string` (선택) | 행동 제안이 가리키는 장면 ID |

- 장면 ID는 `{타임라인 type}-{경과 ms}`(예: `KNOCK-312450`)다. 대상은 위치가 있는 `KILL`, `KNOCK`, `DOWNED`, `DIED`, `REVIVE`, `TEAM_KNOCK`, `TEAM_DIED` 이벤트이고, 좌표가 0,0인 이벤트는 뺀다(`lib/pubg-analysis/matchAiScenes.ts`).
- 서버는 canonical 분석의 `timeline`으로 장면 목록(내 장면 우선, 최대 24개, 상대 닉네임 제외)을 만들어 프롬프트의 `[장면 목록]`에 넣는다. 모델은 목록 안의 ID를 고르거나 `null`만 쓴다. 시각·좌표는 모델이 쓰지 않는다.
- 후처리 순서는 언어 순화 → `applyMatchAiEvidencePolicy` → `applyMatchAiSceneRefs` → 매운맛 한마디다. `applyMatchAiSceneRefs`는 목록에 없는 ID를 지우고 `briefFeedbackSceneIds` 길이를 `briefFeedback`에 맞추며, 유효한 ID가 없으면 필드를 뺀다. 새 응답과 캐시 응답에 같은 순서로 적용한다.
- 화면은 같은 규칙으로 상세 응답의 `timeline`에서 장면을 다시 찾고, 찾지 못하면 칩을 그리지 않는다. 장면 필드가 없는 구버전 응답·마크다운 응답은 기존처럼 그린다.

## 캐시 버전

- `AI_MATCH_PROMPT_VERSION`: `${AI_CACHE_VERSION}.nearest-teammate-v1` → `${AI_CACHE_VERSION}.scene-refs-v1`. 캐시 키는 계속 `prompt_version = AI_MATCH_PROMPT_VERSION + .calc{계산 버전}`이다.
- 최근 요약(`AI_SUMMARY_CACHE_VERSION`)과 스쿼드(`AI_SQUAD_CACHE_VERSION`) 캐시는 바꾸지 않는다.
- 배포 뒤 기존 단일 경기 캐시는 조회되지 않으므로 첫 요청마다 새로 생성된다.

## 남은 확인 사항

- 실제 Gemini가 ID를 고르는 비율과 정확도는 확인하지 않았다(실제 호출 미실행).
- 근거 정책이 문장을 보류 문장으로 바꿔도 장면 ID는 남는다. 바뀐 문장과 장면의 연결이 어색한지는 운영 응답으로 확인한다.
