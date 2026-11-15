import type { OfficialItem } from "@/lib/patch-notes/officialCatalog";
import { getOfficialSpec, OFFICIAL_SPEC_KEYS, type simulateWeapon } from "@/lib/weapons/simulator";

export const COMPARE_LIMIT = 4;

// 도감 항목은 공식 지표만, 시뮬레이터 구성은 BGMS 계산값까지 함께 담는다.
export interface CompareEntry {
  key: string;
  name: string;
  item: OfficialItem | null;
  build?: { parts: string[]; damage: number | null; bulletSpeed: number | null; stats: ReturnType<typeof simulateWeapon> };
}

type Row = { label: string; values: (number | string | null)[]; better?: "high" | "low"; unit?: string };

function bestIndexes(row: Row): Set<number> {
  const numbers = row.values.filter((value): value is number => typeof value === "number");
  if (!row.better || numbers.length < 2) return new Set();
  const target = row.better === "high" ? Math.max(...numbers) : Math.min(...numbers);
  if (numbers.every((value) => value === target)) return new Set();
  return new Set(row.values.flatMap((value, index) => value === target ? [index] : []));
}

export default function WeaponCompare({ entries, onRemove, onClear }: { entries: CompareEntry[]; onRemove: (key: string) => void; onClear: () => void }) {
  if (!entries.length) return null;
  const hasBuild = entries.some((entry) => entry.build);
  const rows: Row[] = [
    ...OFFICIAL_SPEC_KEYS.map((key): Row => ({ label: `공식 ${key}`, values: entries.map((entry) => getOfficialSpec(entry.item, key)), better: "high" })),
    { label: "탄약", values: entries.map((entry) => entry.item?.ammunition || null) },
    ...(hasBuild ? [
      { label: "장착 파츠", values: entries.map((entry) => entry.build ? (entry.build.parts.join(", ") || "없음") : null) },
      { label: "BGMS 데미지", values: entries.map((entry) => entry.build?.damage ?? null), better: "high" },
      { label: "BGMS 초속", values: entries.map((entry) => entry.build?.bulletSpeed ?? null), better: "high", unit: "m/s" },
      { label: "수직 반동 지표", values: entries.map((entry) => entry.build?.stats.verticalRecoil ?? null), better: "low" },
      { label: "수평 반동 지표", values: entries.map((entry) => entry.build?.stats.horizontalRecoil ?? null), better: "low" },
      { label: "재장전 시간 지표", values: entries.map((entry) => entry.build?.stats.reloadSpeed ?? null), better: "low" },
      { label: "탄창 용량", values: entries.map((entry) => entry.build?.stats.capacity ?? null), better: "high", unit: "발" },
    ] satisfies Row[] : []),
  ].filter((row) => row.values.some((value) => value !== null));
  return <section aria-labelledby="weapon-compare-title" className="mt-8 border border-zinc-800 bg-[#141414] p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="weapon-compare-title" className="text-lg font-black text-white">무기 비교 <span className="text-sm font-bold text-zinc-400">({entries.length}/{COMPARE_LIMIT})</span></h2>
      <button type="button" onClick={onClear} className="min-h-11 px-2 text-sm text-zinc-300 underline hover:text-white">비교 비우기</button>
    </div>
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 bg-[#141414] p-2 text-left text-xs font-bold text-zinc-400">항목</th>
            {entries.map((entry) => <th key={entry.key} scope="col" className="min-w-[6.5rem] p-2 text-left align-top">
              <span className="block font-bold text-white">{entry.name}</span>
              <span className="block text-xs font-normal text-zinc-400">{entry.build ? "시뮬레이터 구성" : "공식 도감"}</span>
              <button type="button" onClick={() => onRemove(entry.key)} aria-label={`${entry.name} 비교에서 빼기`} className="min-h-11 text-xs font-normal text-red-300 underline">빼기</button>
            </th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const best = bestIndexes(row);
            return <tr key={row.label} className="border-t border-zinc-800">
              <th scope="row" className="sticky left-0 min-w-[7.5rem] bg-[#141414] p-2 text-left text-xs font-semibold text-zinc-400">{row.label}{row.better && <span className="block font-normal text-zinc-500">{row.better === "high" ? "높을수록 유리" : "낮을수록 유리"}</span>}</th>
              {row.values.map((value, index) => <td key={entries[index].key} className={`p-2 align-top tabular-nums ${typeof value === "number" ? "font-mono" : "break-keep"} ${best.has(index) ? "font-bold text-amber-300" : "text-zinc-100"}`}>
                {value === null ? <span className="text-zinc-500">–</span> : `${value}${row.unit && typeof value === "number" ? ` ${row.unit}` : ""}`}
                {best.has(index) && <span className="sr-only"> (최고)</span>}
              </td>)}
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <p className="mt-3 text-xs leading-5 text-zinc-400">공식 지표는 PUBG 공식 도감의 막대 값으로 서로 상대 비교용입니다. 발 당 데미지는 100에서 잘려 표시됩니다. BGMS 항목은 시뮬레이터 구성에만 있으며 반동·재장전은 게임 실측이 아닌 상대 지표입니다.</p>
  </section>;
}
