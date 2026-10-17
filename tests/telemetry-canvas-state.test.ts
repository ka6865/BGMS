// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { map, calibrate } = vi.hoisted(() => ({ map: {} as any, calibrate: vi.fn((x:number,y:number,...mapNames:string[]) => { void mapNames; return [y,x]; }) }));
vi.mock('react-leaflet', () => ({ useMap: () => map }));
vi.mock('leaflet', () => ({ default: { DomUtil: { create: (tag:string) => document.createElement(tag), setPosition: vi.fn() } } }));
vi.mock('../utils/coordinate', () => ({ toCalibratedCoords: calibrate }));
import { TelemetryCanvasLayer } from '../components/map/telemetry/TelemetryCanvasLayer';
let pane: HTMLDivElement;
let context: Record<string, any>;
let callbacks: Map<number, FrameRequestCallback>;
let id: number;
const player = { name:'Player', x:0, y:200, health:100, isEnemy:false };
const data = (extra = {}) => ({ events:[], currentStates:{Player:player}, currentTimeMs:1000, zoneEvents:[{relativeTimeMs:0}], mapName:'Baltic_Main', nickname:'Other', showPlayerNames:true, ...extra });
function frame() {
  const pending = [...callbacks.values()]; callbacks.clear();
  act(() => pending.forEach(callback => callback(1000)));
}
beforeEach(() => {
  id=0; callbacks=new Map(); pane=document.createElement('div'); document.body.append(pane);
  context=new Proxy({} as Record<string,any>, {get(target,key:string) { return target[key] ??= vi.fn(); }});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as any);
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{callbacks.set(++id,cb);return id;});
  vi.stubGlobal('cancelAnimationFrame',(key:number)=>callbacks.delete(key));
  Object.assign(map,{getPane:()=>pane,getSize:()=>({x:400,y:300}),getZoom:()=>1,
    containerPointToLayerPoint:(p:any)=>p,latLngToContainerPoint:([y,x]:number[])=>({x,y}),on:vi.fn(),off:vi.fn()});
  calibrate.mockClear();
});
afterEach(()=>{cleanup();pane.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('live telemetry canvas state',()=>{
  it('draws players when blue-zone coordinates are missing and updates labels/map without remounting',()=>{
    const view=render(React.createElement(TelemetryCanvasLayer,{telemetryData:data()})); frame();
    expect(context.fillText).toHaveBeenCalledWith('Player',0,179);
    const canvas=pane.querySelector('canvas');
    context.fillText.mockClear();
    // 이름 자동 표시: 아군은 남고, 아군과 교전 기록이 없는 적은 숨긴다.
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({showPlayerNames:false,mapName:'Desert_Main'})})); frame();
    expect(pane.querySelector('canvas')).toBe(canvas);
    expect(context.fillText).toHaveBeenCalledWith('Player',0,179);
    context.fillText.mockClear();
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({showPlayerNames:false,mapName:'Desert_Main',currentStates:{Player:{...player,isEnemy:true}}})})); frame();
    expect(context.fillText).not.toHaveBeenCalled();
    expect(calibrate).toHaveBeenLastCalledWith(0,200,'Desert_Main');
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({hiddenPlayers:[' PLAYER ']})}));
    context.arc.mockClear(); frame(); expect(context.arc).not.toHaveBeenCalled();
    view.unmount(); expect(pane.querySelector('canvas')).toBeNull(); expect(callbacks.size).toBe(0);
  });
  it('labels enemies that fought the squad within the last 20 seconds in auto name mode',()=>{
    const enemy = { name:'Enemy', x:0, y:200, health:100, isEnemy:true };
    const fought = data({ showPlayerNames:false, teamNames:['Mate'], currentStates:{Enemy:enemy},
      events:[{ type:'damage', relativeTimeMs:900, attackerName:'Enemy', victimName:'Mate' }] });
    render(React.createElement(TelemetryCanvasLayer,{telemetryData:fought})); frame();
    expect(context.fillText).toHaveBeenCalledWith('Enemy',0,179);
  });
  it('zooms to the followed player, keeps it centered, and cancels following on drag',()=>{
    const onFollowCancel = vi.fn();
    Object.assign(map,{ panTo:vi.fn(), setView:vi.fn(), getSize:()=>({x:400,y:300,divideBy:(n:number)=>({x:400/n,y:300/n})}) });
    render(React.createElement(TelemetryCanvasLayer,{telemetryData:data({ followPlayer:'player', onFollowCancel })})); frame();
    expect(map.setView).toHaveBeenCalledWith([200,0],1,{animate:true});
    expect(map.panTo).toHaveBeenCalledWith([200,0],{animate:false});
    const dragStart = map.on.mock.calls.find(([name]:[string]) => name === 'dragstart')?.[1];
    dragStart();
    expect(onFollowCancel).toHaveBeenCalledOnce();
  });
  it('draws throws at the thrower, blasts at the victim, and hit lines from exact damage coordinates',()=>{
    const events = [
      { type:'throw', relativeTimeMs:900, name:'Enemy', throwable:'smoke', weapon:'item_weapon_smokebomb_c', x:10, y:20 },
      { type:'damage', relativeTimeMs:950, attackerName:'Enemy', victimName:'Player', cause:'grenade', x:30, y:40, attackerX:1, attackerY:2 },
      { type:'damage', relativeTimeMs:990, attackerName:'Enemy', victimName:'Player', cause:'gun', x:50, y:60, attackerX:70, attackerY:80 },
      { type:'damage', relativeTimeMs:995, attackerName:'Player', victimName:'Player', cause:'zone', x:90, y:90, attackerX:90, attackerY:90 },
      { type:'damage', relativeTimeMs:996, attackerName:'Enemy', victimName:'Player', cause:'bleed', x:91, y:91, attackerX:92, attackerY:92 },
      { type:'smoke', relativeTimeMs:990, name:'Enemy', x:500, y:500, isEstimated:true },
      { type:'damage', relativeTimeMs:980, attackerName:'Self', victimName:'Self', cause:'grenade', x:300, y:310, attackerX:300, attackerY:310 },
    ];
    render(React.createElement(TelemetryCanvasLayer,{telemetryData:data({ events, showPlayerNames:false })})); frame();
    // 투척: 던진 위치(10,20)에 종류 라벨. 착탄 추정 위치는 그리지 않는다.
    expect(context.fillText).toHaveBeenCalledWith('연막',10,46);
    expect(context.fillText).toHaveBeenCalledWith('수류탄 피해',30,68);
    // 자기 수류탄에 맞은 피해도 실제 폭발 피해 위치로 표시한다.
    expect(context.fillText).toHaveBeenCalledWith('수류탄 피해',300,338);
    // 명중선: 피해 이벤트의 공격자 좌표(70,80) → 피해자 좌표(50,60)
    expect(context.moveTo).toHaveBeenCalledWith(70,80);
    expect(context.lineTo).toHaveBeenCalledWith(50,60);
    // 자기 피해·출혈은 선을 그리지 않는다.
    expect(context.moveTo).not.toHaveBeenCalledWith(90,90);
    expect(context.moveTo).not.toHaveBeenCalledWith(92,92);
    // 예전 데이터의 추정 연막(500,500)은 그리지 않는다.
    expect(context.arc.mock.calls.some(([x,y]:number[]) => x === 500 && y === 500)).toBe(false);
  });
  it('moves an overlapping name label up instead of drawing it on top of another one',()=>{
    const mate = { name:'Mate', x:0, y:200, health:100, isEnemy:false };
    render(React.createElement(TelemetryCanvasLayer,{telemetryData:data({ currentStates:{ Player:player, Mate:mate } })})); frame();
    const labelYs = context.fillText.mock.calls.filter(([text]:[string]) => text === 'Player' || text === 'Mate').map(([, , y]:number[]) => y);
    expect(labelYs.sort((a:number, b:number) => a - b)).toEqual([164, 179]);
  });
  it('applies combat and shot switches immediately and does not draw future effects',()=>{
    const events=[{type:'kill',x:0,y:100,relativeTimeMs:900},{type:'shot',x:0,y:100,relativeTimeMs:900}];
    const view=render(React.createElement(TelemetryCanvasLayer,{telemetryData:data({currentStates:{},events})})); frame();
    expect(context.arc).toHaveBeenCalledTimes(3);
    context.arc.mockClear();
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({currentStates:{},events,showCombatDots:false,showShotDots:false})})); frame();
    expect(context.arc).not.toHaveBeenCalled();
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({currentStates:{},events,currentTimeMs:800})})); frame();
    expect(context.arc).not.toHaveBeenCalled();
  });
  it('clears the old frame while inactive',()=>{
    const view=render(React.createElement(TelemetryCanvasLayer,{telemetryData:data()})); frame();
    context.clearRect.mockClear();context.arc.mockClear();
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({isActive:false})})); frame();
    expect(context.clearRect).toHaveBeenCalled();expect(context.arc).not.toHaveBeenCalled();
  });
});
