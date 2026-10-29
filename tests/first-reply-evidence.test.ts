import {describe,it,expect} from 'vitest';
import {FirstReplyEvidenceCollector,firstReplyLatencyMs,rawFirstReplyLatencyMs} from '../lib/pubg-analysis/firstReply';
const shot=(id:number)=>({_T:'LogPlayerAttack',attackType:'Weapon',attackId:id,weapon:{itemId:'Item_Weapon_MP5K_C',category:'Weapon',subCategory:'Main'}});
describe('first reply evidence',()=>{
 it.each([[3,[-166,-66],2],[201,[-101,-34],166]])('separates a %sms ongoing burst without turning it into failure',(latency,before,replyShot)=>{
  const c=new FirstReplyEvidenceCollector(); const session={};before.forEach((t,i)=>c.attack(shot(i),1000+t));c.begin(session,1000);c.attack(shot(10),1000+replyShot);c.reply(session,{attackId:10},1000+latency);
  expect(c.result()).toMatchObject({version:1,alreadyFiringCount:1,eligibleCount:0,within3sCount:0,noReplyCount:0});
  expect(firstReplyLatencyMs({duelStats:{firstReplyWithin3sCount:1,firstReplyLatencySumMs:latency,firstReplyEvidence:c.result()}})).toBeNull();
  expect(rawFirstReplyLatencyMs({duelStats:{firstReplyWithin3sCount:1,firstReplyLatencySumMs:latency}})).toBe(latency);
 });
 it('retains a first reply linked to a shot after the first hit',()=>{const c=new FirstReplyEvidenceCollector();const s={};c.begin(s,1000);c.attack(shot(1),1450);c.reply(s,{attackId:1},1500);expect(c.result()).toMatchObject({eligibleCount:1,within3sCount:1,latencySumMs:500,noReplyCount:0});expect(firstReplyLatencyMs({duelStats:{firstReplyEvidence:c.result()}})).toBe(500);});
 it('withholds absent attack evidence and recent single shots',()=>{for(const recent of [false,true]){const c=new FirstReplyEvidenceCollector();const s={};if(recent)c.attack(shot(0),950);c.begin(s,1000);if(recent)c.attack(shot(1),1100);c.reply(s,{attackId:1},1200);expect(c.result()).toMatchObject({eligibleCount:0,unknownCount:1,noReplyCount:0});}});
 it('counts no reply only when attack logs exist and no firing preceded the session',()=>{const c=new FirstReplyEvidenceCollector();c.attack(shot(0),0);c.begin({},1000);expect(c.result()).toMatchObject({eligibleCount:1,noReplyCount:1});});
 it('never substitutes an old aggregate for new evidence',()=>{expect(firstReplyLatencyMs({duelStats:{firstReplyWithin3sCount:1,firstReplyLatencySumMs:3}})).toBeNull();});
});

it('does not discard a short valid reply solely because it is below 150ms',()=>{
 const c=new FirstReplyEvidenceCollector();const s={};c.begin(s,1000);c.attack(shot(1),1050);c.reply(s,{attackId:1},1100);
 expect(firstReplyLatencyMs({duelStats:{firstReplyEvidence:c.result()}})).toBe(100);
});
it('does not treat old fire or a weapon change as a confirmed burst',()=>{
 const c=new FirstReplyEvidenceCollector();const s={};c.attack(shot(1),0);c.attack(shot(2),100);c.begin(s,1000);c.attack(shot(3),1300);c.reply(s,{attackId:3},1400);
 expect(c.result()).toMatchObject({alreadyFiringCount:0,within3sCount:1,latencySumMs:400});
});
