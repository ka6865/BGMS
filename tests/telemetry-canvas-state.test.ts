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
    expect(context.fillText).toHaveBeenCalledWith('Player',0,-21);
    const canvas=pane.querySelector('canvas');
    context.fillText.mockClear();
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({showPlayerNames:false,mapName:'Desert_Main'})})); frame();
    expect(pane.querySelector('canvas')).toBe(canvas);
    expect(context.fillText).not.toHaveBeenCalled();
    expect(calibrate).toHaveBeenLastCalledWith(0,200,'Desert_Main');
    view.rerender(React.createElement(TelemetryCanvasLayer,{telemetryData:data({hiddenPlayers:[' PLAYER ']})}));
    context.arc.mockClear(); frame(); expect(context.arc).not.toHaveBeenCalled();
    view.unmount(); expect(pane.querySelector('canvas')).toBeNull(); expect(callbacks.size).toBe(0);
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
