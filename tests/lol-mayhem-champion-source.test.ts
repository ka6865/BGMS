import { describe, expect, it, vi } from 'vitest';
import { createChampionSource } from '../lib/lol/mayhemChampionSource';
const meta={gamePatch:'16.21',dataVersion:'16.21.5',schemaVersion:1} as const;
const response=(value:unknown,remaining=199)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','x-credits-remaining':String(remaining),'x-credits-cost':'1'}});
describe('제3자 통계 API 수집 경계',()=>{
 it('무료 config는 키를 전송하지 않고 버전만 반환한다',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response(meta));const api=createChampionSource({fetcher:fetcher as typeof fetch});
  expect(await api.config()).toEqual(meta);expect(fetcher.mock.calls[0][0]).toBe('https://data.dtodo.cn/api/v1/ko/config.json');
  expect(fetcher.mock.calls[0][1]?.headers).toBeUndefined();
 });
 it('키가 없으면 유료 데이터 요청을 하지 않는다',async()=>{
  const fetcher=vi.fn();await expect(createChampionSource({fetcher}).champions(meta)).rejects.toThrow('stats_api_key_missing');expect(fetcher).not.toHaveBeenCalled();
 });
 it('HEAD로 quota 확인 후 목록을 받고 요청 간 간격을 지킨다',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'x-credits-remaining':'200'}})).mockResolvedValueOnce(response({meta,data:[{id:29},{id:99}]}));
  const wait=vi.fn(async()=>{}); const api=createChampionSource({fetcher,apiKey:'test-key',wait});
  expect(await api.champions(meta)).toEqual([29,99]);expect(fetcher.mock.calls[0][1]).toMatchObject({method:'HEAD',redirect:'error',headers:{'x-api-key':'test-key'}});expect(wait).toHaveBeenCalled();
 });
 it('목록 hook은 기존 paid GET 응답을 그대로 전달하고 champions()의 ID 반환을 유지한다',async()=>{
  const value={meta,data:[{id:99},{id:29}]};const body=JSON.stringify(value);
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'x-credits-remaining':'200'}})).mockResolvedValueOnce(response(value));
  const onChampionList=vi.fn(async()=>{});const api=createChampionSource({fetcher,apiKey:'test-key',wait:async()=>{},onChampionList});
  expect(await api.champions(meta)).toEqual([29,99]);expect(onChampionList).toHaveBeenCalledWith({body,value,ids:[29,99]});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('잔여 quota25 이하·429·외부 redirect는 중단한다',async()=>{
  const low=vi.fn(async()=>new Response(null,{headers:{'x-credits-remaining':'25'}}));
  await expect(createChampionSource({fetcher:low,apiKey:'test'}).champions(meta)).rejects.toThrow('stats_quota_deferred');expect(low).toHaveBeenCalledTimes(1);
  await expect(createChampionSource({fetcher:vi.fn(async()=>new Response('',{status:429})),apiKey:'test'}).champions(meta)).rejects.toThrow('stats_quota_deferred');
  await expect(createChampionSource({fetcher:vi.fn(async()=>new Response('',{status:302,headers:{location:'https://evil.test'}})),apiKey:'test'}).champions(meta)).rejects.toThrow('stats_source_status');
 });
 it('목록 버전 변경·중복 ID·비정상 ID를 거부한다',async()=>{
  for (const data of [{meta:{...meta,dataVersion:'16.21.6'},data:[{id:29}]},{meta,data:[{id:29},{id:29}]},{meta,data:[{id:'x'}]}]) {
   const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{headers:{'x-credits-remaining':'200'}})).mockResolvedValueOnce(response(data));
   await expect(createChampionSource({fetcher,apiKey:'test',wait:async()=>{}}).champions(meta)).rejects.toThrow();
  }
 });
 it('173명은 목록 포함174credits를 쓰고 최소25credits를 남긴다',async()=>{
  let remaining=200;let gets=0;
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(input,init)=>{
   if(init?.method==='HEAD')return new Response(null,{headers:{'x-credits-remaining':String(remaining)}});
   gets++;remaining--;
   return response(String(input).endsWith('/champions.json')?{meta,data:Array.from({length:173},(_,i)=>({id:i+1}))}:[],remaining);
  });
  const api=createChampionSource({fetcher,apiKey:'test',wait:async()=>{}});
  const ids=await api.champions(meta);for(const id of ids)await api.champion(id);
  expect(gets).toBe(174);expect(api.remaining()).toBe(26);
  await api.champion(1);expect(api.remaining()).toBe(25);
  await expect(api.champion(1)).rejects.toThrow('stats_quota_deferred');expect(gets).toBe(175);
 });
 it('파일 상한과 비정상 JSON을 검사한다',async()=>{
  await expect(createChampionSource({fetcher:vi.fn(async()=>new Response(' '.repeat(2*1024*1024+1)))}).config()).rejects.toThrow('stats_source_too_large');
  await expect(createChampionSource({fetcher:vi.fn(async()=>new Response('<html>'))}).config()).rejects.toThrow('stats_source_json');
 });
 it('본문 수신 중 끊기면 네트워크 오류로 분류한다',async()=>{
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));controller.error(new DOMException('The operation was aborted due to timeout','TimeoutError'));}});
  await expect(createChampionSource({fetcher:vi.fn(async()=>new Response(body))}).config()).rejects.toThrow('stats_source_network');
 });
});
