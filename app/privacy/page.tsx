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
        // flex 부모 안에서 넓은 표가 페이지 폭을 늘리지 않도록 폭을 고정하고 표 영역만 가로 스크롤한다.
        width: "100%",
        minWidth: 0,
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
        최종 업데이트: 2026년 10월 15일
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
          <li>이메일 주소 (카카오 계정 로그인 시 카카오로부터 제공받음)</li>
          <li>PUBG 인게임 닉네임 (선택)</li>
          <li>서비스 플랫폼 구분 (Steam / Kakao, 선택)</li>
        </ul>
        <SubTitle>2-2. 서비스 이용 시 자동 수집 항목</SubTitle>
        <ul>
          <li>세션 ID (비식별 랜덤 값)</li>
          <li>방문 페이지 경로 및 페이지 제목</li>
          <li>서비스 접속 환경 (production / development 구분)</li>
          <li>서비스 이용 시간 및 이벤트 발생 시각</li>
          <li>유입 경로 (처음 방문한 페이지의 이전 사이트 도메인과 utm 캠페인 값, 경로·검색어는 저장하지 않음)</li>
          <li>IP 주소 (Supabase 서버 로그 자동 수집)</li>
          <li>광고 쿠키·광고 식별자와 웹 방문 기록 (Google이 광고 게재를 위해 수집, 9절 참고)</li>
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
        <SubTitle>2-4. 커뮤니티 이용 시 처리 항목</SubTitle>
        <ul>
          <li>작성자 닉네임, 게시글·댓글 내용, 첨부 이미지</li>
          <li>조회수 중복 집계 방지를 위한 IP 해시값 (원래 IP를 복원할 수 없는 값)</li>
          <li>게시글 작성 횟수 제한을 위한 작성 기록</li>
          <li>자동 등록 방지 확인 결과 (Cloudflare Turnstile)</li>
        </ul>
        <SubTitle>2-5. 디스코드 봇 연동 시 처리 항목</SubTitle>
        <ul>
          <li>디스코드 사용자 ID, 연동한 PUBG 닉네임과 플랫폼</li>
        </ul>
        <p>
          서비스는 민감정보, 고유식별정보(주민등록번호 등), 가명정보를 처리하지 않습니다.
        </p>
      </Section>

      <Section title="3. 개인정보 수집 및 이용 목적">
        <ul>
          <li>회원 식별 및 로그인 인증 서비스 제공</li>
          <li>PUBG 전적 검색, AI 코칭 분석 서비스 제공</li>
          <li>서비스 품질 개선을 위한 이용 통계 분석</li>
          <li>서비스 장애 탐지 및 보안 사고 대응</li>
          <li>맞춤형 광고 제공 (Google AdSense)</li>
        </ul>
      </Section>

      <Section title="4. 개인정보 보유 및 이용 기간">
        <Table
          headers={["항목", "보유 기간"]}
          rows={[
            ["회원 계정 정보 (이메일)", "회원 탈퇴 시까지"],
            ["게시글·댓글", "이용자가 삭제할 때까지 (탈퇴 시 작성자 연결을 끊고 내용은 유지)"],
            ["PUBG 전적 캐시 데이터", "마지막 조회일로부터 90일"],
            ["서비스 이용 로그 (analytics_events)", "수집일로부터 30일"],
            ["이용 로그 수집 횟수 제한 기록", "수집일로부터 7일"],
            ["게시글 조회 IP 해시값, 게시글 작성 기록", "수집 시점부터 24시간"],
            ["AI 분석 캐시", "수집일로부터 30일"],
            ["PUBG API 오류 로그", "수집일로부터 30일"],
            ["디스코드 연동 정보", "연동 해제 또는 삭제 요청 시까지"],
          ]}
        />
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "8px" }}>
          관계 법령에 따라 일정 기간 보존이 필요한 정보는 해당 기간 동안 보관합니다.
          탈퇴 전에 작성한 게시글·댓글의 삭제를 원하면 탈퇴 전에 직접 삭제하거나 고객센터로 요청할 수 있습니다.
        </p>
        <SubTitle>4-1. 개인정보의 파기 절차 및 방법</SubTitle>
        <ul>
          <li>보유 기간이 지나거나 처리 목적이 달성된 개인정보는 매일 실행되는 정리 작업으로 지체 없이 파기합니다.</li>
          <li>회원 탈퇴 시 계정 정보는 즉시 삭제합니다.</li>
          <li>전자적 파일은 복구할 수 없는 방법으로 데이터베이스와 저장소에서 삭제하며, 종이 문서로는 개인정보를 보관하지 않습니다.</li>
        </ul>
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
            ["Supabase Inc.", "회원 인증, 데이터베이스 운영 및 저장 (저장 위치: 대한민국 서울 리전)"],
            ["Vercel Inc.", "웹 서비스 호스팅 및 CDN"],
            ["Cloudflare Inc.", "R2 스토리지 (텔레메트리 캐시 저장), 게시판 자동 등록 방지 (Turnstile)"],
            ["Google LLC", "Analytics(GA4) 이용 통계, AdSense 광고 제공, Gemini AI 분석"],
            ["KRAFTON Inc.", "PUBG 공식 API를 통한 전적 데이터 조회"],
          ]}
        />
        <SubTitle>7-1. 개인정보의 국외 이전</SubTitle>
        <p>
          위 수탁자 중 아래 사업자는 국외에 소재하며, 서비스 이용 시점에 네트워크를 통해 정보가 전송됩니다.
          회원 정보와 이용 로그를 저장하는 Supabase 데이터베이스는 대한민국(서울) 리전에 있습니다.
          실제 저장·처리 위치는 각 사업자의 데이터센터 운영 정책에 따릅니다.
        </p>
        <Table
          headers={["이전받는 자 (소재국)", "이전 항목", "이용 목적", "보유 기간"]}
          rows={[
            ["Vercel Inc. (미국)", "접속 기록, IP 주소", "웹 서비스 호스팅, 접속 통계", "사업자 정책에 따름"],
            ["Cloudflare Inc. (미국)", "PUBG 전적·텔레메트리 캐시, 자동 등록 방지 확인 정보", "분석 결과 저장, 스팸 방지", "4절의 보유 기간"],
            ["Google LLC (미국)", "서비스 이용 기록, 광고 쿠키·식별자, AI 분석 요청 내용 (7-2 참고)", "이용 통계, 광고 게재, AI 분석", "사업자 정책에 따름"],
          ]}
        />
        <p>
          국외 이전을 원하지 않는 경우 회원 탈퇴와 서비스 이용 중단으로 거부할 수 있으며,
          광고 쿠키는 9절의 방법으로 거부할 수 있습니다. 다만 이전을 거부하면 서비스를 이용할 수 없습니다.
        </p>
        <SubTitle>7-2. AI 분석 처리</SubTitle>
        <p>
          전적 AI 분석은 PUBG 닉네임과 경기 기록을, 커뮤니티 자동 답변은 게시글·댓글 내용을 Google Gemini API로 전송해 결과를 생성합니다.
          현재 Gemini API를 무료 이용 조건으로 사용하며, 이 조건에서 Google은 전송된 내용과 생성 결과를 자사 서비스 개선에 사용할 수 있고
          검토자가 계정 정보와 분리된 상태로 내용을 확인할 수 있습니다.
          게시글·댓글에는 다른 사람이 알아볼 수 있는 개인정보를 적지 않도록 주의해 주세요.
          AI 결과는 참고용이며 이용자의 권리나 의무에 영향을 주는 자동화된 결정에 사용하지 않습니다.
        </p>
      </Section>

      <Section title="8. 쿠키(Cookie) 및 유사 기술 사용">
        <p>
          서비스는 이용자 경험 개선 및 서비스 분석을 위해 쿠키와 유사 기술을 사용합니다.
        </p>
        <SubTitle>사용 목적</SubTitle>
        <ul>
          <li>로그인 세션 유지</li>
          <li>서비스 이용 통계 수집 (Google Analytics 4)</li>
          <li>맞춤형 광고 제공 (Google AdSense)</li>
        </ul>
        <SubTitle>브라우저 설정을 통한 쿠키 거부</SubTitle>
        <p>
          이용자는 브라우저 설정을 통해 쿠키 저장을 거부할 수 있습니다.
          다만, 쿠키 거부 시 로그인 및 일부 서비스 이용이 제한될 수 있습니다.
        </p>
      </Section>

      <Section title="9. 광고 서비스와 맞춤형 광고(행태정보)">
        <p>
          서비스는 운영 비용 충당을 위해 Google AdSense 광고를 게재합니다.
        </p>
        <ul>
          <li>
            Google을 포함한 제3자 공급업체는 쿠키를 사용하여 이용자가 이 서비스 또는 다른 웹사이트를
            이전에 방문한 기록을 바탕으로 광고를 게재합니다.
          </li>
          <li>
            Google은 광고 쿠키를 사용하여 Google과 파트너가 이 서비스 및 다른 웹사이트 방문 기록을
            바탕으로 이용자에게 광고를 게재할 수 있도록 합니다.
          </li>
          <li>
            Google이 파트너 사이트의 정보를 사용하는 방법은{" "}
            <a
              href="https://policies.google.com/technologies/partner-sites"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent, #F2A900)" }}
            >
              Google 파트너 사이트 정보 사용 안내
            </a>
            에서 확인할 수 있습니다.
          </li>
        </ul>
        <SubTitle>행태정보 수집·이용 안내</SubTitle>
        <Table
          headers={["항목", "내용"]}
          rows={[
            ["수집하는 행태정보", "웹 방문 기록, 광고 쿠키, 광고 식별자, 브라우저·기기 정보"],
            ["수집 방법", "이용자가 서비스에 접속할 때 Google 광고 스크립트가 자동 수집"],
            ["수집 목적", "이용자의 관심사에 맞춘 광고 게재와 광고 성과 측정"],
            ["수집·처리하는 자", "Google LLC (서비스 운영자는 광고 쿠키 정보를 직접 저장하지 않음)"],
            ["보유·이용 기간", "Google의 광고 쿠키 정책에 따름"],
          ]}
        />
        <p>
          서비스는 만 14세 미만으로 알고 있는 이용자를 대상으로 맞춤형 광고를 제공하지 않습니다.
        </p>
        <SubTitle>맞춤형 광고 거부 방법</SubTitle>
        <ul>
          <li>
            <a
              href="https://adssettings.google.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent, #F2A900)" }}
            >
              Google 광고 설정
            </a>
            에서 맞춤 광고를 사용 중지할 수 있습니다.
          </li>
          <li>
            제3자 공급업체의 맞춤형 광고 쿠키는{" "}
            <a
              href="https://www.aboutads.info/choices"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent, #F2A900)" }}
            >
              www.aboutads.info
            </a>
            에서 거부할 수 있습니다.
          </li>
          <li>브라우저 설정에서 쿠키를 차단하거나 삭제할 수 있습니다 (8절 참고).</li>
        </ul>
        <p>
          행태정보와 관련한 문의·고충은 12절의 개인정보 보호책임자에게 접수하실 수 있습니다.
        </p>
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
          권리 행사는 법정대리인이나 위임을 받은 사람을 통해서도 할 수 있습니다.
          서비스는 가입 시 연령을 확인하지 않으며, 법령상 동의가 필요한 처리를 하는 경우 만 14세 미만 아동은 법정대리인의 동의를 받습니다.
          만 14세 미만 아동의 법정대리인은 아동의 개인정보 열람·정정·삭제·처리정지를 요청할 수 있습니다.
        </p>
        <p>
          위 권리 행사는 아래 이메일로 요청하시면 지체 없이 처리합니다.
        </p>
      </Section>

      <Section title="11. 개인정보의 안전성 확보 조치">
        <ul>
          <li>데이터베이스 행 단위 접근 권한(RLS)과 관리자 권한 검사로 접근 권한을 최소화합니다.</li>
          <li>모든 통신은 HTTPS로 암호화하고, 데이터베이스 접근 키 등 비밀 값은 서버에서만 사용합니다.</li>
          <li>문의 증빙 파일은 관리자만 접근할 수 있는 비공개 저장소에 보관합니다.</li>
          <li>IP 주소는 조회수 집계에 필요한 경우에도 복원할 수 없는 해시값으로만 저장합니다.</li>
          <li>핵심 데이터는 정기적으로 백업하고 복원 가능 여부를 검증합니다.</li>
        </ul>
      </Section>

      <Section title="12. 개인정보 보호책임자">
        <Table
          headers={["항목", "내용"]}
          rows={[
            ["서비스", "BGMS (Battleground Map Service)"],
            ["운영자", "강희성 (BGMS Team)"],
            ["이메일", "ka6865@gmail.com"],
            ["서비스 URL", "https://bgms.kr"],
          ]}
        />
        <p>
          개인정보 관련 문의·고충 처리와 권리 행사 요청은 위 이메일과 고객센터 1:1 문의로 접수하며 지체 없이 답변합니다.
          전화 상담은 운영하지 않습니다.
        </p>
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)", marginTop: "8px" }}>
          개인정보 침해에 관한 신고 또는 상담은 아래 기관에 문의하실 수도 있습니다.<br />
          개인정보침해 신고센터: 118 (privacy.kisa.or.kr) | 개인정보 분쟁조정위원회: 1833-6972 (www.kopico.go.kr)<br />
          대검찰청: 1301 (www.spo.go.kr) | 경찰청: 182 (ecrm.police.go.kr)
        </p>
      </Section>

      <Section title="13. 개인정보처리방침의 변경">
        <p>
          본 방침은 법령, 정책 또는 서비스 변경에 따라 수정될 수 있습니다.
          변경 시 서비스 내 공지사항 또는 본 페이지를 통해 사전 고지합니다.
        </p>
        <p style={{ fontSize: "13px", color: "rgba(255,255,255,0.4)" }}>
          시행일: 2026년 10월 15일
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
