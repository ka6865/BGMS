import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({actor:vi.fn(),rpc:vi.fn(),recentRuns:vi.fn(),enqueue:vi.fn(),notify:vi.fn(),reply:vi.fn()}));
vi.mock('../lib/community-agent/auth',()=>({resolveCommunityActor:m.actor,createCommunityStore:()=>({client:{rpc:m.rpc},store:{recentRuns:m.recentRuns}})}));
vi.mock('../lib/community-agent/reviews',()=>({enqueuePostReview:m.enqueue,notifyNextReview:m.notify}));
vi.mock('../lib/community-agent/replies',()=>({processReplyDraft:m.reply}));
import {GET,POST} from '../app/api/admin/agent/community/reviews/route';
const id='33333333-3333-4333-8333-333333333333';
const req=(body:unknown)=>new Request('https://bgms.test/api/admin/agent/community/reviews',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();m.actor.mockResolvedValue({kind:'admin',userId:'admin-id'});m.rpc.mockResolvedValue({data:{code:'target_changed'},error:null});m.recentRuns.mockResolvedValue([]);m.reply.mockResolvedValue({code:'no_work'});m.notify.mockResolvedValue({code:'no_work'});});
describe('community review authority',()=>{
 it('rejects unauthenticated reads and decisions',async()=>{m.actor.mockResolvedValue(new Response('',{status:401}));expect((await GET(new Request('https://bgms.test'))).status).toBe(401);expect((await POST(req({action:'approve',id}))).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();});
 it.each(['approve','reject','notify'])('worker cannot %s',async(action)=>{m.actor.mockResolvedValue({kind:'worker',userId:null});expect((await POST(req({action,id}))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();});
 it('worker cannot read private drafts',async()=>{m.actor.mockResolvedValue({kind:'worker',userId:null});expect((await GET(new Request('https://bgms.test'))).status).toBe(403);});
 it('derives approval identity from session, accepts no body or actor override',async()=>{expect((await POST(req({action:'approve',id,body:'injected',actor:'admin'}))).status).toBe(400);const res=await POST(req({action:'approve',id}));expect(await res.json()).toEqual({result:{code:'target_changed'}});expect(m.rpc).toHaveBeenCalledWith('decide_community_review',{p_review_id:id,p_decision:'approve',p_actor_id:'admin-id'});});
 it('bounds chunked input',async()=>{expect((await POST(req({action:'approve',id:'x'.repeat(3000)}))).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();});
 it('worker creates drafts and notifications only',async()=>{m.actor.mockResolvedValue({kind:'worker',userId:null});m.recentRuns.mockResolvedValue([{id,status:'ready'},{id:'done',status:'published'}]);expect((await POST(req({action:'process'}))).status).toBe(200);expect(m.enqueue).toHaveBeenCalledExactlyOnceWith(id);expect(m.reply).toHaveBeenCalledOnce();expect(m.notify).toHaveBeenCalledOnce();expect(m.rpc).not.toHaveBeenCalled();});
});
