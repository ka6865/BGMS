import { NextResponse } from "next/server";
import { parse } from "node-html-parser";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@/utils/supabase/server";
import { identifyCategory } from "@/lib/patch-notes/categorize";
import { sanitizeBoardHtml } from "@/lib/board/sanitizeHtml";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// URL 정제 헬퍼 (트래커 제거 및 필수 파라미터만 유지)
function cleanUrl(url: string) {
  try {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    const newParams = new URLSearchParams();
    const allowed = ['articleId', 'bbsId', 'category', 'postId'];
    allowed.forEach(p => { if (params.has(p)) newParams.set(p, params.get(p)!); });
    urlObj.search = newParams.toString();
    return urlObj.toString();
  } catch { return url; }
}

// 기사 제목 및 URL 기반 카테고리 식별 헬퍼 함수
// identifyCategory 는 lib/patch-notes/categorize.ts 로 통합되었습니다.

// AI 요약 헬퍼 함수 (2026년 표준 모델 Gemini 2.5-Flash 적용)
async function summarizeText(rawText: string, categoryType: 'PATCH_NOTE' | 'STORE_INFO' | 'DEV_LETTER' | 'GENERAL') {
  if (!process.env.GOOGLE_GEMINI_API_KEY) {
    return "❌ ERROR: API 키가 설정되지 않았습니다. (.env.local 확인)";
  }

  const textToProcess = rawText.substring(0, 8000).trim();
  if (textToProcess.length < 50) {
    return `❌ ERROR: 수집된 텍스트가 너무 짧습니다 (${textToProcess.length}자). 본문을 읽지 못했을 가능성이 큽니다.`;
  }

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);

  // 2026년 기준 가장 안정적인 별칭 우선 순위 설정
  const modelsToTry = ["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"];

  let systemContext = "";
  let structureGuide = "";
  let hallucinationGuard = "";

  if (categoryType === 'STORE_INFO') {
    systemContext = "당신은 PUBG(배틀그라운드) 전문 상품/상점 분석가입니다. 상점 업데이트 및 아이템 출시 소식을 요약해 주세요.";
    structureGuide = `
[요약 제약 조건 - 절대 엄수]
1. 섹션(카테고리)은 반드시 **최대 3개에서 4개**까지만 도출하세요. (예: [2026 블랙 마켓], [PNC 2026 헬멧], [더블 G-Coin 프로모션] 등 본문에 등장한 신규 판매 상품 혹은 특별 이벤트 명칭 위주)
2. 각 섹션 하단에 작성하는 불렛포인트(-) 요약문은 **반드시 섹션당 최대 2개 이하**로 제한하세요.
3. 각 불렛포인트는 판매 기간(PC/콘솔), 가격 및 혜택, 주요 구성 아이템 위주로 **반드시 15자 내외의 극도로 짧고 직관적인 핵심 1줄 요약**이어야 합니다.
`;
    hallucinationGuard = `
[환각 차단 가이드라인 - 절대 엄수]
* 본문에 명시되지 않은 '인게임 시스템 최적화', '업데이트 42.1 편의성 개선', '버그 수정' 등 패치노트에나 나올 법한 일반적이고 템플릿화된 문구는 절대 지어내어 쓰지 마십시오.
* 오직 본문에 언급된 판매용 아이템, G-Coin 혜택, 판매 일정, 콜라보 스킨 팩 등의 팩트만 기재해야 합니다.
`;
  } else if (categoryType === 'DEV_LETTER') {
    systemContext = "당신은 PUBG(배틀그라운드) 게임 기획 및 개발 심층 분석가입니다. 개발진의 기획 의도 및 철학이 담긴 개발일지를 요약해 주세요.";
    structureGuide = `
[요약 제약 조건 - 절대 엄수]
1. 섹션(카테고리)은 반드시 **최대 3개에서 4개**까지만 도출하세요. (예: [개편 기획 의도], [주요 메커니즘 변경], [향후 타겟 및 개선 방향] 등)
2. 각 섹션 하단에 작성하는 불렛포인트(-) 요약문은 **반드시 섹션당 최대 2개 이하**로 제한하세요.
3. 각 불렛포인트는 개발팀이 무엇을 왜 바꾸고자 하는지에 대한 핵심 기획 사실 위주로 **반드시 15자 내외의 극도로 짧고 직관적인 핵심 1줄 요약**이어야 합니다.
`;
    hallucinationGuard = `
[환각 차단 가이드라인 - 절대 엄수]
* 본문에 언급되지 않은 특정 스킨 출시 일정이나 인게임 편의 기능 향상 등을 임의로 지어내어 채워 넣지 마십시오.
* 오직 개발진이 기획서/일지 본문에서 밝힌 설계 사상, 타겟 수치, 변경 근거 팩트만 서술해 주십시오.
`;
  } else {
    systemContext = "당신은 PUBG(배틀그라운드) 전문 전략 분석가입니다. 패치노트 원문을 요약해 주세요.";
    structureGuide = `
[요약 제약 조건 - 절대 엄수]
1. 섹션(카테고리)은 반드시 **최대 3개에서 4개**까지만 도출하세요. (예: [신규 무기], [맵 업데이트], [시스템 개선] 등)
2. 각 섹션 하단에 작성하는 불렛포인트(-) 요약문은 **반드시 섹션당 최대 2개 이하**로 제한하세요.
3. 각 불렛포인트는 **반드시 15자 내외의 극도로 짧고 직관적인 핵심 1줄 요약**이어야 합니다.
`;
    hallucinationGuard = `
[환각 차단 가이드라인 - 절대 엄수]
* 본문에 언급되지 않은 총기 출시, 가격 정보, 할인 이벤트, 인게임 수정을 임의로 지어내 쓰지 마십시오.
`;
  }

  const prompt = `
${systemContext}
제공된 원문을 읽고, 유저들이 반드시 알아야 할 가장 핵심적인 변화와 정보를 극도로 슬림하고 강렬하게 요약해 주세요.

${structureGuide}

${hallucinationGuard}

반드시 한국어로 작성하고, 가장 핵심적인 키워드만 **강조**해 주십시오.

원문:
${textToProcess}`;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response.text();

      if (text && text.length > 5) return text;
    } catch (err: any) {
      const errorMsg = err.message || "";
      if (errorMsg.includes("429") || errorMsg.includes("quota") ||
          errorMsg.includes("503") || errorMsg.includes("Service Unavailable") ||
          errorMsg.includes("deadline exceeded")) {
        console.warn(`⚠️ [AI] ${modelName} 서버 혼잡으로 다음 가용 모델로 전환합니다.`);
        continue;
      }
      return `❌ AI 요약 중 오류가 발생했습니다: ${errorMsg}`;
    }
  }
  return "❌ 현재 AI 서비스 연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.";
}

// 1. 글로벌 공식 패치노트 파싱
async function fetchOfficialPatchNote(supabaseAdmin: any, manualUrl?: string) {
  const targetUrl = manualUrl ? cleanUrl(manualUrl) : "https://pubg.com/ko/news?category=patch_notes";
  const response = await fetch(targetUrl, { cache: 'no-store', headers: { "User-Agent": "Mozilla/5.0" }});
  if (!response.ok) throw new Error("공식 홈페이지 접속 실패");
  const html = await response.text();
  let title = "";
  let fullUrl = "";

  if (manualUrl) {
    const root = parse(html);
    title = root.querySelector("h1")?.text.trim() || root.querySelector("title")?.text.split("|")[0].trim() || "글로벌 패치노트";
    fullUrl = targetUrl;
  } else {
    const nuxtRegex = /postId:(\d+),[\s\S]{1,1000}title:"([^"]+?)"/g;
    const match = nuxtRegex.exec(html);
    if (!match) return null;
    fullUrl = `https://pubg.com/ko/news/${match[1]}`;
    title = match[2];
  }

  if (!manualUrl) {
    const { data: lastSync } = await supabaseAdmin.from("sync_history").select("last_url").eq("type", "patch_notes").single();
    if (lastSync?.last_url === fullUrl) return null;
  }

  let summaryOrError = "";
  let imageUrl = "";
  try {
    const detailRes = await fetch(fullUrl, { cache: 'no-store' });
    if (detailRes.ok) {
      const detailHtmlText = await detailRes.text();
      const root = parse(detailHtmlText);
      const content = root.querySelector(".post-detail__content") || root.querySelector(".news-detail__content") || root.querySelector("article");

      const categoryType = identifyCategory(title, fullUrl);
      summaryOrError = await summarizeText(content?.text || "", categoryType);

      // 썸네일 이미지 파싱 (og:image 또는 _thumb 이미지)
      let ogImage = "";
      const ogImageMatch = detailHtmlText.match(/<meta[^>]*?property=["']og:image["'][^>]*?content=["']([^"']+)["']/i) ||
                           detailHtmlText.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?property=["']og:image["']/i);
      if (ogImageMatch && ogImageMatch[1]) {
        ogImage = ogImageMatch[1].replace(/\\u002F/g, '/');
      } else {
        const metaOg = root.querySelector("meta[property='og:image']")?.getAttribute("content");
        if (metaOg) ogImage = metaOg;
      }

      if (ogImage) {
        imageUrl = ogImage;
      } else {
        const thumbMatch = detailHtmlText.match(/https?:\/\/[^\s"'<>]*?_thumb\.(?:jpg|jpeg|gif|png)/i);
        if (thumbMatch) imageUrl = thumbMatch[0];
      }
    } else {
      summaryOrError = `❌ 본문 접속 실패 (${detailRes.status})`;
    }
  } catch(e: any) { summaryOrError = `❌ 시스템 오류: ${e.message}`; }

  return { type: "patch_notes", title, fullUrl, summaryOrError, imageUrl };
}

// 2. 카카오 무점검 패치 파싱
async function fetchKakaoPatchNote(supabaseAdmin: any, manualUrl: string) {
  const targetUrl = cleanUrl(manualUrl);
  const response = await fetch(targetUrl, { cache: 'no-store', headers: { "User-Agent": "Mozilla/5.0" }});
  if (!response.ok) throw new Error(`카카오 페이지 접속 실패 (${response.status})`);

  const rawHtml = await response.text();
  const root = parse(rawHtml);
  let title = root.querySelector(".tit_view")?.text.trim() || root.querySelector(".subject")?.text.trim() || root.querySelector("title")?.text.trim() || "카카오 패치노트";

  let summaryOrError = "";
  let imageUrl = "";
  try {
    const ajaxUrl = targetUrl.replace("/notice/read?", "/notice/ajax/read?");
    const detailRes = await fetch(ajaxUrl, {
      cache: 'no-store',
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": targetUrl }
    });

    // 카카오 OG 이미지 파싱
    let ogImage = "";
    const ogImageMatch = rawHtml.match(/<meta[^>]*?property=["']og:image["'][^>]*?content=["']([^"']+)["']/i) ||
                         rawHtml.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?property=["']og:image["']/i);
    if (ogImageMatch && ogImageMatch[1]) {
      ogImage = ogImageMatch[1].replace(/\\u002F/g, '/');
    } else {
      const metaOg = root.querySelector("meta[property='og:image']")?.getAttribute("content");
      if (metaOg) ogImage = metaOg;
    }
    if (ogImage) imageUrl = ogImage;

    if (detailRes.ok) {
      const detailHTML = await detailRes.text();
      const detailRoot = parse(detailHTML);
      const realTitle = detailRoot.querySelector(".tit_view")?.text.trim();
      if (realTitle) title = realTitle;

      detailRoot.querySelectorAll('script, style, ins, .wrap_page, .view_btn').forEach(el => el.remove());
      const articleBody = detailRoot.querySelector(".board-view__area") || detailRoot.querySelector(".view_cont") || detailRoot;
      const contentText = articleBody.text.replace(/\s+/g, ' ').trim();

      const categoryType = identifyCategory(title, targetUrl);
      summaryOrError = await summarizeText(contentText, categoryType);
    } else {
      summaryOrError = `❌ 본문 데이터 수집 실패 (${detailRes.status})`;
    }
  } catch(e: any) {
    summaryOrError = `❌ 시스템 오류: ${e.message}`;
  }

  return { type: "kakao_patch_notes", title: `[카카오] ${title}`, fullUrl: targetUrl, summaryOrError, imageUrl };
}

export async function POST(request: Request) {
  try {
    const supabaseServer = await createClient();
    const { data: { user } } = await supabaseServer.auth.getUser();
    if (!user) return NextResponse.json({ error: "🔒 로그인이 필요합니다." }, { status: 401 });

    const { data: profile } = await supabaseServer.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return NextResponse.json({ error: "⛔ 관리자 권한이 없습니다." }, { status: 403 });

    const { url } = await request.json();
    const manualUrl = url?.trim();
    const supabaseAdmin = createSupabaseAdminClient(supabaseUrl, supabaseServiceKey);
    const results: any[] = [];

    if (manualUrl) {
      if (manualUrl.includes("pubg.com")) {
        const res = await fetchOfficialPatchNote(supabaseAdmin, manualUrl);
        if (res) results.push(res);
      } else if (manualUrl.includes("daum.net") || manualUrl.includes("kakao.com")) {
        const res = await fetchKakaoPatchNote(supabaseAdmin, manualUrl);
        if (res) results.push(res);
      }
    } else {
      const res = await fetchOfficialPatchNote(supabaseAdmin);
      if (res) results.push(res);
    }

    if (results.length === 0) return NextResponse.json({ success: true, message: "이미 최신 상태입니다." });

    const postsToInsert = results.map(r => ({
      title: r.title,
      // AI 생성 HTML 도 DB 저장 전에 정화한다.
      content: sanitizeBoardHtml(buildHtml(r.summaryOrError, r.fullUrl)),
      author: 'BGMS 시스템',
      category: '배그 소식',
      is_notice: false,
      status: 'draft' as const,
      image_url: r.imageUrl || null
    }));

    for (const post of postsToInsert) {
      const { data: existingPost } = await supabaseAdmin
        .from('posts')
        .select('id')
        .eq('title', post.title)
        .maybeSingle();

      if (existingPost) {
        console.log(`📝 기존 패치노트 글(ID: ${existingPost.id})이 발견되어 업데이트합니다.`);
        const { error: updateError } = await supabaseAdmin
          .from('posts')
          .update({
            content: post.content,
            author: post.author,
            category: post.category,
            image_url: post.image_url
          })
          .eq('id', existingPost.id);
        if (updateError) throw new Error(`기존 패치노트 업데이트 실패: ${updateError.message}`);
      } else {
        console.log('📝 신규 패치노트 글을 등록합니다. (초안 상태)');
        const { error: insertError } = await supabaseAdmin
          .from('posts')
          .insert(post);
        if (insertError) throw new Error(`신규 패치노트 등록 실패: ${insertError.message}`);
      }
    }

    for (const r of results) {
      await supabaseAdmin.from("sync_history").upsert({ type: r.type, last_url: r.fullUrl, updated_at: new Date().toISOString() }, { onConflict: 'type' });
    }

    return NextResponse.json({ success: true, details: results.map(r => r.title) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * HTML 문자열의 모든 줄바꿈과 불필요한 연속 공백을 압축(minify)하여 white-space: pre-wrap 오작동을 영구 방지하는 헬퍼 함수
 */
function minifyHtml(html: string): string {
  return html
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

/**
 * AI 요약 본문을 세련된 모바일 반응형 카드 박스(표 형태)로 정교하게 포맷팅하는 헬퍼 함수
 */
function formatAiSummaryToHtml(summary: string): string {
  if (!summary) return "";

  // 1. 만약 대괄호 [섹션] 형태가 없고, "* **제목**:" 또는 "- **제목**:" 형태의 목록이 존재한다면,
  // 이를 대괄호 [섹션] 형태로 전처리하여 쪼개기 쉽게 만듭니다.
  let processed = summary;
  if (!summary.includes('[') || !summary.includes(']')) {
    processed = summary.replace(/[*•-]\s*\*\*(.*?)\*\*[:\s]*/g, '\n[$1]\n- ');
  }

  // 만약 카테고리 표기법([섹션])이 여전히 존재하지 않는 단순 텍스트인 경우 줄바꿈만 치환하여 반환
  if (!processed.includes('[') || !processed.includes(']')) {
    return minifyHtml(`
      <div class="bg-[#1a1a1a] border border-white/5 rounded-lg p-4 text-gray-300 text-sm leading-relaxed">
        ${processed.replace(/\n/g, '<br/>')}
      </div>
    `);
  }

  // [카테고리] 단위로 정밀하게 split
  const sections = processed.split(/(?=\[.*?\])/g);

  const cardsHtml = sections.map(section => {
    const titleMatch = section.match(/\[(.*?)\]/);
    if (!titleMatch) return "";

    const title = titleMatch[1].trim();
    const content = section.replace(`[${titleMatch[1]}]`, "").trim();

    // 카테고리 텍스트에 어울리는 최적의 매치 이모지 지정
    let emoji = "🔹";
    if (title.includes("신규") || title.includes("새로운")) emoji = "🆕";
    else if (title.includes("밸런스") || title.includes("조정") || title.includes("너프") || title.includes("버프")) emoji = "⚖️";
    else if (title.includes("시스템") || title.includes("편의성") || title.includes("개선") || title.includes("UI") || title.includes("UX")) emoji = "⚙️";
    else if (title.includes("수정") || title.includes("해결") || title.includes("버그")) emoji = "🛠️";
    else if (title.includes("맵") || title.includes("지형") || title.includes("월드")) emoji = "🗺️";
    else if (title.includes("무기") || title.includes("아이템")) emoji = "🔫";

    // 본문 줄바꿈 및 리스트 아이템 정밀 파싱
    const items = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 2)
      .map(line => {
        // 기존의 불렛 마커(-, *, • 등)를 말끔하게 제거하고 텍스트 정규화
        const text = line.replace(/^[-*•\s]+/, "").trim();
        // 볼드 처리(**텍스트**)를 Tailwind 스타일이 적용된 강조용 strong 태그로 치환
        const highlighted = text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#F2A900] font-black">$1</strong>');

        return `
          <li class="relative pl-4 text-gray-300 text-xs md:text-sm leading-normal mb-1.5 list-none">
            <span class="absolute left-0 top-0 text-[#F2A900] font-bold">✓</span>
            ${highlighted}
          </li>
        `;
      }).join("");

    if (!items) return "";

    return `
      <div class="bg-[#1a1a1a] border border-white/5 rounded-lg p-4 shadow-md transition-all hover:border-white/10 hover:shadow-lg">
        <div class="text-[#F2A900] text-sm md:text-base font-black mb-2 flex items-center gap-1.5 border-b border-white/5 pb-1.5">
          <span>${emoji}</span> ${title}
        </div>
        <ul class="space-y-1 m-0 p-0">${items}</ul>
      </div>
    `;
  }).join("");

  return minifyHtml(cardsHtml);
}

function buildHtml(summaryOrError: string, fullUrl: string) {
  const isError = summaryOrError.startsWith("❌");
  if (isError) {
    return minifyHtml(`
      <div class="patch-note-container space-y-4">
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <h3 class="flex items-center gap-1.5 text-red-500 font-black text-lg mb-2">
            🚨 동기화 오류
          </h3>
          <div class="prose prose-invert max-w-none text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">${summaryOrError}</div>
        </div>
        <div class="flex flex-col items-center justify-center p-6 bg-[#1a1a1a] rounded-lg border border-white/5">
          <p class="text-gray-400 text-xs mb-3">더 자세한 내용은 공식 원문에서 확인하실 수 있습니다.</p>
          <a href="${fullUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-6 py-2.5 bg-[#F2A900] text-black font-black text-sm rounded hover:bg-[#cc8b00] transition-all transform active:scale-95 shadow-md shadow-[#F2A900]/20">🔗 원문 보러가기</a>
        </div>
      </div>
    `);
  }

  return minifyHtml(`
    <div class="patch-note-container space-y-4">
      <div class="bg-[#F2A900]/10 border border-[#F2A900]/30 rounded-lg p-4 mb-1">
        <h3 class="flex items-center gap-1.5 text-[#F2A900] font-black text-base md:text-lg">
          🤖 BGMS AI 패치노트 핵심 요약
        </h3>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        ${formatAiSummaryToHtml(summaryOrError)}
      </div>

      <div class="flex flex-col items-center justify-center p-6 bg-[#1a1a1a] rounded-lg border border-white/5">
        <p class="text-gray-400 text-xs mb-3">더 자세한 내용은 공식 원문에서 확인하실 수 있습니다.</p>
        <a href="${fullUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-6 py-2.5 bg-[#F2A900] text-black font-black text-sm rounded hover:bg-[#cc8b00] transition-all transform active:scale-95 shadow-md shadow-[#F2A900]/20">🔗 원문 보러가기</a>
      </div>
    </div>
  `);
}


