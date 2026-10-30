import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 로컬 검증 DB에는 없는 운영 safeupdate가 WHERE 없는 DELETE·UPDATE를 PostgREST 호출에서 거부한다.
describe("랭킹 함수의 운영 safeupdate 호환", () => {
  it.each(["20261031030000_lol_ranking_publication", "20261031040000_lol_master_publication_delete_where"])("%s의 삭제·수정문에는 WHERE가 있다", name => {
    const sql = readFileSync(`supabase/migrations/${name}.sql`, "utf8");
    const latest = name.includes("040000") ? sql : sql.replace(/create function public\.save_lol_master_publication[\s\S]*?end \$\$;/, "");
    for (const statement of latest.match(/^\s*(?:delete from|update) public\.[\s\S]*?;/gm) ?? []) expect(statement).toMatch(/\bwhere\b/i);
  });
});
