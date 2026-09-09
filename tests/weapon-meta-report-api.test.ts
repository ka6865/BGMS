import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }));
beforeEach(() => {
  vi.resetModules(); rpc.mockReset();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','fixture');
  vi.stubEnv('PUBG_META_PATCH_VERSION','test');
  vi.stubEnv('PUBG_META_PATCH_STARTED_AT','2026-08-12T03:00:00Z');
});
afterEach(() => vi.unstubAllEnvs());
describe('weapon meta aggregate report boundary', () => {
  it('preserves saved metrics and database totals above the REST row cap', async () => {
    rpc.mockResolvedValue({ data: { baselineSource: 'legacy_reference', comparison: [{ weapon_name:'AKM',weapon_category:'AR',period:'pre',player_match_count:1200,active_pick_count:300,total_damage:30000,total_kills:100,total_dbnos:100,sustained_hits:20,burst_sample_count:20 }], burstCollection:{pre:{total:1200,completed:900},post:{total:5000,completed:4000}},dailyWeaponTrend:[],scopePickShares:[],population:{pre:{stored:1200,verified:0,legacy:1200,unclassified:0}} }, error:null });
    const {GET}=await import('../app/api/pubg/meta/route');
    const response=await GET(new NextRequest('http://localhost/api/pubg/meta'));
    const body=await response.json();
    expect(response.status).toBe(200);
    expect(body.baselineSource).toBeUndefined();
    expect(body.weapons[0].pre_patch).toMatchObject({match_count:1200,pick_share:25,avg_damage:100});
    expect(body.burstCollection.post.total).toBe(5000);
    expect(body.weapons[0].post_patch.match_count).toBe(5000);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_weapon_meta_patch_report',expect.objectContaining({p_patch_version:null,p_match_type:'all'}));
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=60');
  });
  it('keeps the historical patch and competitive filter at the database boundary', async () => {
    rpc.mockResolvedValue({data:{comparison:[],baselineSource:'verified',dailyWeaponTrend:[],scopePickShares:[],burstCollection:{pre:{total:0,completed:0},post:{total:0,completed:0}}},error:null});
    const {GET}=await import('../app/api/pubg/meta/route');
    const response=await GET(new NextRequest('http://localhost/api/pubg/meta?patch=42.3&matchType=competitive'));
    expect((await response.json()).weapons).toEqual([]);
    expect(rpc).toHaveBeenCalledWith('get_weapon_meta_patch_report',expect.objectContaining({p_patch_version:'42.3',p_match_type:'competitive'}));
  });
  it('keeps a legacy-only report collecting while the post-patch period is empty', async () => {
    rpc.mockResolvedValue({data:{baselineSource:'legacy_reference',comparison:[{weapon_name:'AKM',weapon_category:'AR',period:'pre',player_match_count:10,active_pick_count:5,total_damage:500}],burstCollection:{pre:{total:10,completed:0},post:{total:0,completed:0}},dailyWeaponTrend:[],scopePickShares:[]},error:null});
    const {GET}=await import('../app/api/pubg/meta/route');
    const body=await (await GET(new NextRequest('http://localhost/api/pubg/meta'))).json();
    expect(body.status).toBe('collecting');
    expect(body.message).toContain('패치 후 표본');
    expect(body.weapons[0].post_patch.match_count).toBe(0);
  });
  it('fails visibly instead of returning a misleading empty success on database errors', async () => {
    rpc.mockResolvedValue({data:null,error:{code:'test'}});
    const {GET}=await import('../app/api/pubg/meta/route');
    const response=await GET(new NextRequest('http://localhost/api/pubg/meta'));
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('unavailable');
    expect(response.headers.get('Cache-Control')).toBeNull();
  });
});

it('rejects unknown patches without showing an unrelated report',async()=>{
 rpc.mockResolvedValue({data:null,error:{code:'22023'}});
 const {GET}=await import('../app/api/pubg/meta/route');
 const response=await GET(new NextRequest('http://localhost/api/pubg/meta?patch=99.9'));
 expect(response.status).toBe(400);
});
it('shows the scheduled patch without inventing post-patch results',async()=>{
 rpc.mockResolvedValue({data:{patchVersion:'43.1',scheduled:true,comparison:[],patches:[{version:'43.1'}],burstCollection:{pre:{total:12,completed:0},post:{total:0,completed:0}}},error:null});
 const {GET}=await import('../app/api/pubg/meta/route');
 const body=await (await GET(new NextRequest('http://localhost/api/pubg/meta'))).json();
 expect(body.patchVersion).toBe('43.1');
 expect(body.message).toContain('적용 예정');
 expect(body.burstCollection.post.total).toBe(0);
});
