export const LOL_LEGAL_ENGLISH = "BGMS isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties."
  + " Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.";
export const LOL_LEGAL_KOREAN = "BGMS는 Riot Games의 후원을 받지 않으며 Riot Games 또는 관련 자산을 제작·운영하는 사람들의 견해나 의견을 반영하지 않습니다."
  + " Riot Games 및 모든 관련 자산은 Riot Games, Inc.의 상표 또는 등록 상표입니다.";

export default function LolLegalNotice() {
  return <footer aria-label="Riot Games 법적 고지" className="mt-6 space-y-2 border-t border-zinc-800 pt-3 text-xs leading-relaxed text-zinc-400">
    <p lang="en">{LOL_LEGAL_ENGLISH}</p>
    <p>{LOL_LEGAL_KOREAN}</p>
  </footer>;
}
