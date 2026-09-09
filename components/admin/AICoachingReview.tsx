'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Download, Loader2, RefreshCw } from 'lucide-react';
import { ANALYSIS_KIND, REVIEW_STATUS, type CaseList, type CoachingCase, type ReviewDraft, type ReviewStatus } from '@/lib/ai-coaching-review/types';

const endpoint = '/api/admin/ai-coaching/cases';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40';
const fieldClass = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm leading-6 text-zinc-100 focus:border-amber-400 focus:outline-none';
const draftFields: Array<[keyof ReviewDraft, string, string]> = [
  ['allowed', '허용되는 해석', '어떤 사실과 비교를 설명할 수 있나요?'],
  ['forbidden', '금지할 주장', '근거로 확인되지 않는 주장이나 오해를 적어 주세요.'],
  ['example', '좋은 코칭 예시', '위 근거를 바탕으로 이해하기 쉬운 설명을 작성해 주세요.'],
  ['note', '검토 사유', '승인·보류·제외 이유 또는 다음 검토자가 알아야 할 내용을 적어 주세요.'],
];
async function readResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
  return body;
}
function time(value: string) { return new Date(value).toLocaleString('ko-KR'); }

export default function AICoachingReview() {
  const [list, setList] = useState<CaseList | null>(null);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CoachingCase | null>(null);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmApproval, setConfirmApproval] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const dirty = !!selected && !!draft && JSON.stringify(selected.review) !== JSON.stringify(draft);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const request = ++listRequest.current;
    setLoading(true); setListError('');
    try {
      const body = await readResponse(await fetch(`${endpoint}?kind=${kind}&status=${status}&page=${page}`, { cache: 'no-store', signal }));
      if (!signal?.aborted && request === listRequest.current) setList(body);
    } catch (error) {
      if (!signal?.aborted && request === listRequest.current) setListError(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.');
    } finally { if (!signal?.aborted && request === listRequest.current) setLoading(false); }
  }, [kind, status, page]);
  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => controller.abort();
  }, [loadList]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const canLeave = () => !dirty || window.confirm('저장하지 않은 교정안이 있습니다. 변경을 버리고 이동할까요?');

  async function selectCase(id: string) {
    if (saving || !canLeave()) return;
    const request = ++detailRequest.current;
    setDetailLoading(true); setSelected(null); setDraft(null); setDetailError(''); setNotice(''); setConfirmApproval(false);
    try {
      const body = await readResponse(await fetch(`${endpoint}/${id}`, { cache: 'no-store' }));
      if (request !== detailRequest.current) return;
      setSelected(body.case); setDraft(body.case.review);
      requestAnimationFrame(() => detailHeading.current?.focus());
    } catch (error) {
      if (request === detailRequest.current) setDetailError(error instanceof Error ? error.message : '상세 내용을 불러오지 못했습니다.');
    } finally { if (request === detailRequest.current) setDetailLoading(false); }
  }
  function filter(nextKind: string, nextStatus: string, nextPage = 1) {
    if (saving || !canLeave()) return;
    detailRequest.current++; setSelected(null); setDraft(null); setDetailLoading(false); setDetailError('');
    setKind(nextKind); setStatus(nextStatus); setPage(nextPage); setConfirmApproval(false);
  }
  async function importCases() {
    setImporting(true); setListError(''); setNotice('');
    try {
      const body = await readResponse(await fetch(endpoint, { method: 'POST' }));
      setNotice(body.imported ? `${body.imported}개 사례를 검토 대기로 가져왔습니다.` : '기존 사례를 모두 가져온 상태입니다. 검토 내용은 유지됩니다.');
      await loadList();
    } catch (error) { setListError(error instanceof Error ? error.message : '가져오기에 실패했습니다.'); }
    finally { setImporting(false); }
  }
  async function save(nextStatus: ReviewStatus) {
    if (!selected || !draft || saving) return;
    setSaving(true); setDetailError(''); setNotice('');
    try {
      const body = await readResponse(await fetch(`${endpoint}/${selected.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: selected.revision, status: nextStatus, review: draft }),
      }));
      setSelected(body.case); setDraft(body.case.review); setConfirmApproval(false);
      setNotice(nextStatus === 'pending' ? '교정안을 검토 대기로 저장했습니다.' : `${REVIEW_STATUS[nextStatus]} 상태로 저장했습니다.`);
      await loadList();
    } catch (error) { setDetailError(error instanceof Error ? error.message : '저장하지 못했습니다. 작성 내용은 유지됩니다.'); }
    finally { setSaving(false); }
  }
  const approvalReady = !!draft && Object.values(draft).every(value => value.trim());
  const total = list ? Object.values(list.counts).reduce((sum, count) => sum + count, 0) : 0;

  return <main className="min-h-screen bg-[#090b10] px-4 py-6 text-zinc-100 sm:px-6">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="space-y-3">
        <Link href="/admin/dashboard" className="inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400" onClick={event => { if (saving || !canLeave()) event.preventDefault(); }}><ArrowLeft className="h-4 w-4" />관리자 대시보드</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h1 className="text-2xl font-bold">AI 코칭 품질</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">경기 근거와 AI 응답을 비교하고 좋은 코칭 기준을 검토합니다. 승인한 사례는 이후 평가 기준으로 사용할 수 있습니다.</p></div>
          <button className={button} disabled={importing || saving} onClick={() => void importCases()}>{importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}기존 사례 15개 가져오기</button>
        </div>
        <p className="text-xs leading-5 text-zinc-500">현재는 저장된 사례를 가져와 검토하는 단계입니다. 운영 응답 자동 수집과 모델 비교 실행은 아직 연결되지 않았습니다.</p>
      </header>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="전체 수집 사례 현황">
        {(Object.entries(REVIEW_STATUS) as Array<[ReviewStatus, string]>).map(([key, label]) => <button key={key} disabled={saving} onClick={() => filter('all', key)} className={`rounded-xl border p-4 text-left ${status === key ? 'border-amber-500/60 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/60'}`}>
          <span className="text-xs text-zinc-400">{label}</span><span className="mt-1 block text-2xl font-semibold">{list ? list.counts[key] : '—'}</span>
        </button>)}
      </div>
      <p className="text-xs text-zinc-500">가져온 전체 사례 {list ? total : '—'}개 기준 · 전체 서비스 요청의 오류율을 뜻하지 않습니다.</p>
      {notice && <p role="status" className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">{notice}</p>}
      <div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section aria-label="사례 목록" className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">분석 종류<select className={`${fieldClass} mt-1`} value={kind} disabled={saving} onChange={event => filter(event.target.value, status)}><option value="all">전체 종류</option>{Object.entries(ANALYSIS_KIND).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label className="text-xs text-zinc-400">검토 상태<select className={`${fieldClass} mt-1`} value={status} disabled={saving} onChange={event => filter(kind, event.target.value)}><option value="all">전체 상태</option>{Object.entries(REVIEW_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <div className="flex items-center justify-between"><p className="text-xs text-zinc-400">조회된 사례 {list?.total ?? 0}개</p><button aria-label="목록 새로고침" className={button} onClick={() => void loadList()} disabled={loading}><RefreshCw className="h-4 w-4" /></button></div>
          {listError ? <div role="alert" className="rounded-lg border border-red-900 p-3 text-sm text-red-300">{listError}<button className={`${button} mt-3 w-full`} onClick={() => void loadList()}>다시 불러오기</button></div> : loading ? <p role="status" className="p-6 text-sm text-zinc-400">사례를 불러오는 중입니다.</p> : !list?.cases.length ? <div className="rounded-xl border border-dashed border-zinc-700 p-5 text-sm leading-6 text-zinc-400">{total ? '이 조건에 맞는 사례가 없습니다. 필터를 변경해 주세요.' : '아직 사례가 없습니다. 상단의 가져오기 버튼으로 기존 검증 사례를 추가하세요.'}</div> : <ul className="max-h-80 space-y-2 overflow-y-auto pr-1 lg:max-h-[70vh]">{list.cases.map(item => <li key={item.id}><button className={`w-full rounded-xl border p-4 text-left ${selected?.id === item.id ? 'border-amber-500 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-600'}`} onClick={() => void selectCase(item.id)} disabled={saving} aria-pressed={selected?.id === item.id}>
            <span className="text-xs text-amber-300">{ANALYSIS_KIND[item.analysis_kind]} · {REVIEW_STATUS[item.status]}</span><span className="mt-2 block break-words text-sm font-semibold">{item.title}</span><span className="mt-2 block text-xs text-zinc-400">{item.issue_type}</span>
          </button></li>)}</ul>}
          <div className="flex items-center justify-between gap-2"><button className={button} disabled={page <= 1 || saving || loading} onClick={() => filter(kind, status, page - 1)}>이전</button><span className="text-xs text-zinc-400">{page} / {Math.max(1, Math.ceil((list?.total ?? 0) / 20))}</span><button className={button} disabled={!list || page * 20 >= list.total || saving || loading} onClick={() => filter(kind, status, page + 1)}>다음</button></div>
        </section>
        <section aria-label="사례 검토" className="min-w-0 space-y-5">
          {detailLoading && <p role="status" className="p-6 text-sm text-zinc-400">사례 상세를 불러오는 중입니다.</p>}
          {detailError && <div role="alert" className="rounded-lg border border-red-900 p-3 text-sm text-red-300">{detailError}{selected && <button className={`${button} mt-3 w-full`} disabled={saving} onClick={() => void selectCase(selected.id)}>최신 내용 다시 불러오기</button>}</div>}
          {!selected && !detailLoading && <div className="rounded-xl border border-dashed border-zinc-800 px-5 py-12 text-center"><ClipboardCheck className="mx-auto mb-3 h-7 w-7 text-zinc-500" /><p className="text-sm text-zinc-400">목록에서 검토할 사례를 선택해 주세요.</p></div>}
          {selected && draft && <>
            <header><h2 ref={detailHeading} tabIndex={-1} className="break-words text-xl font-semibold outline-none">{selected.title}</h2><p className="mt-2 text-xs leading-5 text-zinc-400">{selected.source_label}<br />{REVIEW_STATUS[selected.status]} · 마지막 저장 {time(selected.updated_at)}</p></header>
            <div className="rounded-xl border border-amber-700/40 bg-amber-950/10 p-4"><h3 className="font-semibold text-amber-200">확인된 경기 근거</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">{selected.evidence_text}</p></div>
            <div className="grid gap-4 xl:grid-cols-2">{[['AI 원본 응답', selected.original_response], ['최종 표시 응답', selected.displayed_response]].map(([label, value]) => <details key={label} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" open><summary className="cursor-pointer text-sm font-semibold">{label}</summary><p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">{value}</p></details>)}</div>
            <section className="space-y-4 rounded-xl border border-zinc-800 p-4 sm:p-5" aria-label="교정 기준 작성">
              <div><h3 className="font-semibold">교정 기준 작성</h3><p className="mt-2 text-xs leading-5 text-zinc-400">가져온 문장은 검토용 초안입니다. 사실의 정확성과 조언의 유용성을 확인한 뒤 승인해 주세요. 승인은 평가 사례 등록이며 실제 모델 변경은 별도 평가·배포 단계에서 진행합니다.</p></div>
              {draftFields.map(([key, label, placeholder]) => <label key={key} className="block text-sm text-zinc-300">{label}<textarea className={`${fieldClass} mt-2`} rows={key === 'example' ? 5 : 3} maxLength={6000} disabled={saving} placeholder={placeholder} value={draft[key]} onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setConfirmApproval(false); }} /></label>)}
              {dirty && <p className="text-xs text-amber-300">저장하지 않은 변경이 있습니다.</p>}
              <div className="flex flex-wrap gap-2"><button className={button} disabled={saving} onClick={() => void save('pending')}>교정안 저장</button><button className={`${button} border-emerald-700 text-emerald-200`} disabled={saving || !approvalReady} onClick={() => setConfirmApproval(true)}><CheckCircle2 className="h-4 w-4" />승인</button><button className={button} disabled={saving || !draft.note.trim()} onClick={() => void save('held')}>보류</button><button className={button} disabled={saving || !draft.note.trim()} onClick={() => void save('excluded')}>제외</button></div>
              <p className="text-xs leading-5 text-zinc-500">승인: 모든 항목 필요 · 보류/제외: 검토 사유 필요 · 승인된 사례도 교정안 저장 시 다시 검토 대기로 전환됩니다.</p>
              {confirmApproval && <div role="group" aria-label="승인 확인" className="space-y-3 rounded-lg border border-emerald-800 p-4"><p className="text-sm leading-6 text-emerald-100">이 기준을 검토했으며 평가 사례로 승인하시겠습니까?</p><div className="flex flex-wrap gap-2"><button className={button} disabled={saving} onClick={() => void save('approved')}>{saving ? '저장 중…' : '확인하고 승인'}</button><button className={button} disabled={saving} onClick={() => setConfirmApproval(false)}>취소</button></div></div>}
            </section>
            <details className="rounded-xl border border-zinc-800 p-4"><summary className="cursor-pointer text-sm font-semibold">검토 이력 {selected.review_history.length}건</summary><ol className="mt-4 space-y-4">{selected.review_history.length ? [...selected.review_history].reverse().map(event => <li key={event.revision} className="border-t border-zinc-800 pt-3"><p className="text-xs text-zinc-400">{time(event.at)} · {REVIEW_STATUS[event.status]} · 검토 {event.revision}</p>{draftFields.map(([key, label]) => <p key={key} className="mt-2 whitespace-pre-wrap break-words text-sm leading-6"><span className="text-zinc-500">{label}: </span>{event.review[key] || '작성하지 않음'}</p>)}</li>) : <li className="text-sm text-zinc-400">아직 저장된 검토 이력이 없습니다.</li>}</ol></details>
          </>}
        </section>
      </div>
    </div>
  </main>;
}
