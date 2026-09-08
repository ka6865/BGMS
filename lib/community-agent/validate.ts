import { createHash } from "node:crypto";
import { sanitizeBoardHtml } from "@/lib/board/sanitizeHtml";
import { classifyWindow } from "./policy";
import type { Claim, Draft, Evidence, Validation } from "./types";

const MAX_TITLE_LENGTH = 120;
const MAX_PARAGRAPHS = 8;
const MAX_PARAGRAPH_LENGTH = 500;
const MAX_QUESTION_LENGTH = 200;
const MAX_EVIDENCE_IDS = 10;
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isAllowedEvidenceUrl(item: Evidence): boolean {
  try {
    const url = new URL(item.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    if (item.source === "dc") return host === "gall.dcinside.com";
    if (item.source === "naver") return host === "cafe.naver.com" && /^\/playbattlegrounds\/\d+\/?$/.test(url.pathname);
    if (item.source === "youtube") return (host === "youtube.com" || host === "www.youtube.com") && url.pathname === "/watch";
    return host === "pubg.com" || host.endsWith(".pubg.com") || host === "battlegrounds.com" || host.endsWith(".battlegrounds.com");
  } catch {
    return false;
  }
}

function isBounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= limit;
}

function hasPrivateOrUnsafeInstruction(value: string): boolean {
  return /(?:\b(?:\+?82[- ]?)?0?1[016789][ -]?\d{3,4}[ -]?\d{4}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|씨발|병신|개새끼|\bfuck\b|\bshit\b|<\/?script\b|process\.env|api[_ -]?key|system prompt|ignore (?:all |previous )?instructions?|이전\s*지시.*무시|무시.*지시|도구.*실행|터미널.*실행|(?:curl|wget|rm\s+-rf)\b)/i.test(value);
}

function hasOpinionPercentage(claim: Claim): boolean {
  return claim.kind === "observed_opinion"
    && /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*퍼센트)/.test(claim.text)
    && /(?:민심|이용자|유저|플레이어|반응|의견)/.test(claim.text);
}

function hasNumericGameStat(text: string): boolean {
  return /\d+(?:\.\d+)?/.test(text)
    && /(?:피해량|데미지|damage|연사|rpm|반동|recoil|탄속|발사\s*속도|장전\s*시간|탄창|dps)/i.test(text);
}

function hasOfficialEvidence(items: Evidence[]): boolean {
  return items.some((item) => item.official);
}

function hasCurrentEvidence(items: Evidence[], window: NonNullable<Claim["recentWindow"]>, now: Date): boolean {
  return items.some((item) => {
    const result = classifyWindow(item.publishedAt, now);
    return window === "24h" ? result === "24h" : result === "24h" || result === "7d";
  });
}

function safeRenderableDraft(draft: Draft, evidence: Evidence[]): Draft {
  const known = new Set(evidence.map((item) => item.id));
  const safe = new Set(evidence.filter(isAllowedEvidenceUrl).map((item) => item.id));
  return {
    ...draft,
    paragraphs: draft.paragraphs.map((paragraph) => ({
      ...paragraph,
      evidenceIds: paragraph.evidenceIds.filter((id) => known.has(id) && safe.has(id)),
    })),
  };
}

function contentHash(draft: Draft, evidence: Evidence[]): string {
  return renderDraft(safeRenderableDraft(draft, evidence), evidence.filter(isAllowedEvidenceUrl)).hash;
}

/** Check structure and evidence rules before a generated draft can be published. */
export function checkDraft(draft: Draft, evidence: Evidence[], now: Date): Validation {
  const reasons: string[] = [];
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const allText = [draft.title, draft.question, ...draft.paragraphs.map((paragraph) => paragraph.text)].join("\n");

  if (!isBounded(draft.title, MAX_TITLE_LENGTH)) reasons.push("invalid_title");
  if (!isBounded(draft.question, MAX_QUESTION_LENGTH)) reasons.push("invalid_question");
  if (!Array.isArray(draft.paragraphs) || draft.paragraphs.length === 0 || draft.paragraphs.length > MAX_PARAGRAPHS) {
    reasons.push("invalid_paragraph_count");
  }
  if (hasPrivateOrUnsafeInstruction(allText)) reasons.push("unsafe_content");

  for (const item of evidence) {
    if (!isAllowedEvidenceUrl(item)) reasons.push("unsafe_evidence_url");
  }

  for (const paragraph of draft.paragraphs) {
    if (!isBounded(paragraph.text, MAX_PARAGRAPH_LENGTH)) reasons.push("invalid_paragraph");
    if (!Array.isArray(paragraph.evidenceIds) || paragraph.evidenceIds.length > MAX_EVIDENCE_IDS) reasons.push("invalid_evidence_ids");
    if (new Set(paragraph.evidenceIds).size !== paragraph.evidenceIds.length) reasons.push("duplicate_evidence_ids");
    if (!(paragraph.kind === "official_fact" || paragraph.kind === "observed_opinion" || paragraph.kind === "suggestion")) reasons.push("invalid_claim_kind");
    if (!(paragraph.recentWindow === null || paragraph.recentWindow === "24h" || paragraph.recentWindow === "7d")) reasons.push("invalid_recent_window");

    const cited = paragraph.evidenceIds.flatMap((id) => evidenceById.get(id) ? [evidenceById.get(id)!] : []);
    if (paragraph.evidenceIds.some((id) => !evidenceById.has(id))) reasons.push("unknown_evidence");
    if ((paragraph.kind === "official_fact" || paragraph.kind === "observed_opinion") && cited.length === 0) reasons.push("claim_evidence_required");
    if ((paragraph.kind === "official_fact" || hasNumericGameStat(paragraph.text)) && !hasOfficialEvidence(cited)) {
      reasons.push("official_evidence_required");
    }
    if (paragraph.recentWindow !== null && !hasCurrentEvidence(cited, paragraph.recentWindow, now)) {
      reasons.push(cited.some((item) => classifyWindow(item.publishedAt, now) === "unknown")
        ? "unverified_recent_evidence" : "stale_recent_evidence");
    }
    if (paragraph.kind === "observed_opinion" && cited.length === 1
      && !/(?:한\s*(?:자료|출처|건)|단일\s*출처|개별\s*(?:질문|의견|반응))/.test(paragraph.text)) {
      reasons.push("single_source_opinion_unlabeled");
    }
    if (hasOpinionPercentage(paragraph)) reasons.push("unsupported_opinion_percentage");
  }

  return { passed: reasons.length === 0, reasons: unique(reasons), contentHash: contentHash(draft, evidence) };
}

/** Render only server-owned plain text and approved evidence links. */
export function renderDraft(draft: Draft, evidence: Evidence[]): { title: string; html: string; hash: string } {
  const paragraphs = draft.paragraphs.map((paragraph) => `<p>${escape(paragraph.text)}</p>`).join("");
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const ids = unique(draft.paragraphs.flatMap((paragraph) => paragraph.evidenceIds));
  const links = ids.map((id) => {
    const source = evidenceById.get(id);
    if (!source) throw new Error("unknown_evidence");
    if (!isAllowedEvidenceUrl(source)) throw new Error("unsafe_evidence_url");
    return `<li><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title)}</a></li>`;
  }).join("");
  const html = sanitizeBoardHtml(`${paragraphs}<p>${escape(draft.question)}</p><p>BGMS AI 비서가 확인한 자료를 바탕으로 작성했습니다.</p><ul>${links}</ul>`);
  return { title: draft.title, html, hash: createHash("sha256").update(`${draft.title}\n${html}`).digest("hex") };
}
