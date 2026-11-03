import { jsonSchema, type Schema } from "ai";

export type SquadAiRawOutput = {
  squadGrade: string | null;
  summary: string;
  strength: string;
  weakness: string;
  coaching: string;
  memberFeedbacks: Array<{ name: string; praise: string; fault: string; advice: string }>;
  overallOpinion: string;
};

// 등급은 계산된 값만 허용한다. 관측이 부족하면 null로 보류하고 모델이 임의 등급을 만들지 못하게 한다.
export function buildSquadOutputSchema(canonicalGrade: string | null): Schema<SquadAiRawOutput> {
  return jsonSchema<SquadAiRawOutput>({
    type: "object",
    properties: {
      squadGrade: {
        type: ["string", "null"],
        description: canonicalGrade ? `Must be exactly "${canonicalGrade}"` : "Must be null: overall grade is withheld for missing observations",
      },
      summary: { type: "string", description: "One-line tactical summary of this squad" },
      strength: { type: "string", description: "Key strength of squad collaboration" },
      weakness: { type: "string", description: "Major weakness of the squad that a measured fact supports. Empty string \"\" when no measured fact supports one. Never filler." },
      coaching: { type: "string", description: "Practical coaching advice that follows from a measured fact. Empty string \"\" when none does. Never filler." },
      memberFeedbacks: {
        type: "array",
        description: "Individual tactical feedback for each and every squad member in roleProfiles",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nickname of the squad member" },
            praise: { type: "string", description: "Positive point that cites one measured stat of this member (칭찬할 점)" },
            fault: { type: "string", description: "A weak point backed by a measured stat difference (못한 점). Empty string \"\" when no measured stat supports one. Never filler or a pass line." },
            advice: { type: "string", description: "A practice suggestion that follows from one measured fact (개인 피드백). Empty string \"\" when none does. No generic encouragement such as keep it up." },
          },
          required: ["name", "praise", "fault", "advice"],
        },
      },
      overallOpinion: { type: "string", description: "Overall coaching review and warning/encouragement addressed to the entire team (팀원 모두에게 한마디씩 총평)" },
    },
    required: ["squadGrade", "summary", "strength", "weakness", "coaching", "memberFeedbacks", "overallOpinion"],
  });
}
