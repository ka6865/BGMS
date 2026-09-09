// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import WeaponMetaDashboard from '../components/meta/WeaponMetaDashboard';
const metric={match_count:100,pick_share:25,avg_damage:100,sustained_hits:2,burst_sample_count:30,burst_available:true,kill_efficiency:10};
const data={success:true,patchVersion:'43.1',patches:[{version:'43.1',startsAt:'2026-09-10T08:30:00Z'},{version:'42.3',startsAt:'2026-08-12T03:00:00Z'}],weapons:[{weapon_name:'AKM',weapon_category:'AR',pre_patch:metric,post_patch:metric}],dailyWeaponTrend:[],scopePickShares:[],burstCollection:{pre:{total:100,completed:80},post:{total:5000,completed:4500}}};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows saved metrics directly with patch selection and no provenance controls',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(data)));
 render(createElement(WeaponMetaDashboard));
 await screen.findByLabelText('패치 선택');
 expect(screen.queryByLabelText('패치 전 자료')).toBeNull();
 expect(screen.queryByText(/현재 검증/)).toBeNull();
 expect(screen.getByText('4500 / 5000경기 (90%)')).toBeTruthy();

});
it('requests the selected historical patch',async()=>{
 const fetchMock=vi.fn().mockResolvedValueOnce(Response.json(data)).mockResolvedValueOnce(Response.json({...data,patchVersion:'42.3',weapons:[],burstCollection:{pre:{total:0,completed:0},post:{total:5000,completed:4500}}}));
 vi.stubGlobal('fetch',fetchMock);
 render(createElement(WeaponMetaDashboard));
 await screen.findByLabelText('패치 선택');
 fireEvent.change(screen.getByLabelText('패치 선택'),{target:{value:'42.3'}});
 await screen.findByText('PUBG 42.3 패치 전후 총기 메타 리포트');
 expect(fetchMock.mock.calls[1][0]).toContain('patch=42.3');
});
it('offers retry on a failed request instead of silently showing zero',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({success:false,message:'집계 실패'},{status:503})));
 render(createElement(WeaponMetaDashboard));
 expect((await screen.findByRole('alert')).textContent).toContain('집계 실패');
 expect(screen.getByRole('button',{name:'다시 불러오기'})).toBeTruthy();
});

it('does not show a nonexistent post-patch period as a measured zero',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...data,weapons:[{...data.weapons[0],post_patch:{...metric,match_count:0,pick_share:0}}],burstCollection:{pre:{total:100,completed:80},post:{total:0,completed:0}}})));
 render(createElement(WeaponMetaDashboard));
 await screen.findByLabelText('패치 선택');
 expect(screen.getAllByText('자료 없음').length).toBeGreaterThan(0);
 expect(screen.queryByText('(하락)')).toBeNull();
});

it('keeps rare measured damage when rounded pick share is zero',async()=>{
 const rare={...metric,pick_share:0,active_pick_count:1,avg_damage:123};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...data,weapons:[{...data.weapons[0],pre_patch:rare,post_patch:rare}]})));
 render(createElement(WeaponMetaDashboard));
 await screen.findByLabelText('패치 선택');
 expect(screen.getByText('123 HP')).toBeTruthy();
 expect(screen.queryAllByText('기록 없음')).toHaveLength(0);
});

it('falls back to available weapons when a patch no longer contains the selected gun',async()=>{
 const point={date:'2026-09-09',period:'pre',scope:'category',weapon_name:'ALL',weapon_category:'ALL',player_match_count:100,weapon_pick_count:25};
 const initial={...data,dailyWeaponTrend:[point]};
 const next={...data,patchVersion:'42.3',weapons:[{...data.weapons[0],weapon_name:'M249',weapon_category:'LMG'}],dailyWeaponTrend:[{...point,weapon_name:'LMG',weapon_category:'LMG'}]};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json(initial)).mockResolvedValueOnce(Response.json(next)));
 render(createElement(WeaponMetaDashboard));
 fireEvent.change(await screen.findByLabelText('추세 총기'),{target:{value:'AKM'}});
 fireEvent.change(screen.getByLabelText('패치 선택'),{target:{value:'42.3'}});
 await screen.findByText('PUBG 42.3 패치 전후 총기 메타 리포트');
 expect((screen.getByLabelText('추세 총기') as HTMLSelectElement).value).toBe('ALL');
 expect((screen.getByLabelText('추세 카테고리') as HTMLSelectElement).value).toBe('LMG');
});
