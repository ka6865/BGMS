import type { Metadata } from "next";
import Link from "next/link";
import manifest from "@/public/gta6/manifest.json";

export const metadata: Metadata = {
  title: { absolute: "GTA6 지도 출처 및 권리 문의 | BGMS" },
  description: "BGMS GTA6 지도 배경과 장소 데이터의 출처, 가공 내역, 정정 및 삭제 요청 방법입니다.",
  alternates: { canonical: "/gta6/sources" },
};

const contactEmail = "ka6865@gmail.com";
const textLink = "font-medium text-amber-300 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300";

export default function Gta6SourcesPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto max-w-3xl space-y-6 px-4 py-6 text-sm leading-relaxed text-zinc-300 sm:px-6">
        <Link href="/gta6" className={`inline-flex min-h-11 items-center ${textLink}`}>GTA6 지도로 돌아가기</Link>
        <h1 className="text-xl font-bold text-white">출처 및 권리 문의</h1>

        <section aria-labelledby="gta6-map-sources" className="space-y-3">
          <h2 id="gta6-map-sources" className="text-base font-semibold text-white">지도 배경과 장소 데이터</h2>
          <p>
            지도 배경은 {manifest.map}(Yanis와 GTA VI Mapping Community)입니다.
            지도 타일과 장소 데이터는 <a href={manifest.source} className={textLink}>GTADB 및 기여자</a>가
            제공하며, 원본 저장소의 <a href="https://creativecommons.org/licenses/by/4.0/" className={textLink}>{manifest.license}</a> 고지를 따릅니다.
          </p>
          <p>
            BGMS는 한국어 장소명과 지역 레이블을 추가하고, 원본 설명판을 제외하도록 표시 영역을 잘랐습니다.
            장소 좌표는 원본의 커뮤니티 추정값입니다.
          </p>
          <p>
            자료 반영일 {manifest.importedAt} · <a href={`${manifest.source}/tree/${manifest.commit}`} className={textLink}>원본 버전 {manifest.commit.slice(0, 8)}</a>
            {" · "}<a href="/gta6/LICENSE.txt" className={textLink}>BGMS 출처·라이선스 고지</a>
          </p>
        </section>

        <section aria-labelledby="gta6-rights-requests" className="space-y-3 border-t border-white/10 pt-5">
          <h2 id="gta6-rights-requests" className="text-base font-semibold text-white">정정 또는 삭제 요청</h2>
          <p>출처 표시나 위치 정보를 정정하거나 권리 문제로 삭제를 요청하려면 운영자 이메일로 아래 내용을 보내 주세요.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>대상 페이지 URL과 이미지 또는 장소 ID</li>
            <li>요청 사유와 참고할 원본 링크 또는 근거</li>
            <li>회신 연락처와 권리자 또는 대리인 정보(권리 관련 요청인 경우)</li>
          </ul>
          <p>접수한 요청의 대상과 근거를 확인합니다. 검토가 필요한 경우 대상 자료의 표시를 일시 중단할 수 있습니다.</p>
          <a href={`mailto:${contactEmail}`} className={`inline-flex min-h-11 items-center ${textLink}`}>{contactEmail}</a>
        </section>

        <p className="border-t border-white/10 pt-5 text-xs text-zinc-400">
          BGMS는 Rockstar Games 및 Take-Two Interactive와 제휴·후원·승인 관계가 없는 비공식 팬 서비스입니다.
        </p>
      </article>
    </div>
  );
}
