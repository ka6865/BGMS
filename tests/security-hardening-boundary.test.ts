import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const loadYaml = (createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
}).load;

function read(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("치명: 비밀값이 Discord 메시지에 들어가지 않는다", () => {
  const cronSource = read("app/api/cron/patch-notes/route.ts");

  it("cron 라우트가 ADMIN_SECRET_TOKEN 을 알림 본문에 넣지 않는다", () => {
    // 웹훅으로 보내는 문자열 안에서 secret 값을 참조하는 패턴이 없어야 한다.
    expect(cronSource).not.toContain("quickSyncLink");
    expect(cronSource).not.toMatch(/secret=\$\{/);
    expect(cronSource).not.toMatch(/process\.env\.ADMIN_SECRET_TOKEN\s*\|\|\s*""/);
  });

  it("알림은 관리자 페이지 경로만 안내한다", () => {
    expect(cronSource).toContain("/admin/game-data");
  });

  it("알림 헬퍼에 비밀값 금지 주석이 남아 있다", () => {
    expect(cronSource).toContain("비밀값을 절대 포함하지 마십시오");
  });

  it("저장소 어디에서도 웹훅 본문에 secret 을 문자열 보간하지 않는다", () => {
    for (const path of [
      "app/api/cron/patch-notes/route.ts",
      "app/api/admin/patch-notes/sync/route.ts",
      "scripts/sync_patch_notes.ts",
      "app/api/report/notify/route.ts",
      "app/api/admin/approve/route.ts",
      "app/api/admin/reject/route.ts",
      "app/api/board/report/route.ts",
    ]) {
      const source = read(path);
      expect(source, path).not.toMatch(/\$\{[^}]*(ADMIN_SECRET_TOKEN|CRON_SECRET|SERVICE_ROLE_KEY)[^}]*\}/);
    }
  });
});

describe("치명: cron 인증에 환경별 우회가 없다", () => {
  const cronSource = read("app/api/cron/patch-notes/route.ts");

  it("NODE_ENV 조건부 인증이 제거되었다", () => {
    expect(cronSource).not.toContain('process.env.NODE_ENV === "production"');
  });

  it("쿼리 파라미터 secret 을 더 이상 받지 않는다", () => {
    expect(cronSource).not.toContain('searchParams.get("secret")');
  });

  it("Authorization Bearer 헤더만 허용한다", () => {
    expect(cronSource).toContain('authorizeBearerSecret(request, ["CRON_SECRET", "ADMIN_SECRET_TOKEN"])');
  });

  it("공유 헬퍼가 상수 시간 비교를 사용하고 미설정 시 거부한다", () => {
    const helper = read("lib/server/secretAuth.ts");
    expect(helper).toContain("timingSafeEqual");
    expect(helper).toContain("if (!expected) return false;");
    // 길이가 다르면 timingSafeEqual 이 예외를 던지므로 먼저 비교한다.
    expect(helper).toContain("if (candidateBuffer.length !== expectedBuffer.length) return false;");
  });
});

describe("중간: /api/cleanup 이 헤더 인증을 쓴다", () => {
  const cleanupSource = read("app/api/cleanup/route.ts");

  it("쿼리 파라미터 토큰을 받지 않는다", () => {
    expect(cleanupSource).not.toContain('searchParams.get("token")');
  });

  it("Bearer 헤더 검증을 사용한다", () => {
    expect(cleanupSource).toContain("authorizeBearerSecret(request,");
    expect(cleanupSource).toContain("ADMIN_SECRET_TOKEN");
  });
});

describe("높음: Discord 방 생성이 인증·쿼터·입력 검증을 거친다", () => {
  const source = read("app/api/discord/room/create/route.ts");

  it("로그인 가드를 통과해야 한다", () => {
    expect(source).toContain('from "@/utils/supabase/guard"');
    expect(source).toContain("await withAuthGuard()");
    expect(source).toContain("status: 401");
  });

  it("DB 기반 쿼터를 소비하고 초과 시 429 를 반환한다", () => {
    expect(source).toContain('"consume_discord_room_quota"');
    expect(source).toContain("status: 429");
  });

  it("채널 종류를 화이트리스트로 제한한다", () => {
    expect(source).toContain('const ROOM_TYPES = ["duo", "squad"] as const');
    expect(source).toContain("isRoomType(type)");
  });

  it("표시명 길이와 문자를 제한해 채널 이름 오염을 막는다", () => {
    expect(source).toContain("normalizeAuthor");
    expect(source).toContain("AUTHOR_MAX_LENGTH");
    expect(source).toContain("safeAuthor");
    expect(source).not.toContain("${author}님의 팀");
  });

  it("쿼터 마이그레이션이 사용자·전체 상한을 모두 강제한다", () => {
    const migration = read("supabase/migrations/20260730204500_discord_room_rate_limit.sql");
    expect(migration).toContain("IF global_count >= 20 THEN");
    expect(migration).toContain("RETURN current_count <= 3;");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.consume_discord_room_quota(uuid) FROM PUBLIC, anon, authenticated");
  });
});

describe("높음: 서버 데이터 테이블 쓰기 정책이 좁혀졌다", () => {
  const migration = read("supabase/migrations/20260730203000_tighten_service_data_write_policies.sql");

  it("anon 쓰기가 열려 있던 pubg_player_cache 정책을 교체한다", () => {
    expect(migration).toContain('drop policy if exists "Service Role Write" on public.pubg_player_cache');
    expect(migration).toContain("pubg_player_cache_service_role_write");
  });

  it("authenticated 쓰기 정책을 제거한다", () => {
    expect(migration).toContain('drop policy if exists "Allow authenticated insert" on public.processed_match_telemetry');
    expect(migration).toContain('drop policy if exists "Allow authenticated update" on public.processed_match_telemetry');
    expect(migration).toContain('drop policy if exists "Allow authenticated insert only" on public.match_stats_raw');
  });

  it("테이블 권한도 회수해 이중으로 막는다", () => {
    for (const table of ["pubg_player_cache", "processed_match_telemetry", "match_stats_raw"]) {
      expect(migration).toContain(`revoke insert, update, delete on table public.${table} from anon, authenticated`);
    }
  });

  it("읽기 권한은 유지한다 (무기도감·전적·랭킹 의존)", () => {
    expect(migration).toContain("grant select on table public.pubg_player_cache to anon, authenticated");
    expect(migration).toContain("grant select on table public.global_benchmarks to anon, authenticated");
  });
});

describe("높음: 게시글 본문이 서버에서 정화된다", () => {
  it("쓰기 라우트가 저장 전에 정화한다", () => {
    const source = read("app/api/posts/write/route.ts");
    expect(source).toContain('from "@/lib/board/sanitizeHtml"');
    expect(source).toContain("sanitizeBoardHtml(content.trim())");
  });

  it("SSR 페이지가 본문과 댓글을 정화해서 클라이언트로 넘긴다", () => {
    const source = read("app/board/[postId]/page.tsx");
    expect(source).toContain("sanitizeBoardHtml(postResult.content)");
    expect(source).toContain("sanitizeBoardHtml(comment.content)");
  });

  it("AI 생성 HTML 도 DB 저장 전에 정화한다", () => {
    expect(read("app/api/cron/patch-notes/route.ts")).toContain("sanitizeBoardHtml(minifyHtml(");
    expect(read("scripts/sync_patch_notes.ts")).toContain("sanitizeBoardHtml(minifyHtml(");
    expect(read("app/api/admin/patch-notes/sync/route.ts")).toContain("sanitizeBoardHtml(buildHtml(");
  });
});

describe("중간: 크롤링 파싱 실패를 조용히 넘기지 않는다", () => {
  const cronSource = read("app/api/cron/patch-notes/route.ts");

  it("추출 0건이면 알림을 보내고 실패 상태를 반환한다", () => {
    expect(cronSource).toContain("list_parse_failed");
    expect(cronSource).toContain("패치노트 크롤링 파싱 실패");
    expect(cronSource).toContain("status: 502");
  });

  it("이전의 조용한 성공 응답이 제거되었다", () => {
    expect(cronSource).not.toContain('success: true, message: "검색된 최신 패치노트가 없습니다."');
  });
});

describe("중간: 일일 작업 실패가 알림으로 이어진다", () => {
  const workflowSource = read(".github/workflows/daily-tasks.yml");
  const workflow = loadYaml(workflowSource) as {
    jobs: Record<string, { needs?: string[]; if?: string; steps?: { name?: string }[] }>;
  };

  it("실패 알림 잡이 존재하고 failure() 조건으로 동작한다", () => {
    const job = workflow.jobs["failure-notify"];
    expect(job).toBeTruthy();
    expect(job.if).toContain("failure()");
    expect(job.needs).toEqual(["board-write-quota-cleanup", "maintenance"]);
  });

  it("maintenance 마지막 step 순서를 바꾸지 않는다", () => {
    const steps = workflow.jobs.maintenance.steps ?? [];
    expect(steps.at(-1)?.name).toBe("Run Hotdrop Collection");
  });

  it("캐시·쿼터 정리 step 이 추가되었다", () => {
    const stepNames = (workflow.jobs.maintenance.steps ?? []).map((step) => step.name);
    expect(stepNames).toContain("Cleanup PUBG Cache And Quota Tables");
  });

  it("사용하지 않는 ADMIN_SECRET_TOKEN 을 패치노트 step 에서 제거했다", () => {
    const syncStep = (workflow.jobs.maintenance.steps ?? []).find(
      (step) => step.name === "Sync Patch Notes"
    ) as { env?: Record<string, string> } | undefined;
    expect(syncStep?.env).toBeTruthy();
    expect(Object.keys(syncStep?.env ?? {})).not.toContain("ADMIN_SECRET_TOKEN");
    expect(read("scripts/sync_patch_notes.ts")).not.toContain("ADMIN_SECRET_TOKEN");
  });
});

describe("유지보수: 패치노트 로직 중복이 제거되었다", () => {
  it("identifyCategory 정의가 공용 모듈 한 곳에만 있다", () => {
    const definitionCount = [
      "lib/patch-notes/categorize.ts",
      "app/api/cron/patch-notes/route.ts",
      "app/api/admin/patch-notes/sync/route.ts",
      "scripts/sync_patch_notes.ts",
    ].filter((path) => /function identifyCategory\s*\(/.test(read(path)));

    expect(definitionCount).toEqual(["lib/patch-notes/categorize.ts"]);
  });

  it("세 소비자가 모두 공용 모듈을 import 한다", () => {
    expect(read("app/api/cron/patch-notes/route.ts")).toContain("@/lib/patch-notes/categorize");
    expect(read("app/api/admin/patch-notes/sync/route.ts")).toContain("@/lib/patch-notes/categorize");
    expect(read("scripts/sync_patch_notes.ts")).toContain("../lib/patch-notes/categorize");
  });
});
