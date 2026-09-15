'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,UserPlus,RefreshCw} from 'lucide-react';
import {useAuth} from '@/components/AuthProvider';
import {BanWatchPanel} from '@/components/stat/BanWatchPanel';
import type {DeathEncounterLoadResult} from '@/lib/pubg/deathEncounters.server';
import type {DeathEncounter} from '@/lib/pubg/deathEncounters';
import type {EncounterProfile} from '@/lib/pubg/encounterProfiles';

type Match={match_id:string;map_name:string;played_at:string;game_mode:string;match_type:string;encounter:DeathEncounterLoadResult|null;error?:string};
type Props={platform:'steam'|'kakao';nickname:string;matchId?:string};
const MAPS:Record<string,string>={Baltic_Main:'에란겔',Desert_Main:'미라마',Savage_Main:'사녹',Tiger_Main:'태이고',Kiki_Main:'데스턴',Neon_Main:'론도',DihorOtok_Main:'비켄디'};
function when(value:string){return new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function modeLabel(mode:string){return `${mode.startsWith('solo')?'솔로':mode.startsWith('duo')?'듀오':'스쿼드'} ${mode.endsWith('fpp')?'FPP':'TPP'}`;}
const button='inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-bold text-white/80 hover:bg-white/10 disabled:opacity-40';

function Opponent({entry,related,match,platform,nickname,autoRefresh}:{entry:DeathEncounter;related:DeathEncounter[];match:Match;autoRefresh:boolean}&Props){
  const [profile,setProfile]=useState<EncounterProfile|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[registered,setRegistered]=useState(false);
  const active=useRef(true);
  const loadProfile=useCallback(async(refresh:boolean,signal?:AbortSignal)=>{
    setBusy(true);setMessage('');
    try{
      const res=await fetch('/api/pubg/encounters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'profiles',platform,nickname,matchId:match.match_id,targetAccountId:entry.targetAccountId,refresh}),signal});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'통계를 확인하지 못했습니다.');
      if(active.current&&!signal?.aborted){setProfile(data.profile);if(data.profile.retryAt)setMessage(`통계 확인 대기 · ${when(data.profile.retryAt)} 이후 다시 확인할 수 있습니다.`);else if(data.profile.pending)setMessage('통계 확인 대기 · 잠시 후 다시 확인해주세요.');}
    }catch(error){if(active.current&&!signal?.aborted)setMessage(error instanceof Error?error.message:'통계 확인 지연');}
    finally{if(active.current&&!signal?.aborted)setBusy(false);}
  },[entry.targetAccountId,match.match_id,nickname,platform]);
  useEffect(()=>{active.current=true;const c=new AbortController();void loadProfile(autoRefresh,c.signal);return()=>{active.current=false;c.abort();};},[autoRefresh,loadProfile]);
  const register=async()=>{
    setBusy(true);setMessage('');
    try{
      const res=await fetch('/api/pubg/ban-watch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...entry,subjectNicknameAtMatch:match.encounter?.source.verifiedSubjectNicknameAtMatch||nickname})});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'관심 등록을 하지 못했습니다.');
      if(active.current){setRegistered(true);setMessage('개인 관심 목록에 등록했습니다.');}
    }catch(error){if(active.current)setMessage(error instanceof Error?error.message:'관심 등록 실패');}finally{if(active.current)setBusy(false);}
  };
  return <article className="rounded-2xl border border-white/10 bg-[#161616] p-4" data-testid="encounter-card">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-all text-base font-bold text-white">{entry.nicknameAtMatch}</h2><p className="mt-1 text-xs text-white/50">{related.map(e=>e.role==='knocker'?'기절':e.role==='finisher'?'마무리':'킬 인정').join(' · ')}</p></div><button className={button+' shrink-0'} onClick={()=>void register()} disabled={busy||registered}><UserPlus size={14}/>{registered?'등록됨':'관심 등록'}</button></div>
    <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs"><dt className="text-white/45">공식 경쟁전 티어</dt><dd className="text-right font-semibold text-indigo-200">{profile?.tier|| (profile?.rankedCheckedAt?'미배치 / 기록 없음':'확인 대기')}<span className="ml-2 text-white/40">{modeLabel(match.game_mode)}</span></dd><dt className="text-white/45">시즌 평균 딜량</dt><dd className="text-right font-semibold text-white">{profile?.averageDamage??(profile?.rounds===0?'기록 없음':'—')} {profile?.rounds!==null&&profile?.rounds!==undefined&&<span className="text-white/40">· {profile.rounds}경기</span>}</dd></dl>
    <p className="mt-2 text-right text-[11px] leading-relaxed text-white/40">{match.match_type==='competitive'?'경쟁전':'일반전'} · {modeLabel(match.game_mode)}{profile?.seasonId&&<> · 시즌 {profile.seasonId.split('-').pop()}</>}{profile?.checkedAt&&<> · 조회 {when(profile.checkedAt)}</>}</p>
    <p className="mt-4 text-xs leading-relaxed text-white/55">{when(entry.eventAt)} · {MAPS[match.map_name]||match.map_name} · {entry.weapon?.replace(/^Weap/,'').replace(/_C$/,'')||'무기 정보 없음'}</p>
    <div className="mt-3 flex flex-wrap gap-2"><Link className={button} href={`/stats/${platform}/${encodeURIComponent(entry.nicknameAtMatch)}`}>상대 전적</Link><Link className={button} href={`/stats/${platform}/${encodeURIComponent(nickname)}/matches/${encodeURIComponent(match.match_id)}`}>해당 경기</Link><button className={button} onClick={()=>void loadProfile(true)} disabled={busy}><RefreshCw size={13} className={busy?'animate-spin':''}/>티어·평딜 확인</button></div>
    {message&&<p role="status" className="mt-3 text-xs leading-relaxed text-amber-100/75">{message}</p>}
  </article>;
}

export default function EncountersClient({platform,nickname,matchId}:Props){
  const {user,loading:authLoading}=useAuth();
  const [tab,setTab]=useState<'knocker'|'killer'|'watch'>('killer'),[matches,setMatches]=useState<Match[]>([]),[page,setPage]=useState(1),[pages,setPages]=useState(0),[loading,setLoading]=useState(false),[collecting,setCollecting]=useState(false),[error,setError]=useState('');
  const userId=user?.id;
  const identity=`${userId||''}:${platform}:${nickname}:${matchId||''}:${page}`;
  const request=useRef<AbortController|null>(null),matchesRef=useRef<Match[]>([]);
  const update=(rows:Match[])=>{matchesRef.current=rows;setMatches(rows);};
  const collect=useCallback(async(rows:Match[],controller:AbortController)=>{
    setCollecting(true);
    try{for(const row of rows){
      if(controller.signal.aborted)return;if(row.encounter||row.error)continue;
      const res=await fetch('/api/pubg/encounters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'collect',platform,nickname,matchId:row.match_id}),signal:controller.signal});
      const data=await res.json();if(controller.signal.aborted)return;
      if(res.status===429){setError('남은 기록은 잠시 후 계속 확인할 수 있습니다.');break;}
      const next=matchesRef.current.map(m=>m.match_id!==row.match_id?m:{...m,...(res.ok?{encounter:data.encounter}:{error:data.error||'원본 기록 확인 불가'})});update(next);
    }}catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:'상대 기록 확인 지연');}
    finally{if(!controller.signal.aborted)setCollecting(false);}
  },[platform,nickname]);
  useEffect(()=>{
    request.current?.abort();const c=new AbortController();request.current=c;update([]);setError('');setCollecting(false);
    if(!userId){setLoading(false);return()=>c.abort();}
    setLoading(true);
    void(async()=>{try{
      const q=new URLSearchParams({platform,nickname,page:String(page)});if(matchId)q.set('matchId',matchId);
      const res=await fetch(`/api/pubg/encounters?${q}`,{cache:'no-store',signal:c.signal}),data=await res.json();
      if(!res.ok)throw new Error(data.error||'상대 기록을 불러오지 못했습니다.');if(c.signal.aborted)return;
      update(data.matches||[]);setPages(data.totalPages||0);setLoading(false);await collect(data.matches||[],c);
    }catch(error){if(!c.signal.aborted)setError(error instanceof Error?error.message:'조회 실패');}finally{if(!c.signal.aborted)setLoading(false);}})();
    return()=>c.abort();
  },[identity,userId,platform,nickname,page,matchId,collect]);
  const rows=matches.flatMap(match=>{
    const entries=match.encounter?.encounters.filter(e=>tab==='knocker'?e.role==='knocker':e.role!=='knocker')||[];
    return entries.filter((e,i)=>entries.findIndex(other=>other.targetAccountId===e.targetAccountId&&other.eventAt===e.eventAt)===i).map(entry=>({match,entry,related:entries.filter(e=>e.targetAccountId===entry.targetAccountId&&e.eventAt===entry.eventAt)}));
  });
  return <main className="mx-auto min-h-screen max-w-3xl px-4 pb-32 pt-6 text-white">
    <Link href={`/stats/${platform}/${encodeURIComponent(nickname)}`} className={button}><ArrowLeft size={15}/>전적으로 돌아가기</Link>
    <h1 className="mt-6 text-2xl font-bold">만난 상대</h1><p className="mt-2 break-all text-sm text-white/50">기준 플레이어: {nickname} · {platform==='kakao'?'Kakao':'Steam'}</p><p className="mt-2 text-xs leading-relaxed text-white/40">경기에서 만난 상대의 기록을 살펴보고, 다시 확인할 상대를 개인 관심 목록에 등록하세요.</p>
    <div className="mt-6 flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="상대 목록"><button role="tab" aria-selected={tab==='knocker'} className={button+' shrink-0'+(tab==='knocker'?' bg-indigo-500/20':'')} onClick={()=>setTab('knocker')}>나를 기절시킨 상대</button><button role="tab" aria-selected={tab==='killer'} className={button+' shrink-0'+(tab==='killer'?' bg-indigo-500/20':'')} onClick={()=>setTab('killer')}>나를 처치한 상대</button><button role="tab" aria-selected={tab==='watch'} className={button+' shrink-0'+(tab==='watch'?' bg-indigo-500/20':'')} onClick={()=>setTab('watch')}>관심 등록</button></div>
    {authLoading?<p className="py-10 text-sm text-white/50">로그인 확인 중…</p>:!user?<div className="mt-6 rounded-2xl border border-white/10 p-5"><p className="mb-4 text-sm">상대 기록과 개인 관심 목록은 로그인 후 확인할 수 있습니다.</p><Link className={button} href="/login">로그인</Link></div>:<>
      {tab==='watch'?<div className="mt-4"><p className="mb-3 text-xs text-white/45">내 관심 등록 전체 · 제재 상태는 마지막 조회 시점 기준입니다.</p><BanWatchPanel/></div>:<>
        <div className="my-4 flex flex-wrap items-center justify-between gap-2 text-xs text-white/45"><span>{loading?'경기 목록 확인 중…':`확인 ${matches.filter(m=>m.encounter).length} / ${matches.length}경기 · 최근 90일 저장 기록`}</span><button className={button} disabled={loading||collecting||matches.length===0} onClick={()=>{setError('');const rows=matchesRef.current.map(m=>({...m,error:undefined}));update(rows);if(request.current)void collect(rows,request.current);}}>{collecting?'상대 확인 중…':'남은 기록 다시 확인'}</button></div>
        {error&&<p role="alert" className="mb-4 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-100">{error}</p>}
        <div className="space-y-3">{rows.map(({match,entry,related},index)=><Opponent key={`${identity}:${match.match_id}:${entry.targetAccountId}:${entry.eventAt}:${tab}`} match={match} entry={entry} related={related} platform={platform} nickname={nickname} autoRefresh={index===0}/>)}</div>
        {!loading&&!collecting&&rows.length===0&&<p className="py-10 text-center text-sm text-white/45">확인된 상대 기록이 없습니다.</p>}
        {matches.filter(m=>m.error).map(m=><p key={m.match_id} className="mt-3 text-xs text-white/40">{when(m.played_at)} · {m.error}</p>)}
        <nav aria-label="상대 경기 페이지" className="mt-6 flex items-center justify-center gap-4"><button className={button} disabled={page<=1||loading} onClick={()=>setPage(p=>p-1)}>이전</button><span className="text-xs text-white/50">{page} / {Math.max(1,pages)}</span><button className={button} disabled={page>=pages||loading} onClick={()=>setPage(p=>p+1)}>다음</button></nav>
      </>}
    </>}
  </main>;
}
