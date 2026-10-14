/**
 * Discord API에 슬래시 커맨드(/연동, /전적, /방금판)를 글로벌 등록하는 일회성 CLI 스크립트입니다.
 * 
 * 사용법:
 * DISCORD_APPLICATION_ID=xxx DISCORD_BOT_TOKEN=xxx npx tsx scripts/register_discord_commands.ts
 */

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const COMMANDS = [
  {
    name: "연동",
    description: "디스코드 계정과 배틀그라운드 닉네임을 연동하고 나에게만 결과를 표시합니다.",
    options: [
      {
        name: "nickname",
        description: "배틀그라운드 인게임 닉네임",
        type: 3, // STRING
        required: true,
      },
      {
        name: "platform",
        description: "플랫폼 (기본값: steam)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "Steam (스팀)", value: "steam" },
          { name: "Kakao (카카오)", value: "kakao" },
        ],
      },
    ],
  },
  {
    name: "전적",
    description: "저장된 시즌 전적 또는 최근 저장 경기 요약을 채널에 공개합니다.",
    options: [
      {
        name: "nickname",
        description: "조회할 닉네임 (미입력 시 연동된 계정 또는 서버 별명으로 자동 조회)",
        type: 3, // STRING
        required: false,
      },
      {
        name: "platform",
        description: "조회 플랫폼 (직접 지정 우선, 미입력 시 연동 플랫폼 또는 steam)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "Steam (스팀)", value: "steam" },
          { name: "Kakao (카카오)", value: "kakao" },
        ],
      },
    ],
  },
  {
    name: "방금판",
    description: "최신 저장 경기 1건의 성적과 교전 지표를 채널에 공개합니다.",
    options: [
      {
        name: "nickname",
        description: "조회할 닉네임 (미입력 시 연동된 계정 또는 서버 별명으로 자동 조회)",
        type: 3, // STRING
        required: false,
      },
      {
        name: "platform",
        description: "조회 플랫폼 (직접 지정 우선, 미입력 시 연동 플랫폼 또는 steam)",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "Steam (스팀)", value: "steam" },
          { name: "Kakao (카카오)", value: "kakao" },
        ],
      },
    ],
  },
];

async function registerCommands() {
  if (!APPLICATION_ID || !BOT_TOKEN) {
    console.error("오류: DISCORD_APPLICATION_ID 및 DISCORD_BOT_TOKEN 환경변수가 필요합니다.");
    process.exit(1);
  }

  const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

  console.log(`Discord 슬래시 커맨드 등록 시작 (App ID: ${APPLICATION_ID})...`);

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${BOT_TOKEN}`,
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`커맨드 등록 실패 (${response.status}):`, errorText);
    process.exit(1);
  }

  const result = await response.json();
  console.log(`총 ${Array.isArray(result) ? result.length : 0}개 슬래시 커맨드가 성공적으로 등록되었습니다.`);
}

registerCommands().catch((err) => {
  console.error("예기치 않은 오류:", err);
  process.exit(1);
});
