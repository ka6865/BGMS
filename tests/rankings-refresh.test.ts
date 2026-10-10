// @vitest-environment jsdom
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/ads/AdfitBanner', () => ({ default: () => null }));
vi.mock('@/components/ads/AdSenseBanner', () => ({ default: () => null }));
import RankingsClient from '@/app/rankings/RankingsClient';

const fetchMock = vi.fn();
const props = { updatedAt: '2026-09-13T00:00:00Z' };
const entry = (nickname: string) => ({ rank: 1, platform: 'kakao', playerId: nickname, nickname, value: 1000, secondary: 5, gameMode: '스쿼드', mapName: '에란겔' });
const response = (entries: unknown[] = []) => ({ ok: true, json: async () => ({ entries, generatedAt: '2026-10-10T04:00:00Z' }) });

beforeEach(() => { fetchMock.mockReset().mockResolvedValue(response()); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('랭킹 조회', () => {
  it('초기 응답을 기다리는 동안 제목과 필터를 표시하고 딜량만 조회한다', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(createElement(RankingsClient, props));
    expect(screen.getByRole('heading', { name: '랭킹' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '스쿼드' })).toBeTruthy();
    expect(screen.queryByText('이번 주 데이터가 없습니다')).toBeNull();
    expect(screen.getByText('조회 기준: 조회 중')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rankings?tab=damage&mode=all&perspective=all&matchType=all');
  });

  it('탭과 필터 변경 시 선택한 랭킹만 조회하고 전적 링크를 보존한다', async () => {
    fetchMock.mockResolvedValue(response([entry('NewResult')]));
    render(createElement(RankingsClient, props));
    await screen.findByText('NewResult');
    fireEvent.click(screen.getByRole('button', { name: '최근 7일 킬' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '스쿼드' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe('/api/rankings?tab=kills&mode=squad&perspective=all&matchType=all');
    await waitFor(() => expect(screen.getByRole('link', { name: 'NewResult 전적 보기' }).getAttribute('href')).toBe('/stats/kakao/NewResult'));
  });

  it('늦게 도착한 이전 필터의 응답은 새 필터 결과를 덮어쓰지 않는다', async () => {
    let finishOld!: (value: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(response([entry('Current')]));
    render(createElement(RankingsClient, props));
    const oldSignal = fetchMock.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole('button', { name: '스쿼드' }));
    await screen.findByText('Current');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finishOld(response([entry('Obsolete')])); });
    expect(screen.queryByText('Obsolete')).toBeNull();
    expect(screen.getByText('Current')).toBeTruthy();
  });

  it('조회 실패 후 다시 시도하면 정상 데이터를 표시한다', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue(response([entry('Recovered')]));
    render(createElement(RankingsClient, props));
    const retry = await screen.findByRole('button', { name: '다시 시도' });
    expect(screen.getByText('조회 기준: 조회 실패')).toBeTruthy();
    fireEvent.click(retry);
    await screen.findByText('Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('빈 정상 응답을 받았을 때만 빈 데이터 안내를 표시한다', async () => {
    render(createElement(RankingsClient, props));
    await screen.findByText('이번 주 데이터가 없습니다');
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('잘못된 응답 형식을 빈 랭킹으로 처리하지 않는다', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'invalid' }) });
    render(createElement(RankingsClient, props));
    await screen.findByRole('button', { name: '다시 시도' });
    expect(screen.queryByText('이번 주 데이터가 없습니다')).toBeNull();
  });

  it('60초 자동 갱신은 보이는 탭만 조회하고 진행 중에는 중복 요청하지 않는다', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(createElement(RankingsClient, props));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { finish(response()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('tab=damage');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('자동 갱신 중에는 같은 조건의 목록을 유지하고 실패하면 이전 목록을 숨긴다', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(response([entry('Previous')]));
    render(createElement(RankingsClient, props));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText('Previous')).toBeTruthy();
    expect(screen.getByText('최신 랭킹을 확인하고 있습니다.')).toBeTruthy();
    expect(screen.queryByLabelText('랭킹 불러오는 중')).toBeNull();
    await act(async () => { finish({ ok: false, status: 503 }); });
    expect(screen.queryByText('Previous')).toBeNull();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('12초 응답 제한 이후에는 재시도할 수 있고 다음 요청은 새 signal을 쓴다', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    render(createElement(RankingsClient, props));
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(screen.getByText('조회 시간이 초과되었습니다. 다시 시도해 주세요.')).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    fetchMock.mockResolvedValue(response([entry('Recovered')]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '다시 시도' })); });
    expect(screen.getByText('Recovered')).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it('캐시의 집계 시각을 현재 응답 수신 시각으로 바꾸지 않는다', async () => {
    fetchMock.mockResolvedValue(response([entry('Snapshot')]));
    render(createElement(RankingsClient, props));
    await screen.findByText('Snapshot');
    expect(screen.getByText('조회 기준: 10월 10일 오후 1:00')).toBeTruthy();
  });
});
