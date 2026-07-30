import { NextResponse } from "next/server";
import { parse } from "node-html-parser";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { identifyCategory } from "@/lib/patch-notes/categorize";
import { sanitizeBoardHtml } from "@/lib/board/sanitizeHtml";
import { authorizeBearerSecret } from "@/lib/server/secretAuth";

/**
 * 운영 관제 채널로 텍스트 알림을 보냅니다.
 * 웹훅이 설정되지 않았거나 전송이 실패해도 본 작업을 중단시키지 않습니다.
 *
 * 주의: 이 메시지는 채널 구성원 전체가 볼 수 있습니다.
 * ADMIN_SECRET_TOKEN, CRON_SECRET 등 비밀값을 절대 포함하지 마십시오.
 */
async function notifyDiscord(content: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[patch-notes] DISCORD_WEBHOOK_URL 미설정으로 알림을 건너뜁니다.");
    return;
  }
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("[patch-notes] Discord 알림 실패:", err instanceof Error ? err.message : err);
  }
}

// 기사 제목 및 URL 기반 카테고리 식별 헬퍼 함수
// identifyCategory 는 lib/patch-notes/categorize.ts 로 통합되었습니다.

// AI 요약 생성 함수 (Gemini Pro -> Flash -> Groq 순차 시도)
async function generateAISummary(rawText: string, categoryType: 'PATCH_NOTE' | 'STORE_INFO' | 'DEV_LETTER' | 'GENERAL'): Promise<string> {
  const geminiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;
  if (!geminiKey && !groqKey) return "";

  let systemContext = "";
  let structureGuide = "";
  let hallucinationGuard = "";

  if (categoryType === 'STORE_INFO') {
    systemContext = "너는 PUBG(배틀그라운드) 전문 상품/상점 분석가야. 상점 업데이트 및 특별 아이템 판매 소식을 핵심 위주로 요약해.";
    structureGuide = "배틀그라운드 상점 안내글을 읽고, 판매 아이템 종류(예: 블랙 마켓, PNC 2026, 스트리머 콜라보), 판매 기간(PC/콘솔), 할인 및 G-Coin 프로모션 혜택 중심으로 3~7개의 불렛포인트로 요약해줘.";
    hallucinationGuard = "[절대 엄수] 본문에 명시되지 않은 '인게임 최적화', '업데이트 42.1 편의 기능 개선', '총기 밸런스 조정' 등 패치노트에나 나올 법한 일반적이고 템플릿화된 문구는 절대 지어내어 쓰지 마. 오직 본문에 언급된 판매 상품, 가격, 일정 등의 팩트만 기재해.";
  } else if (categoryType === 'DEV_LETTER') {
    systemContext = "너는 PUBG(배틀그라운드) 게임 기획 및 개발 심층 분석가야. 개발진의 의도와 철학이 담긴 개발일지를 요약해.";
    structureGuide = "배틀그라운드 개발일지 글을 읽고, 개편 기획 의도 및 배경, 주요 메커니즘 변경 내용, 향후 타겟 및 개선 방향 중심으로 3~7개의 불렛포인트로 요약해줘.";
    hallucinationGuard = "[절대 엄수] 본문에 언급되지 않은 스킨 출시, G-Coin 혜택, 인게임 편의 기능 향상 등을 임의로 지어내어 채워 넣지 마. 오직 개발진이 밝힌 설계 사상, 변경 근거 팩트만 서술해.";
  } else {
    systemContext = "너는 PUBG(배틀그라운드) 전문 전략 분석가야. 패치노트의 핵심을 요약하는 전문가로서 게이머들에게 유용한 정보를 제공해.";
    structureGuide = "배틀그라운드 패치노트를 3~7개의 불렛포인트로 핵심만 한국어로 요약해줘. 게이머들이 꼭 알아야 할 변경점 위주로 작성해.";
    hallucinationGuard = "[절대 엄수] 본문에 언급되지 않은 총기 출시, 가격 정보, 할인 이벤트, 인게임 수정을 임의로 지어내 쓰지 마.";
  }

  const prompt = `${systemContext}
제공된 원문을 읽고, 유저들이 반드시 알아야 할 가장 핵심적인 변화와 정보를 극도로 슬림하고 강렬하게 요약해줘.

${structureGuide}

${hallucinationGuard}

반드시 한국어로 작성하고, 가장 핵심적인 키워드만 **강조**해줘.

원문: ${rawText}`;

  // 1. Gemini 시도 (Pro -> Flash)
  if (geminiKey) {
    const genAI = new GoogleGenerativeAI(geminiKey);
    // 2026년 현재 v1beta에서 활성화된 최신 모델 리스트
    const geminiModels = ["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-2.5-flash"];

    for (const modelId of geminiModels) {
      try {
        const model = genAI.getGenerativeModel({ model: modelId });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.length > 20) {
          console.log(`Summary generated via Gemini (${modelId})`);
          return text.trim();
        }
      } catch (err: any) {
        console.warn(`Gemini ${modelId} failed:`, err.message || err);
      }
    }
  }

  // 2. Groq 시도 (Gemini 모두 실패 시)
  if (groqKey) {
    try {
      console.log("Attempting fallback with Groq (Llama 3.3)...");
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemContext },
            { role: "user", content: prompt }
          ],
          temperature: 0.5
        })
      });

      if (groqRes.ok) {
        const groqData = await groqRes.json();
        const text = groqData.choices?.[0]?.message?.content;
        if (text) {
          console.log("Summary generated via Groq (Llama 3.3)");
          return text.trim();
        }
      }
    } catch (err: any) {
      console.error("Groq fallback failed:", err.message || err);
    }
  }

  return "";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";
    const manualUrl = searchParams.get("url"); // 수동 입력 URL

    // 보안 인증 체크
    // - Authorization: Bearer <CRON_SECRET | ADMIN_SECRET_TOKEN> 만 허용한다.
    //   쿼리 파라미터(?secret=) 지원을 제거했다. URL 에 담긴 비밀값은 접근 로그와
    //   Referer 헤더에 남고, Discord 등 채팅으로 공유되면 그대로 유출된다.
    // - NODE_ENV 조건을 두지 않는다. Preview/개발 배포에서도 검증을 강제한다.
    if (!authorizeBearerSecret(request, ["CRON_SECRET", "ADMIN_SECRET_TOKEN"])) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let title = "";
    let postId = "";
    let fullUrl = "";
    let thumbnail = null;
    let date = new Date().toISOString().split("T")[0];

    if (manualUrl) {
      // 2A. 수동 URL 처리 로직
      console.log(">>> [MANUAL_MODE] URL:", manualUrl);
      fullUrl = manualUrl;
      const idMatch = manualUrl.match(/\/news\/(\d+)/);
      postId = idMatch ? idMatch[1] : `manual_${Date.now()}`;

      // 수동 모드에서는 제목을 가져오기 위해 먼저 페이지를 한 번 읽습니다.
      const res = await fetch(manualUrl, { headers: { "User-Agent": "Mozilla/5.0..." } });
      if (res.ok) {
        const html = await res.text();
        const root = parse(html);
        title = root.querySelector("title")?.text.split("|")[0].trim() || "직접 입력된 패치노트";
        // Nuxt 데이터에서 썸네일 탐색 시도
        const thumbMatch = html.match(/thumbUrl\s*:\s*"(https:[^"]+)"/i);
        thumbnail = thumbMatch ? thumbMatch[1].replace(/\\u002F/g, "/") : null;
      } else {
        title = "수동 게시물";
      }
    } else {
      // 2B. 자동 스크래핑 모드 (기존 로직)
      const targetUrl = "https://pubg.com/ko/news";
      const response = await fetch(targetUrl, {
        next: { revalidate: 0 },
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      });

      if (!response.ok) throw new Error("공식 홈페이지 뉴스를 가져오지 못했습니다.");
      const html = await response.text();

      // 1단계: "createdAt:\"YYYY-MM-DD" 패턴으로 모든 뉴스 객체의 시작 위치 파악 (청킹 기준점)
      const createdAtRegex = /createdAt:"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"/g;
      let match;
      const itemStarts: { date: string, index: number }[] = [];

      while ((match = createdAtRegex.exec(html)) !== null) {
        itemStarts.push({
          date: match[1],
          index: match.index
        });
      }

      const matches: { id: string, title: string, thumbnail: string | null, date: string, index: number }[] = [];

      // 2단계: 개별 청크 내에서 완벽히 격리된 안전 정보 추출
      for (let i = 0; i < itemStarts.length; i++) {
        const start = itemStarts[i].index;
        const end = (i + 1 < itemStarts.length) ? itemStarts[i + 1].index : html.length;
        const chunk = html.substring(start, end);

        const postIdMatch = chunk.match(/postId:(\d+)/);
        const titleMatch = chunk.match(/title:"([^"]+?)"/);
        const thumbMatch = chunk.match(/thumbUrl\s*:\s*"(https:[^"]+)"/i) || chunk.match(/imageUrl\s*:\s*"(https:[^"]+)"/i);

        if (postIdMatch && titleMatch) {
          matches.push({
            id: postIdMatch[1],
            title: titleMatch[1].replace(/\\u002F/g, "/").replace(/\\"/g, '"').normalize("NFC").trim(),
            thumbnail: thumbMatch ? thumbMatch[1].replace(/\\u002F/g, "/") : null,
            date: itemStarts[i].date.split(" ")[0],
            index: start
          });
        }
      }

      if (matches.length === 0) {
        // 정규식 파싱 실패와 "새 글 없음"은 구분해야 한다.
        // pubg.com 이 Nuxt 인라인 데이터 구조를 바꾸면 이 분기로 떨어지므로 조용히 성공 처리하면
        // 패치 당일 동기화가 멈춘 사실을 아무도 알 수 없다.
        const parseFailed = itemStarts.length === 0;
        console.error(
          `!!! [CRITICAL] 뉴스 목록 파싱 실패. createdAt 앵커 ${itemStarts.length}건, 추출 항목 0건`
        );

        await notifyDiscord(
          `🚨 **[패치노트 크롤링 파싱 실패]**\n` +
          `pubg.com 뉴스 목록에서 게시물을 하나도 추출하지 못했습니다. ` +
          `공식 페이지 구조가 변경되었을 가능성이 큽니다.\n\n` +
          `**createdAt 앵커:** ${itemStarts.length}건\n` +
          `**추출 항목:** 0건\n` +
          `**대상:** ${targetUrl}\n\n` +
          `🔧 관리자 페이지 [시스템/캐시] → [패치노트 데이터 수동 동기화] 에 ` +
          `기사 URL을 직접 입력하면 우회 동기화가 가능합니다.\n` +
          `${process.env.NEXT_PUBLIC_SITE_URL || ""}/admin/game-data\n\n@everyone`
        );

        return NextResponse.json({
          success: false,
          reason: parseFailed ? "list_parse_failed" : "no_items_extracted",
          anchors: itemStarts.length,
          message: "뉴스 목록 파싱에 실패했습니다. 디스코드로 제보했습니다.",
        }, { status: 502 });
      }

      const latest = matches[0];
      title = latest.title;
      postId = latest.id;
      fullUrl = `https://pubg.com/ko/news/${postId}`;
      thumbnail = latest.thumbnail;
      date = latest.date;
    }

    // 4. 중복 체크
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: lastSync } = await supabaseAdmin
      .from("sync_history")
      .select("last_url")
      .eq("type", "patch_notes")
      .single();

    if (!force && lastSync?.last_url === fullUrl) {
      return NextResponse.json({ message: "No new patch notes found" });
    }

    // 5. AI 요약 생성 (다중 모델 시도)
    let aiSummary = "";
    try {
      const detailRes = await fetch(fullUrl, { cache: 'no-store' });
      if (detailRes.ok) {
        const detailHtml = await detailRes.text();
        const detailRoot = parse(detailHtml);
        const contentArea = detailRoot.querySelector(".post-detail__content") ||
          detailRoot.querySelector(".news-detail__content") ||
          detailRoot.querySelector("article") ||
          detailRoot.querySelector(".news-detail__body");

        let rawText = contentArea ? contentArea.text.trim() : "";

        // [Deep Data Scraper] 만약 DOM 파싱으로 텍스트를 못 찾으면 Nuxt 데이터에서 직접 추출
        if (rawText.length < 100) {
          console.log("DOM text too short, searching Nuxt data...");
          const nuxtMatch = detailHtml.match(/content\s*:\s*"((?:\\.|[^"\\])*)"/);
          if (nuxtMatch) {
            rawText = nuxtMatch[1].replace(/\\u002F/g, "/").replace(/\\"/g, '"');
          }
        }

        // 🌟 og:image 정규식 추출 보완
        if (!thumbnail) {
          let ogImage = "";
          const ogImageMatch = detailHtml.match(/<meta[^>]*?property=["']og:image["'][^>]*?content=["']([^"']+)["']/i) ||
                               detailHtml.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?property=["']og:image["']/i);
          if (ogImageMatch && ogImageMatch[1]) {
            ogImage = ogImageMatch[1].replace(/\\u002F/g, '/');
          } else {
            const metaOg = detailRoot.querySelector("meta[property='og:image']")?.getAttribute("content");
            if (metaOg) ogImage = metaOg;
          }
          if (ogImage) {
            thumbnail = ogImage;
            console.log("🌟 Successfully extracted thumbnail from og:image meta tag:", thumbnail);
          }
        }

        if (rawText.length > 50) {
          const categoryType = identifyCategory(title, fullUrl);
          aiSummary = await generateAISummary(rawText.substring(0, 5000), categoryType);
        }

        // [최후의 보루] AI 요약이 완전히 실패했을 경우 (빈 내용이거나 너무 짧을 때)
        if (!aiSummary || aiSummary.length < 20) {
          console.error("!!! [CRITICAL] All AI models failed to summarize. Sending Discord Alert...");

          // 디스코드 제보 채널로 알람 발송
          // ADMIN_SECRET_TOKEN 을 메시지에 넣지 않는다. 웹훅 메시지는 채널 구성원 전체가 볼 수 있다.
          // 재동기화는 관리자 로그인이 필요한 게임 데이터 관리 페이지에서 수행한다.
          const adminSyncPage = `${process.env.NEXT_PUBLIC_SITE_URL || ""}/admin/game-data`;
          await notifyDiscord(
            `⚠️ **[AI 요약 실패 제보]**\n` +
            `새로운 패치노트를 요약하는 데 모든 AI 모델이 실패했습니다.\n\n` +
            `**제목:** ${title}\n**원문 링크:** ${fullUrl}\n\n` +
            `--- \n🔧 **재동기화 방법**\n` +
            `1. 관리자 페이지 접속: ${adminSyncPage}\n` +
            `2. [시스템/캐시] 탭 → [패치노트 데이터 수동 동기화]\n` +
            `3. 위 원문 링크를 입력하고 실행\n\n@everyone`
          );

          return NextResponse.json({
            success: false,
            reason: "ai_failed",
            message: "AI 요약에 실패하여 디코로 제보했습니다. 디코를 확인해주세요!"
          });
        }
      }
    } catch (err: any) {
      console.error("Content extraction or summary failed:", err.message || err);
    }

    if (!aiSummary) {
      aiSummary = "이번 패치는 세부 데이터가 특수하게 구성되어 요약 로봇이 내용을 읽지 못했습니다. 아래 '공식 패치노트 보러가기'를 클릭해 자세한 내용을 확인해 주세요!";
    }

    // 6. 예쁘고 세련된 Tailwind 기반의 반응형 디자인 구성 (Tailwind v4 준수)
    // AI 생성 HTML 도 DB 저장 전에 정화한다. 모델 응답에 태그가 섞여 들어올 수 있다.
    const formattedContent = sanitizeBoardHtml(minifyHtml(`
      <div class="patch-note-container space-y-4">
        <div class="bg-[#F2A900]/10 border border-[#F2A900]/30 rounded-lg p-4 mb-1">
          <h3 class="flex items-center gap-1.5 text-[#F2A900] font-black text-base md:text-lg">
            🤖 BGMS AI 패치노트 핵심 요약
          </h3>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${formatAiSummaryToHtml(aiSummary)}
        </div>

        <div class="flex flex-col items-center justify-center p-6 bg-[#1a1a1a] rounded-lg border border-white/5">
          <p class="text-gray-400 text-xs mb-3">더 자세한 내용은 공식 원문에서 확인하실 수 있습니다.</p>
          <a href="${fullUrl}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-6 py-2.5 bg-[#F2A900] text-black font-black text-sm rounded hover:bg-[#cc8b00] transition-all transform active:scale-95 shadow-md shadow-[#F2A900]/20">🔗 원문 보러가기</a>
        </div>
      </div>
    `));

    // 7. 디스코드 발송 (어드민 승인 대기 관제용 알림)
    const adminWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (adminWebhookUrl) {
      const embed = {
        title: `🆕 [배그 소식 수집 완료] ${title} (승인 대기 중)`,
        description: `BGMS AI가 패치노트/소식 요약을 완료하여 초안(draft) 상태로 등록했습니다.\n어드민 검증 페이지에서 확인 후 승인해 주세요.\n\n### 🤖 AI 핵심 요약\n${aiSummary}`,
        url: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/board?f=어드민+검증`,
        thumbnail: thumbnail ? { url: thumbnail } : undefined,
        color: 0xf2a900,
        footer: { text: "BGMS 통합 지도 관제 봇 | 업데이트 알리미" },
        timestamp: new Date().toISOString(),
      };

      await fetch(adminWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch(err => console.error("❌ Discord admin alert failed:", err.message));
    }

    // 8. DB 등록 (DB 레벨 중복 방지 및 유니코드 보정)
    const cleanTitle = title.normalize("NFC").trim();
    console.log(">>> [DB_SAVE_START] Title:", cleanTitle);

    // [중요] DB에 없는 updated_at, created_at 등을 제거하고 검증된 컬럼만 사용
    // 기존에 동일한 제목의 글이 있는지 확인
    const { data: existingPost } = await supabaseAdmin
      .from("posts")
      .select("id")
      .eq("title", cleanTitle)
      .maybeSingle();



    let dbResult;
    if (existingPost) {
      console.log(`📝 기존 배그 소식 글(ID: ${existingPost.id})이 발견되어 업데이트합니다.`);
      dbResult = await supabaseAdmin.from("posts").update({
        content: formattedContent,
        author: "BGMS 시스템",
        category: "배그 소식",
        image_url: thumbnail || null,
        user_id: null
      }).eq("id", existingPost.id);
    } else {
      console.log("📝 신규 배그 소식 글을 등록합니다. (초안 상태)");
      dbResult = await supabaseAdmin.from("posts").insert({
        title: cleanTitle,
        content: formattedContent,
        author: "BGMS 시스템",
        category: "배그 소식",
        is_notice: false,
        status: "draft",
        image_url: thumbnail || null,
        user_id: null
      });
    }

    const { error: postError } = dbResult;

    if (postError) {
      console.error(">>> [DB_SAVE_ERROR]:", postError.message);
      return NextResponse.json({ success: false, message: postError.message });
    }
    console.log(">>> [DB_SAVE_SUCCESS]");

    // 9. 동기화 상태 업데이트
    console.log(">>> [SYNC_HISTORY_START]");
    if (lastSync) {
      await supabaseAdmin.from("sync_history").update({ last_url: fullUrl, updated_at: new Date().toISOString() }).eq("type", "patch_notes");
    } else {
      await supabaseAdmin.from("sync_history").insert({ type: "patch_notes", last_url: fullUrl });
    }
    console.log(">>> [SYNC_HISTORY_SUCCESS]");

    return NextResponse.json({ success: true, post: { title: cleanTitle, fullUrl } });

  } catch (error: any) {
    console.error("Patch notes cron error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
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
      .filter(line => line.length > 2 && !/^[#\s]+$/.test(line))
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


