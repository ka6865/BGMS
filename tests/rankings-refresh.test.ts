// @vitest-environment jsdom
import {createElement} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({damage:vi.fn(),kills:vi.fn(),tier:vi.fn()}));
vi.mock('@/actions/rankings',()=>({getWeeklyTopDamage:mocks.damage,getWeeklyTopKills:mocks.kills,getTopTierRanking:mocks.tier}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('@/components/ads/AdfitBanner',()=>({default:()=>null}));
vi.mock('@/components/ads/AdSenseBanner',()=>({default:()=>null}));
import RankingsClient from '@/app/rankings/RankingsClient';
const empty={data:[],hasError:false};
beforeEach(()=>{vi.clearAllMocks();mocks.damage.mockResolvedValue(empty);mocks.kills.mockResolvedValue(empty);mocks.tier.mockResolvedValue(empty);});
afterEach(cleanup);
describe('랭킹 갱신',()=>{
 it('필터 변경에 따른 effect 정리로 새 요청이 무효화되지 않는다',async()=>{
  mocks.damage.mockResolvedValue({hasError:false,data:[{rank:1,platform:'kakao',player_id:'new-result',nickname:'NewResult',value:1000,secondary:5,game_mode:'스쿼드',map_name:'에란겔'}]});
  render(createElement(RankingsClient,{initialDamage:[],initialKills:[],initialTier:[],updatedAt:'2026-09-13T00:00:00Z'}));
  fireEvent.click(screen.getByRole('button',{name:'스쿼드'}));
  await waitFor(()=>expect(screen.getByText('NewResult')).toBeTruthy());
  expect(mocks.damage).toHaveBeenCalledWith('squad','all','all');
 });
});
