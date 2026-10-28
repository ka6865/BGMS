import * as zlib from 'node:zlib';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchOfficialCalibrationSource} from '../lib/pubg-analysis/calibrationAcquisition';
const id='11111111-1111-4111-8111-111111111111';
const match={data:{id,attributes:{shardId:'steam',createdAt:'2026-10-27T00:00:00Z',mapName:'Baltic_Main',gameMode:'duo',matchType:'competitive',duration:600},relationships:{assets:{data:[{type:'asset',id:'asset-one'}]}}},included:[
 {id:'asset-one',type:'asset',attributes:{URL:'https://telemetry-cdn.pubg.com/pc/asset-one-telemetry.json'}},
 {id:'p1',type:'participant',attributes:{stats:{name:'A',playerId:'account.A',kills:1,damageDealt:100,winPlace:1,timeSurvived:600}}},
 {id:'r1',type:'roster',relationships:{participants:{data:[{id:'p1'}]}}},
]};
const events=[{_T:'LogMatchDefinition',MatchId:`match.bro.official.pc.steam.duo.${id}`},{_T:'LogPlayerPosition',_D:'2026-10-27T00:00:01Z',character:{name:'A',accountId:'account.A',location:{x:1,y:2,z:3}}}];
afterEach(()=>vi.unstubAllGlobals());
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
describe('read-only official calibration acquisition',()=>{
 it('binds match, unique asset, event definition and source checksum without auth leakage',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(json(match)).mockResolvedValueOnce(json(events));vi.stubGlobal('fetch',fetch);
  const result=await fetchOfficialCalibrationSource(id,'steam');
  expect(result.status).toBe('available');expect(result.source?.matchId).toBe(id);expect(result.source?.checksum).toMatch(/^[a-f0-9]{64}$/);
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
 });
 it.each([404,403,429])('keeps HTTP %s unavailable instead of manufacturing source',async status=>{
  const fetch=vi.fn().mockResolvedValueOnce(json({},status));vi.stubGlobal('fetch',fetch);
  const result=await fetchOfficialCalibrationSource(id,'steam');expect(result.source).toBeUndefined();expect(result.httpStatus).toBe(status);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects a copied match and an untrusted telemetry URL before downloading it',async()=>{
  for(const value of [{...match,data:{...match.data,id:'copied'}},{...match,included:match.included.map(x=>x.type==='asset'?{...x,attributes:{URL:'https://evil.example/asset-one-telemetry.json'}}:x)}]){
   const fetch=vi.fn().mockResolvedValueOnce(json(value));vi.stubGlobal('fetch',fetch);
   await expect(fetchOfficialCalibrationSource(id,'steam')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  }
 });
 it('rejects event data bound to a different match',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(json(match)).mockResolvedValueOnce(json([{...events[0],MatchId:'match.bro.official.pc.steam.duo.other'},events[1]])));
  await expect(fetchOfficialCalibrationSource(id,'steam')).rejects.toThrow(/definition/);
 });
 it('rejects unsafe IDs without network',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(fetchOfficialCalibrationSource('../other','steam')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});

it('recovers a previously available local source when its file is missing',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const acquisition=await import('../lib/pubg-analysis/calibrationAcquisition');
 const{createSharedTelemetrySource}=await import('../lib/pubg-analysis/sharedTelemetrySourceContract');
 const{acquireCoachingSources}=await import('../scripts/acquire_coaching_sources');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bgms-acquire-'));
 const spy=vi.spyOn(acquisition,'fetchOfficialCalibrationSource').mockResolvedValue({status:'available',stage:'telemetry',httpStatus:200,bytes:100,source:createSharedTelemetrySource(match,'steam',events)});
 try{
  fs.writeFileSync(path.join(dir,'subjects.json'),JSON.stringify([{matches:[{match_id:id,played_at:new Date().toISOString()}]}]));
  fs.writeFileSync(path.join(dir,'acquisition-private.json'),JSON.stringify({[id]:{status:'available',attempts:1,httpStatus:200}}));
  await acquireCoachingSources(['--subjects',path.join(dir,'subjects.json'),'--output',dir,'--limit','1']);
  expect(spy).toHaveBeenCalledOnce();expect(fs.existsSync(path.join(dir,'sources',id+'.json.gz'))).toBe(true);
 }finally{spy.mockRestore();fs.rmSync(dir,{recursive:true,force:true});}
});

it('keeps calibration fields while dropping the unused scene report from a fresh calculation',async()=>{
 const{calculateCalibrationResult}=await import('../scripts/calibrate_coaching_reference');
 const{createSharedTelemetrySource}=await import('../lib/pubg-analysis/sharedTelemetrySourceContract');
 const source=createSharedTelemetrySource(match,'steam',events),before=JSON.stringify(source);
 const result=calculateCalibrationResult(source,'account.A','A');
 expect(result.matchReport).toBeUndefined();expect(Reflect.get(result.stats,'playerId')).toBe('account.A');expect(result.matchId).toBe(id);
 expect(result.duelStats.firstReplyEvidence).toMatchObject({version:1});expect(JSON.stringify(source)).toBe(before);
});

it.runIf(typeof Reflect.get(zlib,'zstdCompressSync')==='function')('reads the same local source from plain, gzip and zstd cache formats',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const{readLocalCalibrationSource}=await import('../scripts/calibrate_coaching_reference');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bgms-source-formats-')),raw=JSON.stringify(match);
 try{
  for(const [ext,bytes]of [['.json',Buffer.from(raw)],['.json.gz',zlib.gzipSync(raw)],['.json.zst',Reflect.get(zlib,'zstdCompressSync')(raw)]] as const){
   const file=path.join(dir,id+ext);fs.writeFileSync(file,bytes);expect(readLocalCalibrationSource(dir,id)).toBe(raw);fs.unlinkSync(file);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
