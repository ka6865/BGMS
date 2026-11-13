import { CHAMPION_DATASET_MAX_FILE_BYTES } from './mayhemChampionDataset';
export type ChampionSourceVersion = { gamePatch: string; dataVersion: string; schemaVersion: 1 };
const ROOT='https://data.dtodo.cn/api/v1/ko';
const RESERVE=25;
export function createChampionSource(options: { fetcher?: typeof fetch; apiKey?: string; wait?: (ms:number)=>Promise<void>; beforeRequest?:()=>Promise<void>; onChampionList?:(response:{body:string;value:unknown;ids:number[]})=>Promise<void> } = {}) {
  const fetcher=options.fetcher ?? fetch; const wait=options.wait ?? (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let remaining: number | null=null; let previousRequest=0;
  async function request(path:string, paid=false, head=false) {
    if (paid && !options.apiKey) throw new Error('stats_api_key_missing');
    if (paid && !head && (remaining===null || remaining<=RESERVE)) throw new Error('stats_quota_deferred');
    await options.beforeRequest?.();
    const delay=1000-(Date.now()-previousRequest); if (delay>0) await wait(delay); previousRequest=Date.now();
    let response:Response;
    try { response=await fetcher(`${ROOT}/${path}`,{method:head?'HEAD':'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10_000),...(paid?{headers:{'x-api-key':options.apiKey!}}:{})}); }
    catch { throw new Error('stats_source_network'); }
    if (response.status===401 || response.status===403) throw new Error('stats_api_key_invalid');
    if (response.status===429) throw new Error('stats_quota_deferred');
    if (!response.ok) throw new Error('stats_source_status');
    if (paid) {
      const value=response.headers.get('x-credits-remaining');
      if (value===null || !/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('stats_quota_unverified');
      remaining=Number(value);
    }
    if (head) return {body:'',value:null};
    const length=response.headers.get('content-length'); if (length!==null && Number(length)>CHAMPION_DATASET_MAX_FILE_BYTES) { await response.body?.cancel();throw new Error('stats_source_too_large'); }
    const chunks:Uint8Array[]=[];let bytes=0;const reader=response.body?.getReader();
    if (!reader) throw new Error('stats_source_empty');
    try { while (true) { const part=await reader.read(); if(part.done)break;bytes+=part.value.byteLength;if(bytes>CHAMPION_DATASET_MAX_FILE_BYTES){await reader.cancel();throw new Error('stats_source_too_large');}chunks.push(part.value); } }
    // 본문 수신 중 끊김·10초 초과는 분류되지 않은 오류로 남지 않게 네트워크 오류로 기록한다.
    catch (error) { if (error instanceof Error && error.message==='stats_source_too_large') throw error; throw new Error('stats_source_network'); }
    finally {reader.releaseLock();}
    const body=Buffer.concat(chunks).toString('utf8');let value:unknown;
    try {value=JSON.parse(body);} catch {throw new Error('stats_source_json');}
    return {body,value};
  }
  async function config():Promise<ChampionSourceVersion> {
    const {value}=await request('config.json'); const v=value as Partial<ChampionSourceVersion>|null;
    if (!v || v.schemaVersion!==1 || typeof v.gamePatch!=='string' || !/^(15|16)\.[1-9][0-9]?$/.test(v.gamePatch)
      || typeof v.dataVersion!=='string' || !/^\d+\.\d+\.\d+$/.test(v.dataVersion) || !v.dataVersion.startsWith(`${v.gamePatch}.`)) throw new Error('stats_source_config');
    return {gamePatch:v.gamePatch,dataVersion:v.dataVersion,schemaVersion:1};
  }
  async function championList(version:ChampionSourceVersion):Promise<{body:string;value:unknown;ids:number[]}> {
    await request('champions.json',true,true);
    const {body,value}=await request('champions.json',true);const envelope=value as {meta?:ChampionSourceVersion;data?:Array<{id?:unknown}>}|null;
    if (envelope?.meta?.gamePatch!==version.gamePatch || envelope.meta.dataVersion!==version.dataVersion || !Array.isArray(envelope.data) || !envelope.data.length || envelope.data.length>300) throw new Error('stats_source_version');
    const ids=envelope.data.map(row=>row?.id);
    if (ids.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<=0||id>99999) || new Set(ids).size!==ids.length) throw new Error('stats_source_champions');
    return {body,value,ids:(ids as number[]).sort((a,b)=>a-b)};
  }
  async function champions(version:ChampionSourceVersion):Promise<number[]> { const response=await championList(version);await options.onChampionList?.(response);return response.ids; }
  async function champion(championId:number) {
    if(!Number.isSafeInteger(championId)||championId<=0||championId>99999)throw new Error('invalid_champion_id');
    return request(`data/champion-augments/${championId}.json`,true);
  }
  return {config,championList,champions,champion,remaining:()=>remaining};
}
