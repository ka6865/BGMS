import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),send:vi.fn(),updateMessage:vi.fn(),writes:[] as unknown[],review:null as any}));
vi.mock('../lib/community-agent/auth',()=>({createCommunityStore:()=>({client:{rpc:m.rpc,from:()=>({select:()=>({eq:()=>({limit:async()=>({data:[],error:null}),maybeSingle:async()=>({data:m.review,error:null})})}),update:(patch:unknown)=>{m.writes.push(patch);const chain={eq:()=>chain,then:(f:(value: {error: null}) => unknown)=>Promise.resolve({error:null}).then(v=>f(v))};return chain;}})}})}));
vi.mock('../lib/community-agent/discord-review',()=>({sendReviewNotification:m.send,updateReviewNotification:m.updateMessage}));
import {notifyNextReview,syncReviewDecisionNotification} from '../lib/community-agent/reviews';
beforeEach(()=>{vi.clearAllMocks();m.writes.length=0;m.review={id:'review',status:'pending',notification_attempts:1};m.rpc.mockResolvedValue({data:m.review,error:null});m.send.mockResolvedValue({messageId:'message'});m.updateMessage.mockResolvedValue(undefined);});
describe('review outbox',()=>{
 it('does not send when another worker owns all claims',async()=>{m.rpc.mockResolvedValue({data:null,error:null});expect(await notifyNextReview()).toEqual({code:'no_work'});expect(m.send).not.toHaveBeenCalled();});
 it('retains the draft and schedules another notification attempt on failure',async()=>{m.send.mockRejectedValue(new Error('provider secret should not persist'));expect(await notifyNextReview()).toEqual({code:'notification_failed',reviewId:'review'});expect(m.writes[0]).toMatchObject({notification_error:'discord_notification_failed'});expect(JSON.stringify(m.writes)).not.toContain('provider secret');expect(m.writes.some((v:any)=>v.status==='published')).toBe(false);});
 it('records the sent message without publishing content',async()=>{expect(await notifyNextReview()).toEqual({code:'notified',reviewId:'review'});expect(m.writes[0]).toMatchObject({discord_message_id:'message',notification_error:null,notification_lease_until:null});expect(m.rpc).toHaveBeenCalledExactlyOnceWith('claim_community_review_notification');});
 it('updates the message if a human decided while initial delivery was in flight',async()=>{m.send.mockImplementation(async()=>{m.review={...m.review,status:'published',discord_message_id:'message'};return {messageId:'message'};});await notifyNextReview();expect(m.updateMessage).toHaveBeenCalledWith(expect.objectContaining({status:'published'}));});
});

it('retains failed decision-message updates for worker recovery',async()=>{
 m.review={...m.review,status:'published',discord_message_id:'message'};
 m.updateMessage.mockRejectedValueOnce(new Error('temporary Discord error'));
 await syncReviewDecisionNotification('review');
 expect(m.writes).toContainEqual({notification_error:'discord_decision_update_failed'});
 expect(m.rpc).not.toHaveBeenCalled();
});
