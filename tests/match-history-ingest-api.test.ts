import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({private:vi.fn(),history:vi.fn(),db:vi.fn<(...args:unknown[])=>any>(()=>({}))}));
vi.mock('@supabase/supabase-js',()=>({createClient:mocks.db}));
vi.mock('@/lib/pubg/privatePlayers',()=>({isPlayerPrivate:mocks.private}));
vi.mock('@/lib/pubg/privatePlayerIdentity',()=>({resolvePrivatePlayerAccountId:vi.fn().mockResolvedValue(null)}));
vi.mock('@/lib/pubg/playerMatches',()=>({
  fetchPlayerMatchesPaginated:mocks.history,
  normalizePlayerMatchesPage:(x:string)=>Number(x)||1,
  normalizePlayerMatchHistoryFilter:(x:string|null)=>['normal','ranked','casual','tdm'].includes(x||'')?x:'all',
}));
import { GET } from '../app/api/pubg/player/matches/route';
const req=(suffix='')=>new NextRequest('http://localhost/api/pubg/player/matches?nickname=Zucchini__&platform=steam'+suffix);
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test');mocks.private.mockResolvedValue(false);mocks.history.mockResolvedValue({matches:[],page:2,pageSize:20,totalPages:5,totalCount:99});
  const cacheQuery:any={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:{id:'account.zucchini'},error:null})};
  cacheQuery.select.mockReturnValue(cacheQuery);cacheQuery.eq.mockReturnValue(cacheQuery);
  mocks.db.mockReturnValue({from:vi.fn(()=>cacheQuery)});
});
afterEach(()=>vi.unstubAllEnvs());
describe('stored history boundary',()=>{
  it('retrieves one exact owner/platform match without walking history pages',async()=>{
    const chain={select:vi.fn(),eq:vi.fn(),limit:vi.fn()};
    chain.select.mockReturnValue(chain);chain.eq.mockReturnValue(chain);
    chain.limit.mockResolvedValue({data:[{match_id:'old-match',player_id:'zucchini__',platform:'steam'}],error:null});
    mocks.db.mockReturnValueOnce({from:vi.fn(()=>chain)});
    const response=await GET(req('&matchId=old-match'));
    expect(response.status).toBe(200);
    expect((await response.json()).matches).toHaveLength(1);
    expect(chain.eq.mock.calls.slice(0,3)).toEqual([['player_id','zucchini__'],['platform','steam'],['match_id','old-match']]);
    expect(chain.limit).toHaveBeenCalledWith(1);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('rejects malformed target IDs before accessing the database',async()=>{
    expect((await GET(req('&matchId=bad%2Fmatch'))).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('does not return another player history when the requested match is absent',async()=>{
    const chain={select:vi.fn(),eq:vi.fn(),limit:vi.fn().mockResolvedValue({data:[],error:null})};
    chain.select.mockReturnValue(chain);chain.eq.mockReturnValue(chain);
    mocks.db.mockReturnValueOnce({from:vi.fn(()=>chain)});
    expect((await GET(req('&matchId=absent'))).status).toBe(404);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('returns stored totals and preserves the requested page without exposing worker progress',async()=>{
    const response=await GET(req('&page=2&filter=ranked'));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body=await response.json();
    expect(body).toMatchObject({page:2,totalCount:99});
    expect(body.historyIngest).toBeUndefined();
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(),'Zucchini__','steam',2,20,'ranked');
  });
  it('never exposes history of a private player',async()=>{
    mocks.private.mockResolvedValue(true);
    expect((await GET(req())).status).toBe(403);expect(mocks.history).not.toHaveBeenCalled();
  });
  it('checks discovered account IDs when the page and cache have no identity',async()=>{
    mocks.private.mockImplementation(async (_platform: string, _nickname: string, accountId?: string) => accountId === 'account.hidden');
    const cacheQuery:any={select:vi.fn(),eq:vi.fn(),maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})};
    cacheQuery.select.mockReturnValue(cacheQuery);cacheQuery.eq.mockReturnValue(cacheQuery);
    const discoveryQuery:any={select:vi.fn(),eq:vi.fn(),ilike:vi.fn(),limit:vi.fn().mockResolvedValue({data:[{account_id:'account.hidden'}],error:null})};
    discoveryQuery.select.mockReturnValue(discoveryQuery);discoveryQuery.eq.mockReturnValue(discoveryQuery);discoveryQuery.ilike.mockReturnValue(discoveryQuery);
    mocks.db.mockReturnValue({from:vi.fn((table: string)=>table === 'pubg_player_match_discovery' ? discoveryQuery : cacheQuery)});
    expect((await GET(req())).status).toBe(403);
    expect(mocks.history).toHaveBeenCalled();
  });
  it('rejects unsupported platforms before using server credentials',async()=>{
    expect((await GET(new NextRequest('http://localhost/api/pubg/player/matches?nickname=A&platform=console'))).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });
});
