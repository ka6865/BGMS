import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchOfficialCalibrationSource } from '../lib/pubg-analysis/calibrationAcquisition';
import { isCanonicalMatchId } from '../lib/pubg-analysis/telemetryIdentity';

type AcquisitionState = { status:string; attempts:number; httpStatus?:number; stage?:string; readyAt?:number; bytes?:number };

export async function acquireCoachingSources(args:string[]) {
  const {values}=parseArgs({args,options:{subjects:{type:'string'},output:{type:'string'},limit:{type:'string',default:'200'}}});
  const limit=Number(values.limit);
  if(!values.subjects||!values.output||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('subjects/output and limit1..500 required');
  const subjects=JSON.parse(fs.readFileSync(values.subjects,'utf8')) as Array<{matches:Array<{match_id:string;played_at:string}>}>;
  if(!Array.isArray(subjects)||subjects.length>2000)throw new Error('subject cap exceeded');
  if(subjects.some(s=>!Array.isArray(s.matches)||s.matches.length>10||s.matches.some(r=>!isCanonicalMatchId(r.match_id)||!Number.isFinite(Date.parse(r.played_at)))))throw new Error('invalid frozen match window');
  const out=path.resolve(values.output);fs.mkdirSync(path.join(out,'sources'),{recursive:true,mode:0o700});
  const stateFile=path.join(out,'acquisition-private.json');
  const state:Record<string,AcquisitionState>=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
  const sourceExists=(id:string)=>['.json.gz','.json','.json.zst'].some(ext=>fs.existsSync(path.join(out,'sources',id+ext)));
  const pending=new Map<string,number>();
  const cutoff=Date.now()-14*86400000;
  const ordered=subjects.map(s=>({matches:s.matches,holes:s.matches.filter(r=>!sourceExists(r.match_id)).length})).sort((a,b)=>a.holes-b.holes);
  for(const s of ordered)for(const row of s.matches){
    if(!isCanonicalMatchId(row.match_id))throw new Error('invalid match identity');
    if(sourceExists(row.match_id))continue;
    if(!Number.isFinite(Date.parse(row.played_at)))throw new Error('invalid played time');
    if(Date.parse(row.played_at)<cutoff)continue;
    const prior=state[row.match_id];
    if(prior&&([403,404].includes(prior.httpStatus??0)||prior.attempts>=3||(prior.readyAt??0)>Date.now()))continue;
    if(!pending.has(row.match_id))pending.set(row.match_id,s.holes);
  }
  const ids=[...pending.keys()].slice(0,limit);let cursor=0,done=0,available=0,unavailable=0,failed=0,bytes=0;let stoppedReason:string|null=null;
  const save=()=>{const tmp=stateFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,stateFile);};
  async function worker(){
    while(cursor<ids.length){
      const space=fs.statfsSync(out);if(space.bavail*space.bsize<512*1024*1024){stoppedReason='low_local_disk';cursor=ids.length;break;}
      const id=ids[cursor++],attempts=(state[id]?.attempts??0)+1;
      try{
        const result=await fetchOfficialCalibrationSource(id,'steam');
        if(result.source){
          fs.writeFileSync(path.join(out,'sources',id+'.json.gz'),gzipSync(JSON.stringify(result.source)),{mode:0o600});
          available++;bytes+=result.bytes;
        }else unavailable++;
        state[id]={status:result.status,attempts,httpStatus:result.httpStatus,stage:result.stage,bytes:result.bytes,
          ...(result.status==='rate_limited'?{readyAt:Date.now()+(result.retryAfterSeconds??60)*1000}:{})};
        if(result.status==='rate_limited')cursor=ids.length;
      }catch(error){failed++;state[id]={status:error instanceof Error?error.name:'failed',attempts,readyAt:Date.now()+60000};}
      finally{done++;save();if(done%10===0)console.log(JSON.stringify({stage:'official_acquisition',done,total:ids.length,available,unavailable,failed,decodedMB:Math.round(bytes/1e6)}));}
    }
  }
  await Promise.all([worker(),worker()]);save();
  console.log(JSON.stringify({stage:'acquisition_complete',attempted:done,available,unavailable,failed,pendingBefore:pending.size,decodedBytes:bytes,stoppedReason}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))acquireCoachingSources(process.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:'acquisition_failed');process.exitCode=1;});
