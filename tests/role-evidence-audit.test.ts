import {describe,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

describe('local role evidence audit',()=>{
 it('imports without network and reports absent raw sources without inventing evidence',async()=>{
  const fetch=vi.fn(()=>{throw new Error('network forbidden');});vi.stubGlobal('fetch',fetch);
  const root=mkdtempSync(join(tmpdir(),'bgms-role-evidence-'));
  try{
   const {runRoleEvidenceAudit}=await import('../scripts/audit_role_evidence');
   const id='00000000-0000-4000-8000-000000000001';
   const matches=Array.from({length:3},(_,i)=>({...{match_id:id.slice(0,-1)+(i+1),played_at:'2026-10-27',game_mode:'squad',match_type:'official'}}));
   const results=matches.map(row=>({matchId:row.match_id,createdAt:'2026-10-27',gameMode:'squad',matchType:'official',platform:'steam',v:73,calculationVersion:5,populationEvidenceVersion:1,benchmark:{score:50,tier:'B'},stats:{playerId:'account.fixture'}}));
   const input=join(root,'input.json'),output=join(root,'result.json');
   writeFileSync(input,JSON.stringify([{account:'account.fixture',name:'Fixture',queriedAt:'2026-10-28',matches,results}]));
   await runRoleEvidenceAudit(['--input',input,'--source-dir',root,'--output',output]);
   expect(JSON.parse(readFileSync(output,'utf8'))).toMatchObject({activationAllowed:false,evidenceVersion:1,sourceInventory:{eligibleProfiles:1,completeSourceProfiles:0},replayedProfiles:0});
   expect(fetch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();rmSync(root,{recursive:true,force:true});}
 });
});
