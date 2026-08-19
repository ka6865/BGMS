import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";

async function generate() {
  const envPath = path.join(process.cwd(), ".env.local");
  const envContent = fs.readFileSync(envPath, "utf-8");
  const apiKeyMatch = envContent.match(/GOOGLE_GEMINI_API_KEY=(.*)/);
  const apiKey = apiKeyMatch ? apiKeyMatch[1].replace(/["']/g, "").trim() : null;

  if (!apiKey) {
    console.error("API Key not found in .env.local");
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  
  const models = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash"];
  let model = null;
  
  for (const m of models) {
    try {
      const testModel = genAI.getGenerativeModel({ model: m });
      await testModel.generateContent("Ping");
      model = testModel;
      console.log(`✅ Selected working model: ${m}`);
      break;
    } catch (e) {
      console.warn(`⚠️ Model ${m} is not available, trying next fallback...`);
    }
  }

  if (!model) {
    console.error("❌ No working Gemini models found.");
    return;
  }

  // 100% 실제 Supabase DB에서 추출한 팩트 데이터
  const prompts = [
    {
      topic: "DB 매치 분석 기반 맵 선호도 및 딜량 괴물 랭커",
      data: "최근 누적 매치 스탯 데이터 수: 63,951건. 유저들이 플레이한 맵 순위: 1위 태고(Tiger_Main: 22,366건), 2위 사녹(Savage_Main: 14,916건), 3위 에란겔(Baltic_Main: 12,055건), 4위 론도(Neon_Main: 6,139건), 5위 미라마(Desert_Main: 5,214건). 전체 유저의 평균 스탯: 1.01킬, 평균 딜량: 155.3딜. 1등을 한 매치 중 역대 최고 딜량 1위 유저: 'ssr_kk'(사녹에서 4,003딜, 31킬로 1등), 2위 유저: 'yingyujiang'(사녹에서 3,644딜, 33킬로 1등)."
    },
    {
      topic: "AI 코칭 스타일(매운맛 vs 다정한맛) 선호도 통계",
      data: "우리 DB에 캐싱된 AI 코칭 생성 건수 분석 결과: 매운맛 코칭(spicy) 선택 건수 18건, 다정한 맛 코칭(mild) 선택 건수 4건. 한국 배그 유저들은 따뜻한 칭찬보다 뼈를 때리는 차가운 팩트 폭행(81.8% 비율)을 훨씬 더 많이 찾았음."
    },
    {
      topic: "PUBG API 연동 에러 통계 및 개발 비하인드",
      data: "최근 DB에 수집된 PUBG API 연동 에러 건수: 99건. 에러 유형 1위: 'Player CSMS_Salt not found in match participants' (69건 - 특정 매치 참여자 데이터 조회 시 유저 누락 예외), 2위: 'PUBG API Match Load Failed: 404' (23건 - 배그 API 서버 자체의 매치 정보 유실 에러). 배그 API 서버가 은근히 불안정하거나 누락된 판이 많다는 개발자의 애환을 담을 것."
    }
  ];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    console.log(`\n================== [100% 팩트 기반 글 초안 ${i + 1}: ${p.topic}] ==================`);
    const prompt = `배틀그라운드 커뮤니티(인벤, 디시, 펨코 등)에서 흔히 쓰이는 가볍고 재미있는 말투와 배그 밈(여포, 존버, 꼴박, 샷발, 배그 등)을 적극적으로 섞어서 인터넷 커뮤니티용 글을 작성해 줘.
다음 데이터를 바탕으로 실제 유저들이 생성한 흥미진진한 통계 리포트 글을 Markdown 포맷으로 작성해 줘. 데이터가 진짜 우리 사이트 유저들의 실제 통계 데이터인 만큼 신뢰감 있게 수치를 그대로 활용해 스토리텔링해 줘.
작성자 닉네임은 'BGMS_AI_BOT'으로 지정하고, 최종 결과물은 오직 본문 텍스트만 출력해야 하고, '제목:', '작성자:', '본문:' 구조를 명확히 지켜서 써 줘.

실제 데이터:
${p.data}`;

    try {
      const result = await model.generateContent(prompt);
      console.log(result.response.text());
    } catch (e) {
      console.error(`Error generating ${p.topic}:`, e.message);
    }
  }
}

generate();
