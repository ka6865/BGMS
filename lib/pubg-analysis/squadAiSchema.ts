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
            praise: { type: "string", description: "Empty string \"\": the server writes praise from canonical measured shares" },
            fault: { type: "string", description: "Empty string \"\": the server writes fault from canonical individual records. Share, rank or team-lowest values never count." },
            advice: { type: "string", description: "Empty string \"\": the server writes advice from canonical individual records. Never ask to raise a damage, kill or assist share." },
          },
          required: ["name", "praise", "fault", "advice"],
        },
      },
      overallOpinion: { type: "string", description: "Overall coaching review and warning/encouragement addressed to the entire team (팀원 모두에게 한마디씩 총평)" },
    },
    required: ["squadGrade", "summary", "strength", "weakness", "coaching", "memberFeedbacks", "overallOpinion"],
  });
}

// 잘린 응답은 jsonrepair가 유효한 JSON으로 닫아 버리므로, 저장 전에 필수 칸이 모두 있는지 확인한다.
export function isCompleteSquadOutput(value: unknown): value is SquadAiRawOutput {
  if (!value || typeof value !== "object") return false;
  const output = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string";
  return (output.squadGrade === null || text(output.squadGrade))
    && ["summary", "strength", "weakness", "coaching", "overallOpinion"].every(key => text(output[key]))
    && Array.isArray(output.memberFeedbacks) && output.memberFeedbacks.length > 0
    && output.memberFeedbacks.every(member => member && typeof member === "object"
      && ["name", "praise", "fault", "advice"].every(key => text((member as Record<string, unknown>)[key])));
}
