import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBanStatuses, fetchBanStatusBatch } from '@/lib/pubg/banApiClient';
afterEach(()=>vi.restoreAllMocks());
describe('ban API response identity and budget',()=>{
 it('deduplicates and splits 11 accounts into batches of 10 and 1',async()=>{
  const ids=Array.from({length:11},(_,i)=>`account.target${i}`);
  const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>{
   const requested=new URL(String(url)).searchParams.get('filter[playerIds]')!.split(',');
   return new Response(JSON.stringify({data:requested.reverse().map(id=>({id,attributes:{banType:'Innocent'}}))}));
  });
  const result=await fetchBanStatuses('steam',[...ids,ids[0]],{apiKey:'fixture',fetchImpl});
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(result.statuses).toHaveLength(11);
  expect(result.missingAccountIds).toEqual([]);
  expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('filter[playerIds]')!.split(',')).toHaveLength(10);
 });
 it('rejects wrong returned identity and keeps missing status unknown',async()=>{
  const wrong=async()=>new Response(JSON.stringify({data:[{id:'account.other',attributes:{banType:'None'}}]}));
  await expect(fetchBanStatusBatch('steam',['account.target'],{apiKey:'fixture',fetchImpl:wrong})).rejects.toMatchObject({code:'invalid_shape'});
  const absent=async()=>new Response(JSON.stringify({data:[{id:'account.target',attributes:{}}]}));
  const result=await fetchBanStatusBatch('steam',['account.target'],{apiKey:'fixture',fetchImpl:absent});
  expect(result.statuses[0].status).toBe('unknown');
 });
 it('honors the reset time on a 429 without Retry-After',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(1700000000000);
  const fetchImpl=async()=>new Response('',{status:429,headers:{'X-RateLimit-Reset':'1700000120'}});
  await expect(fetchBanStatusBatch('steam',['account.target'],{apiKey:'fixture',fetchImpl})).rejects.toMatchObject({code:'rate_limited',retryAfterSeconds:120});
 });
});
