import {NextRequest,NextResponse} from 'next/server';
import {encounterContext,matchForContext,readEncounter,collectEncounter,encounterProfile} from '@/lib/pubg/encounterPage.server';
import {BanWatchError,acquireEncounterRequest} from '@/lib/pubg/banWatch.server';
import {DeathEncounterSourceError} from '@/lib/pubg/deathEncounters.server';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=45;
const json=(body:unknown,status=200,extra:Record<string,string>={})=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store',...extra}});
function failed(error:unknown){
  if(error instanceof BanWatchError)return json({error:error.message},error.status,error.retryAfterSeconds?{'Retry-After':String(error.retryAfterSeconds)}:{});
  if(error instanceof DeathEncounterSourceError)return json({error:error.message},error.status);
  return json({error:'상대 기록을 불러오지 못했습니다.'},503);
}
export async function GET(request:NextRequest){try{
  const q=request.nextUrl.searchParams,c=await encounterContext(q.get('platform'),q.get('nickname'));
  const page=Number(q.get('page')||1);
  if(!Number.isInteger(page)||page<1||page>100)throw new BanWatchError('invalid_input',400,'페이지 번호가 올바르지 않습니다.');
  let query=c.db.from('pubg_player_matches').select('*',{count:'exact'}).eq('platform',c.platform).eq('player_id',c.playerId).gte('played_at',new Date(Date.now()-90*86400000).toISOString()).order('played_at',{ascending:false}).order('match_id',{ascending:false});
  if(q.get('matchId'))query=query.eq('match_id',q.get('matchId'));
  const {data,error,count}=await query.range((page-1)*10,page*10-1);
  if(error)throw error;
  const matches=[];
  for(const m of data||[]){if(m.account_id&&m.account_id!==c.accountId)continue;matches.push({...m,encounter:await readEncounter(c,m.match_id)});}
  return json({matches,page,totalPages:Math.ceil((count||0)/10),accountId:c.accountId,nickname:c.nickname});
}catch(error){return failed(error);}}
export async function POST(request:NextRequest){let release:(()=>void)|undefined;try{
  const body=await request.json().catch(()=>{throw new BanWatchError('invalid_input',400,'요청 형식이 올바르지 않습니다.');});
  if(!body||typeof body!=='object'||Array.isArray(body))throw new BanWatchError('invalid_input',400);
  const c=await encounterContext(body.platform,body.nickname);
  const match=await matchForContext(c,body.matchId);
  if(body.action==='profiles'){
    const record=await readEncounter(c,match.match_id);
    if(!record?.encounters.some(e=>e.targetAccountId===body.targetAccountId))throw new BanWatchError('not_found',404,'경기에서 확인한 상대가 아닙니다.');
    return json({profile:await encounterProfile(c,body.targetAccountId,match,body.refresh===true)});
  }
  if(body.action!=='collect')throw new BanWatchError('invalid_input',400);
  const quota=acquireEncounterRequest(c.userId);if(!quota.allowed)throw new BanWatchError('rate_limited',429,'상대 기록을 차례로 확인 중입니다.',quota.retryAfterSeconds);
  release=quota.release;return json({encounter:await collectEncounter(c,match.match_id)});
}catch(error){return failed(error);}finally{release?.();}}
