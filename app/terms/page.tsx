import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "서비스 이용약관",
  description: "BGMS 서비스 이용에 관한 약관을 안내합니다.",
};

export default function TermsPage() {
  return (
    <div
      style={{
        maxWidth: "800px",
        margin: "0 auto",
        padding: "48px 24px 80px",
        color: "rgba(255,255,255,0.85)",
        lineHeight: 1.8,
      }}
    >
      {/* 제목 */}
      <h1
        style={{
          fontSize: "28px",
          fontWeight: 800,
          color: "white",
          marginBottom: "8px",
          letterSpacing: "-0.5px",
        }}
      >
        서비스 이용약관
      </h1>
      <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.35)", marginBottom: "40px" }}>
        최종 업데이트: 2026년 6월 22일
      </p>

      <Section title="제1조 (목적)">
        <p>
          본 약관은 BGMS(이하 &quot;서비스&quot;)가 제공하는 웹 서비스 및 관련 서비스의
          이용과 관련하여 서비스와 이용자 간의 권리, 의무 및 책임 사항을 규정함을 목적으로 합니다.
        </p>
      </Section>

      <Section title="제2조 (용어의 정의)">
        <ul>
          <li>
            <strong>&quot;서비스&quot;</strong>란 BGMS가 배틀그라운드(PUBG) 유저를 위해 제공하는
            전술 지도, 전적 검색, AI 코칭 분석, 가방 시뮬레이터, 상자 시뮬레이터, 커뮤니티 게시판
            등 일체의 서비스를 말합니다.
          </li>
          <li>
            <strong>&quot;이용자&quot;</strong>란 본 약관에 따라 서비스를 이용하는 모든 사람을 말합니다.
          </li>
          <li>
            <strong>&quot;회원&quot;</strong>이란 서비스에 회원가입하여 계정을 보유한 이용자를 말합니다.
          </li>
          <li>
            <strong>&quot;비회원&quot;</strong>이란 회원가입 없이 서비스를 이용하는 이용자를 말합니다.
          </li>
        </ul>
      </Section>

      <Section title="제3조 (약관의 효력 및 변경)">
        <p>
          본 약관은 서비스 화면에 게시하거나 기타의 방법으로 이용자에게 공시함으로써
          효력이 발생합니다. 서비스는 합리적인 사유가 있는 경우 약관을 변경할 수 있으며,
          변경 시 최소 7일 이전에 서비스 내 공지사항을 통해 고지합니다.
        </p>
      </Section>

      <Section title="제4조 (서비스의 제공)">
        <p>서비스는 다음의 기능을 제공합니다.</p>
        <ul>
          <li>배틀그라운드 맵별 전술 지도 (마커, 핫드랍, 비밀방 위치 등)</li>
          <li>PUBG 공식 API를 활용한 전적 검색 및 분석</li>
          <li>AI(Google Gemini 기반) 전술 코칭 및 매치 분석</li>
          <li>텔레메트리 기반 2D/3D 리플레이</li>
          <li>가방 시뮬레이터, 상자 시뮬레이터</li>
          <li>커뮤니티 게시판</li>
          <li>무기 도감 및 랭킹</li>
        </ul>
        <p>
          서비스는 연중무휴 24시간 제공을 원칙으로 하나, 서버 점검, 시스템 장애,
          외부 API(PUBG API, Google Gemini 등) 중단 시 일시적으로 서비스가 중단될 수 있습니다.
        </p>
      </Section>

      <Section title="제5조 (회원가입 및 계정 관리)">
        <ul>
          <li>회원가입은 이메일 또는 소셜 계정(Google 등)으로 가능합니다.</li>
          <li>회원은 자신의 계정 정보와 비밀번호를 안전하게 관리할 책임이 있습니다.</li>
          <li>타인의 계정을 도용하거나 허위 정보로 가입하는 행위는 금지됩니다.</li>
          <li>회원은 마이페이지에서 언제든지 탈퇴할 수 있습니다.</li>
        </ul>
      </Section>

      <Section title="제6조 (이용자의 의무)">
        <p>이용자는 다음의 행위를 하여서는 안 됩니다.</p>
        <ul>
          <li>타인의 개인정보를 무단으로 수집, 저장, 공개하는 행위</li>
          <li>서비스의 정상적인 운영을 방해하는 행위 (DDoS, 크롤링 남용 등)</li>
          <li>서비스를 통해 얻은 데이터를 허가 없이 상업적으로 이용하는 행위</li>
          <li>타인을 사칭하거나 허위 사실을 유포하는 행위</li>
          <li>PUBG API 이용 정책(KRAFTON)을 위반하는 방식으로 서비스를 이용하는 행위</li>
          <li>서비스 내 광고를 클릭 어뷰징 등 부정한 방법으로 조작하는 행위</li>
          <li>기타 관계 법령 또는 서비스의 정책에 위반되는 행위</li>
        </ul>
      </Section>

      <Section title="제7조 (게시물 관리)">
        <ul>
          <li>
            이용자가 게시판에 작성한 게시물의 저작권은 해당 이용자에게 귀속됩니다.
          </li>
          <li>
            서비스는 다음의 경우 사전 통보 없이 게시물을 삭제하거나 이용을 제한할 수 있습니다.
            <ul>
              <li>타인의 명예를 훼손하거나 모욕하는 내용</li>
              <li>음란, 폭력, 불법 광고 등 법령 위반 내용</li>
              <li>서비스의 취지와 무관한 스팸성 내용</li>
            </ul>
          </li>
          <li>
            이용자는 서비스에 게시물을 등록함으로써 서비스가 해당 게시물을
            서비스 운영 및 홍보 목적으로 무상으로 활용할 수 있음에 동의합니다.
          </li>
        </ul>
      </Section>

      <Section title="제8조 (광고 게재)">
        <p>
          서비스는 운영 비용 충당을 위해 Google AdSense 및 카카오 애드핏 광고를 게재합니다.
          이용자는 서비스 이용 시 광고가 표시됨에 동의합니다.
          광고 콘텐츠는 각 광고 플랫폼의 정책에 따라 제공되며,
          서비스는 광고 내용의 정확성에 대한 책임을 지지 않습니다.
        </p>
      </Section>

      <Section title="제9조 (서비스의 변경 및 중단)">
        <p>
          서비스는 운영상, 기술상의 필요에 따라 서비스의 전부 또는 일부를
          변경하거나 중단할 수 있습니다. 중요한 변경 또는 서비스 종료의 경우
          최소 30일 이전에 공지합니다.
        </p>
      </Section>

      <Section title="제10조 (책임의 한계)">
        <ul>
          <li>
            서비스는 이용자가 서비스를 이용하여 얻은 정보에 대해 정확성, 완전성을
            보증하지 않습니다. 전적 데이터, AI 분석 결과, 지도 마커 정보 등은
            참고용으로만 활용하시기 바랍니다.
          </li>
          <li>
            PUBG API(KRAFTON), Google Gemini, Supabase, Vercel 등 외부 서비스의
            장애로 인한 서비스 중단에 대해서는 책임을 지지 않습니다.
          </li>
          <li>
            이용자의 귀책사유로 발생한 손해에 대해서는 서비스가 책임을 지지 않습니다.
          </li>
          <li>
            BGMS는 KRAFTON 및 PUBG Corporation의 공식 서비스가 아닌 팬 기반 비공식
            서비스이며, KRAFTON 및 PUBG Corporation과 제휴, 후원, 보증 관계가 아닙니다.
            PUBG, PLAYERUNKNOWN&apos;S BATTLEGROUNDS and all related logos are trademarks of
            PUBG Corporation or its affiliates.
          </li>
        </ul>
      </Section>

      <Section title="제11조 (준거법 및 관할 법원)">
        <p>
          본 약관은 대한민국 법률에 따라 해석됩니다. 서비스 이용으로 발생한
          분쟁에 관한 소송은 민사소송법상 관할 법원을 관할 법원으로 합니다.
        </p>
      </Section>

      <Section title="제12조 (문의처)">
        <Table
          headers={["항목", "내용"]}
          rows={[
            ["서비스", "BGMS (Battleground Map Service)"],
            ["운영자", "강희성 (BGMS Team)"],
            ["이메일", "ka6865@gmail.com"],
            ["서비스 URL", "https://bgms.kr"],
          ]}
        />
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "12px" }}>
          본 약관에 관한 문의는 위 이메일로 연락 주시면 영업일 기준 3일 이내 답변드립니다.
        </p>
      </Section>

      <p
        style={{
          fontSize: "13px",
          color: "rgba(255,255,255,0.3)",
          marginTop: "16px",
        }}
      >
        부칙: 본 약관은 2026년 6월 22일부터 시행합니다.
      </p>

      {/* 하단 링크 */}
      <div
        style={{
          marginTop: "48px",
          paddingTop: "24px",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          gap: "16px",
          fontSize: "13px",
          color: "rgba(255,255,255,0.35)",
        }}
      >
        <Link href="/" style={{ color: "rgba(255,255,255,0.35)", textDecoration: "none" }}>
          홈으로
        </Link>
        <span>·</span>
        <Link href="/privacy" style={{ color: "rgba(255,255,255,0.35)", textDecoration: "none" }}>
          개인정보처리방침
        </Link>
      </div>
    </div>
  );
}

// 섹션 컴포넌트
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: "40px" }}>
      <h2
        style={{
          fontSize: "16px",
          fontWeight: 700,
          color: "white",
          marginBottom: "16px",
          paddingBottom: "8px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: "14px",
          color: "rgba(255,255,255,0.7)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {children}
      </div>
    </section>
  );
}

// 테이블 컴포넌트
function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto", marginTop: "8px" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "13px",
        }}
      >
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  backgroundColor: "rgba(255,255,255,0.05)",
                  color: "rgba(255,255,255,0.6)",
                  fontWeight: 600,
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "8px 12px",
                    color: "rgba(255,255,255,0.65)",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                    verticalAlign: "top",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
