import { fetchSourceJson, SourceHttpError } from "../http";
import { evidence, failure, report, type SourceDeps } from "../sources";
import type { Evidence, SourceReport } from "../types";

const API_ORIGIN = "https://www.googleapis.com";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type YoutubeVideo = { id: string; title: string; description: string; publishedAt: string | null };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown): unknown[] {
  const row = object(value);
  return Array.isArray(row?.items) ? row.items : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function channelFrom(value: unknown): { id: string; uploads: string } | null {
  const first = object(list(value)[0]);
  const id = string(first?.id);
  const uploads = string((object(object(first?.contentDetails)?.relatedPlaylists) ?? {}).uploads);
  return id && uploads ? { id, uploads } : null;
}

function videosFrom(value: unknown, now: Date): YoutubeVideo[] {
  return list(value).flatMap((entry) => {
    const snippet = object(object(entry)?.snippet);
    const resource = object(snippet?.resourceId);
    const id = string(resource?.videoId);
    const title = string(snippet?.title);
    const publishedAt = string(snippet?.publishedAt);
    const timestamp = publishedAt === null ? Number.NaN : Date.parse(publishedAt);
    if (!id || !title || !Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > SEVEN_DAYS_MS) return [];
    return [{ id, title, description: string(snippet?.description) ?? "", publishedAt: new Date(timestamp).toISOString() }];
  }).slice(0, 3);
}

function commentsFrom(value: unknown, video: YoutubeVideo, now: Date): Evidence[] {
  return list(value).flatMap((entry) => {
    const top = object(object(entry)?.snippet);
    const snippet = object(top?.topLevelComment);
    const commentSnippet = object(snippet?.snippet);
    const id = string(snippet?.id);
    const text = string(commentSnippet?.textDisplay) ?? string(commentSnippet?.textOriginal);
    const publishedAt = string(commentSnippet?.publishedAt);
    if (!id || !text) return [];
    const parsed = publishedAt === null ? Number.NaN : Date.parse(publishedAt);
    return [evidence("youtube", id, `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}&lc=${encodeURIComponent(id)}`,
      `영상 댓글: ${video.title}`, text, Number.isFinite(parsed) ? new Date(parsed).toISOString() : null, now, "comment", false)];
  }).slice(0, 30);
}

async function commentEvidence(video: YoutubeVideo, key: string, deps: SourceDeps): Promise<{ items: Evidence[]; disabled: boolean; error: string | null }> {
  try {
    const url = new URL("/youtube/v3/commentThreads", API_ORIGIN);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("videoId", video.id);
    url.searchParams.set("maxResults", "30");
    url.searchParams.set("order", "time");
    url.searchParams.set("textFormat", "plainText");
    url.searchParams.set("key", key);
    return { items: commentsFrom(await fetchSourceJson(url, {}, deps), video, deps.now), disabled: false, error: null };
  } catch (error) {
    if (error instanceof SourceHttpError && error.status === 403 && error.providerReason === "commentsDisabled") {
      return { items: [], disabled: true, error: null };
    }
    const reason = error instanceof SourceHttpError && error.providerReason
      ? `youtube_${error.providerReason}`
      : error instanceof Error ? error.message : "source_request_failed";
    return { items: [], disabled: false, error: reason };
  }
}

async function atMostTwo<T, R>(values: T[], work: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) output.push(await work(values[next++]));
  }
  await Promise.all(Array.from({ length: Math.min(2, values.length) }, () => worker()));
  return output;
}

export async function collectYoutube(deps: SourceDeps): Promise<SourceReport> {
  const key = deps.env.YOUTUBE_DATA_API_KEY;
  if (!key) return report("youtube", "needs_setup", [], "youtube_data_api_key_missing", 0);
  try {
    const channelUrl = new URL("/youtube/v3/channels", API_ORIGIN);
    channelUrl.searchParams.set("part", "contentDetails");
    channelUrl.searchParams.set("key", key);
    if (deps.channel) channelUrl.searchParams.set("id", deps.channel.id);
    else channelUrl.searchParams.set("forHandle", "PUBG_KR");
    const channel = channelFrom(await fetchSourceJson(channelUrl, {}, deps));
    if (!channel) return report("youtube", "failed", [], "youtube_channel_not_found", 0);

    const playlistUrl = new URL("/youtube/v3/playlistItems", API_ORIGIN);
    playlistUrl.searchParams.set("part", "snippet");
    playlistUrl.searchParams.set("playlistId", channel.uploads);
    playlistUrl.searchParams.set("maxResults", "3");
    playlistUrl.searchParams.set("key", key);
    const videos = videosFrom(await fetchSourceJson(playlistUrl, {}, deps), deps.now);
    const descriptionItems = videos.map((video) => evidence("youtube", video.id,
      `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`, video.title,
      video.description || null, video.publishedAt, deps.now, "description", true));
    if (videos.length === 0) return report("youtube", "empty", [], "youtube_no_recent_videos", 0, channel);
    const results = await atMostTwo(videos, (video) => commentEvidence(video, key, deps));
    const comments = results.flatMap((result) => result.items);
    const disabled = results.some((result) => result.disabled);
    const requestError = results.find((result) => result.error && !result.disabled)?.error ?? null;
    const reason = requestError ?? (disabled ? "youtube_comments_disabled" : null);
    const items = [...descriptionItems, ...comments];
    return report("youtube", reason ? "partial" : "ok", items, reason, items.length, channel);
  } catch (error) {
    return failure("youtube", error);
  }
}
