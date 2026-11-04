import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db=vi.hoisted(()=>({rpc:vi.fn()}));
const lifecycle=vi.hoisted(()=>({after:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("next/server",()=>({after:lifecycle.after}));
vi.mock("@/lib/lol/ops.server",()=>({recordLolOpsMetric:vi.fn()}));
vi.mock("@/lib/server/serviceRoleSupabase.server",()=>({createServiceRoleSupabase:()=>db}));
import {persistLolSearchSnapshot} from "../lib/lol/persistence.server";
const input={lease:{key:"search",token:"token"},cacheKey:"cache",cachePayload:{},platform:"kr" as const,route:"asia" as const,version:"16.21.1",account:{puuid:"p",gameName:"Owner",tagLine:"KR1",profileIconId:1,summonerLevel:30},ranked:[],matches:[{summary:{matchId:"KR_1"},raw:{}}]};
describe("검색 응답 뒤 별도 통계 집계",()=>{
 beforeEach(()=>{vi.clearAllMocks();db.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:true,error:null})});});
 afterEach(()=>vi.restoreAllMocks());
 it("전적 저장 성공 시에만 집계를 등록하고 저장 응답을 기다리는 동안 실행하지 않는다",async()=>{
  await persistLolSearchSnapshot(input);
  expect(db.rpc).toHaveBeenCalledOnce();expect(lifecycle.after).toHaveBeenCalledOnce();
  await lifecycle.after.mock.calls[0][0]();
  expect(db.rpc).toHaveBeenLastCalledWith("aggregate_lol_match_benchmarks",{p_match_id:"KR_1"});
 });
 it("전적 저장 실패 시 통계를 등록하지 않는다",async()=>{
  db.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:null,error:{code:"57014"}})});
  vi.spyOn(console,"error").mockImplementation(()=>{});
  await expect(persistLolSearchSnapshot(input)).rejects.toThrow();expect(lifecycle.after).not.toHaveBeenCalled();
 });
 it("응답 뒤 집계 실패는 성공한 전적 저장에 전파하지 않는다",async()=>{
  await persistLolSearchSnapshot(input);
  db.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:null,error:{code:"57014"}})});
  vi.spyOn(console,"error").mockImplementation(()=>{});
  await expect(lifecycle.after.mock.calls[0][0]()).resolves.toBeUndefined();
 });
});
