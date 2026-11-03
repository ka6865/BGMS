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
      weakness: { type: "string", description: "Major vulnerability/weakness of the squad" },
      coaching: { type: "string", description: "Practical coaching advice to improve squad synergy" },
      memberFeedbacks: {
        type: "array",
        description: "Individual tactical feedback for each and every squad member in roleProfiles",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nickname of the squad member" },
            praise: { type: "string", description: "Detailed positive actions, strengths or what they did well (칭찬할 점)" },
            fault: { type: "string", description: "Detailed vulnerabilities, mistakes, or what they did poorly (못한 점)" },
            advice: { type: "string", description: "Detailed improvement points and tactical advice (피드백)" },
          },
          required: ["name", "praise", "fault", "advice"],
        },
      },
      overallOpinion: { type: "string", description: "Overall coaching review and warning/encouragement addressed to the entire team (팀원 모두에게 한마디씩 총평)" },
    },
    required: ["squadGrade", "summary", "strength", "weakness", "coaching", "memberFeedbacks", "overallOpinion"],
  });
}
