import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "개인정보처리방침",
  description: "BGMS 서비스의 개인정보 수집 및 이용에 관한 방침을 안내합니다.",
};

export default function PrivacyPage() {
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
        개인정보처리방침
      </h1>
      <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.35)", marginBottom: "40px" }}>
        최종 업데이트: 2026년 9월 21일
      </p>

      <Section title="1. 개요">
        <p>
          BGMS(이하 &quot;서비스&quot;)는 배틀그라운드 유저를 위한 전술 지도, 전적 검색,
          AI 분석 서비스를 제공합니다. 본 방침은 서비스 이용 과정에서 수집되는
          개인정보의 처리 방법 및 보호 조치를 안내합니다.
        </p>
        <p>
          서비스 이용자는 본 방침에 동의함으로써 아래에 명시된 방법으로 개인정보가
          처리될 수 있음을 인정합니다.
        </p>
      </Section>

      <Section title="2. 수집하는 개인정보 항목">
        <SubTitle>2-1. 회원가입 시 수집 항목</SubTitle>
        <ul>
          <li>이메일 주소 (Supabase Auth를 통한 소셜/이메일 로그인)</li>
          <li>PUBG 인게임 닉네임 (선택)</li>
          <li>서비스 플랫폼 구분 (Steam / Kakao, 선택)</li>
        </ul>
        <SubTitle>2-2. 서비스 이용 시 자동 수집 항목</SubTitle>
        <ul>
          <li>세션 ID (비식별 랜덤 값)</li>
          <li>방문 페이지 경로 및 페이지 제목</li>
          <li>서비스 접속 환경 (production / development 구분)</li>
          <li>서비스 이용 시간 및 이벤트 발생 시각</li>
          <li>IP 주소 (Supabase 서버 로그 자동 수집)</li>
        </ul>
        <SubTitle>2-3. PUBG 전적 검색 시 처리 항목</SubTitle>
        <ul>
          <li>PUBG 인게임 닉네임 및 Account ID (PUBG 공식 API 조회)</li>
          <li>매치 기록, 무기 숙련도, 시즌 통계 (PUBG 공식 API 응답 데이터)</li>
        </ul>
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "8px" }}>
          ※ PUBG 전적 데이터는 KRAFTON의 공식 PUBG Developer API를 통해 조회되며,
          BGMS는 해당 데이터를 직접 보유하지 않고 캐시 목적으로만 저장합니다.
        </p>
      </Section>

      <Section title="3. 개인정보 수집 및 이용 목적">
        <ul>
          <li>회원 식별 및 로그인 인증 서비스 제공</li>
          <li>PUBG 전적 검색, AI 코칭 분석 서비스 제공</li>
          <li>서비스 품질 개선을 위한 이용 통계 분석</li>
          <li>서비스 장애 탐지 및 보안 사고 대응</li>
          <li>맞춤형 광고 제공 (Google AdSense, 카카오 애드핏)</li>
        </ul>
      </Section>

      <Section title="4. 개인정보 보유 및 이용 기간">
        <Table
          headers={["항목", "보유 기간"]}
          rows={[
            ["회원 계정 정보 (이메일)", "회원 탈퇴 시까지"],
            ["PUBG 전적 캐시 데이터", "마지막 조회일로부터 90일"],
            ["서비스 이용 로그 (analytics_events)", "수집일로부터 1년"],
            ["AI 분석 캐시", "수집일로부터 90일"],
            ["PUBG API 오류 로그", "수집일로부터 30일"],
          ]}
        />
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "8px" }}>
          관계 법령에 따라 일정 기간 보존이 필요한 정보는 해당 기간 동안 보관합니다.
        </p>
      </Section>

      <Section title="5. 고객센터 문의 및 전적 비공개 요청">
        <p>
          로그인한 이용자는 <Link href="/support" style={{ color: "var(--color-accent, #F2A900)" }}>고객센터</Link>에서 FAQ를 확인하고 1:1 문의를 등록할 수 있습니다.
          문의를 처리하기 위해 문의 내용, 계정 식별자, 답변 이력과 접속 시각을 수집합니다.
        </p>
        <p>
          전적 비공개 요청에는 플랫폼·PUBG 닉네임·조회된 Account ID가 함께 저장됩니다.
          본인 계정 확인을 위해 인게임 프로필 또는 최근 전적 화면의 <strong>스크린샷 증빙</strong>을 요청할 수 있으며,
          해당 증빙은 관리자만 접근할 수 있는 비공개 저장소에서 수동 검토에 사용됩니다.
        </p>
        <p>
          관리자에게만 문의와 증빙이 노출되며, 처리 완료 또는 반려된 증빙 파일은 처리일로부터 30일 후 삭제합니다.
          미완료 문의의 증빙은 처리 목적에 필요한 기간 동안 보관하고, 문의가 종료되면 같은 보존 기준을 적용합니다.
        </p>
      </Section>

      <Section title="6. 개인정보의 제3자 제공">
        <p>
          서비스는 이용자의 개인정보를 원칙적으로 제3자에게 제공하지 않습니다.
          다만, 아래의 경우에는 예외로 합니다.
        </p>
        <ul>
          <li>이용자가 사전에 동의한 경우</li>
          <li>법령의 규정에 의한 경우 (수사기관의 적법한 요청 등)</li>
        </ul>
      </Section>

      <Section title="7. 개인정보 처리 위탁">
        <Table
          headers={["수탁자", "위탁 업무 내용"]}
          rows={[
            ["Supabase Inc.", "회원 인증, 데이터베이스 운영 및 저장"],
            ["Vercel Inc.", "웹 서비스 호스팅 및 CDN"],
            ["Cloudflare Inc.", "R2 스토리지 (텔레메트리 캐시 저장)"],
            ["Google LLC", "Analytics(GA4) 이용 통계, AdSense 광고 제공, Gemini AI 분석"],
            ["Kakao Corp.", "애드핏 광고 제공"],
            ["KRAFTON Inc.", "PUBG 공식 API를 통한 전적 데이터 조회"],
          ]}
        />
      </Section>

      <Section title="8. 쿠키(Cookie) 및 유사 기술 사용">
        <p>
          서비스는 이용자 경험 개선 및 서비스 분석을 위해 쿠키와 유사 기술을 사용합니다.
        </p>
        <SubTitle>사용 목적</SubTitle>
        <ul>
          <li>로그인 세션 유지</li>
          <li>서비스 이용 통계 수집 (Google Analytics 4)</li>
          <li>맞춤형 광고 제공 (Google AdSense, 카카오 애드핏)</li>
        </ul>
        <SubTitle>브라우저 설정을 통한 쿠키 거부</SubTitle>
        <p>
          이용자는 브라우저 설정을 통해 쿠키 저장을 거부할 수 있습니다.
          다만, 쿠키 거부 시 로그인 및 일부 서비스 이용이 제한될 수 있습니다.
        </p>
      </Section>

      <Section title="9. 광고 서비스 관련 안내">
        <p>
          서비스는 운영 비용 충당을 위해 아래 광고 플랫폼을 이용합니다.
          각 플랫폼은 이용자의 브라우저 정보와 쿠키를 기반으로 맞춤형 광고를 제공할 수 있습니다.
        </p>
        <ul>
          <li>
            <strong>Google AdSense</strong>: Google의 광고 쿠키를 사용합니다.
            관심 기반 광고를 비활성화하려면{" "}
            <a
              href="https://www.google.com/settings/ads"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent, #F2A900)" }}
            >
              Google 광고 설정
            </a>
            에서 변경하세요.
          </li>
          <li>
            <strong>카카오 애드핏</strong>: 카카오의 광고 쿠키를 사용합니다.
            맞춤형 광고를 거부하려면 카카오 계정 설정에서 변경하세요.
          </li>
        </ul>
      </Section>

      <Section title="10. 이용자의 권리와 행사 방법">
        <p>이용자는 언제든지 다음의 권리를 행사할 수 있습니다.</p>
        <ul>
          <li>개인정보 열람 요청</li>
          <li>개인정보 정정·삭제 요청</li>
          <li>개인정보 처리 정지 요청</li>
          <li>회원 탈퇴 (마이페이지 &gt; 계정 설정)</li>
          <li><Link href="/support" style={{ color: "var(--color-accent, #F2A900)" }}>고객센터 1:1 문의를 통한 열람·정정·삭제 요청</Link></li>
        </ul>
        <p>
          위 권리 행사는 아래 이메일로 요청하시면 지체 없이 처리합니다.
        </p>
      </Section>

      <Section title="11. 개인정보 보호책임자">
        <Table
          headers={["항목", "내용"]}
          rows={[
            ["서비스", "BGMS (Battleground Map Service)"],
            ["운영자", "강희성 (BGMS Team)"],
            ["이메일", "ka6865@gmail.com"],
            ["서비스 URL", "https://bgms.kr"],
          ]}
        />
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "8px" }}>
          개인정보 침해에 관한 신고 또는 상담은 아래 기관에 문의하실 수도 있습니다.<br />
          개인정보침해 신고센터: 118 (privacy.kisa.or.kr) | 개인정보 분쟁조정위원회: 1833-6972
        </p>
      </Section>

      <Section title="12. 개인정보처리방침의 변경">
        <p>
          본 방침은 법령, 정책 또는 서비스 변경에 따라 수정될 수 있습니다.
          변경 시 서비스 내 공지사항 또는 본 페이지를 통해 사전 고지합니다.
        </p>
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)" }}>
          시행일: 2026년 9월 21일
        </p>
      </Section>

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
        <Link href="/terms" style={{ color: "rgba(255,255,255,0.35)", textDecoration: "none" }}>
          서비스 이용약관
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

// 소제목 컴포넌트
function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: "13px",
        fontWeight: 700,
        color: "rgba(255,255,255,0.9)",
        marginTop: "12px",
        marginBottom: "4px",
      }}
    >
      {children}
    </p>
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
