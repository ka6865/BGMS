import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const m=vi.hoisted(()=>({context:vi.fn(),match:vi.fn(),read:vi.fn(),collect:vi.fn(),profile:vi.fn(),quota:vi.fn(),release:vi.fn()}));
vi.mock('@/lib/pubg/encounterPage.server',()=>({encounterContext:m.context,matchForContext:m.match,readEncounter:m.read,collectEncounter:m.collect,encounterProfile:m.profile}));
vi.mock('@/lib/pubg/deathEncounters.server',()=>({DeathEncounterSourceError:class extends Error {status=404;}}));
vi.mock('@/lib/pubg/banWatch.server',()=>({BanWatchError:class extends Error{constructor(public code:string,public status:number,message=code,public retryAfterSeconds?:number){super(message);}},acquireEncounterRequest:m.quota}));
import {POST} from '@/app/api/pubg/encounters/route';
import {BanWatchError} from '@/lib/pubg/banWatch.server';
const req=(body:unknown)=>new NextRequest('http://localhost/api/pubg/encounters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();m.context.mockResolvedValue({userId:'u'});m.match.mockResolvedValue({match_id:'m'});m.quota.mockReturnValue({allowed:true,release:m.release});m.collect.mockResolvedValue({encounters:[]});});
describe('상대 페이지 API 경계',()=>{
 it('로그인 없으면 관계/외부 API를 읽지 않는다',async()=>{m.context.mockRejectedValue(new BanWatchError('unauthenticated',401));expect((await POST(req({action:'collect'}))).status).toBe(401);expect(m.match).not.toHaveBeenCalled();});
 it('해당 경기에서 확인되지 않은 계정의 통계를 읽지 않는다',async()=>{m.read.mockResolvedValue({encounters:[{targetAccountId:'account.real'}]});expect((await POST(req({action:'profiles',targetAccountId:'account.other'}))).status).toBe(404);expect(m.profile).not.toHaveBeenCalled();});
 it('제한 시 외부 추출 없이 429와 재시도 시간을 반환한다',async()=>{m.quota.mockReturnValue({allowed:false,retryAfterSeconds:30});const res=await POST(req({action:'collect'}));expect(res.status).toBe(429);expect(res.headers.get('Retry-After')).toBe('30');expect(m.collect).not.toHaveBeenCalled();});
 it('추출 실패해도 사용자 잠금을 해제한다',async()=>{m.collect.mockRejectedValue(new Error('upstream'));expect((await POST(req({action:'collect'}))).status).toBe(503);expect(m.release).toHaveBeenCalledOnce();});
 it('잘못된 요청 본문은 400이다',async()=>{expect((await POST(req(null))).status).toBe(400);});
});
