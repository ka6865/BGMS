import { NextResponse } from "next/server";
import { withOptionalAuth } from "@/utils/supabase/guard";
import { extractClientIp, checkIpBlacklist } from "@/lib/board/ipUtils";
import { checkProfanity } from "@/lib/board/profanityFilter";
import { consumeBoardWriteQuota } from "@/lib/board/writeQuota.server";
import { verifyTurnstileToken } from "@/lib/board/turnstile.server";
import { TURNSTILE_ACTIONS } from "@/lib/board/turnstileContract";
import { canonicalizeManagedBoardImageUrl, isUuid } from "@/lib/board/imageStorageContract";
import { parseBoardImageSrcs } from "@/lib/board/imageHtml";
import { sanitizeBoardHtml } from "@/lib/board/sanitizeHtml";
import type { ClanInfo } from "@/types/board";
import bcrypt from "bcryptjs";

/**
 * @fileoverview 게시판 저장을 서버사이드에서 처리하는 API입니다.
 * 회원은 JWT 사용자 ID를, 비회원은 IP·Turnstile·비밀번호를 서버 신뢰 경계로 사용합니다.
 */

const ALLOWED_GUILD_ID = "1486899870928470121";
const TURNSTILE_TOKEN_MAX_LENGTH = 2048;
const TITLE_MAX_LENGTH = 50;
const CATEGORY_MAX_LENGTH = 50;
const GUEST_AUTHOR_MAX_LENGTH = 20;
const GUEST_PASSWORD_MIN_LENGTH = 4;
const GUEST_PASSWORD_MAX_LENGTH = 20;
const DISCORD_URL_MAX_LENGTH = 2048;
const IMAGE_URL_MAX_LENGTH = 2048;
const DISCORD_CHANNEL_ID_MAX_LENGTH = 64;
const USER_ID_MAX_LENGTH = 128;
const CLAN_INFO_MAX_SERIALIZED_LENGTH = 1024;
const CLAN_MEMBER_COUNT_MAX = 100;
const CLAN_INFO_KEYS = new Set<keyof ClanInfo>([
  "id",
  "name",
  "tag",
  "level",
  "memberCount",
]);

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value == null || (typeof value === "string" && value.length <= maxLength);
}

function isValidClanInfo(value: unknown): value is ClanInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== CLAN_INFO_KEYS.size
    || !keys.every((key) => CLAN_INFO_KEYS.has(key as keyof ClanInfo))
  ) {
    return false;
  }
  if (
    typeof record.id !== "string"
    || !record.id.trim()
    || typeof record.name !== "string"
    || typeof record.tag !== "string"
    || typeof record.level !== "number"
    || !Number.isFinite(record.level)
    || record.level < 0
    || typeof record.memberCount !== "number"
    || !Number.isFinite(record.memberCount)
    || record.memberCount < 0
    || record.memberCount > CLAN_MEMBER_COUNT_MAX
  ) {
    return false;
  }

  try {
    return JSON.stringify(record).length <= CLAN_INFO_MAX_SERIALIZED_LENGTH;
  } catch {
    return false;
  }
}

async function validateDiscordUrl(url: string): Promise<boolean> {
  if (!url) return true;

  try {
    const inviteMatch = url.match(/(?:discord\.gg\/|discord\.com\/invite\/)([a-zA-Z0-9-]+)/);
    if (inviteMatch) {
      const code = inviteMatch[1];
      const res = await fetch(`https://discord.com/api/v10/invites/${code}`);
      if (!res.ok) return false;
      const data = await res.json();
      return data.guild?.id === ALLOWED_GUILD_ID;
    }

    const channelMatch = url.match(/discord\.com\/channels\/(\d+)\/\d+/);
    if (channelMatch) {
      const guildId = channelMatch[1];
      return guildId === ALLOWED_GUILD_ID;
    }

    return false;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      const value: unknown = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
      }
      body = value as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
    }
    const {
      title,
      content,
      category,
      image_url,
      is_notice,
      author,
      user_id,
      password,
      editingPostId,
      discord_url,
      discord_channel_id,
      clan_info,
      turnstileToken,
    } = body;
    const expectedRevision: unknown = body.expectedRevision ?? null;
    const contentImageIds = body.contentImageIds ?? [];
    const thumbnailImageId = body.thumbnailImageId ?? null;

    if (
      typeof title !== "string"
      || !title.trim()
      || title.trim().length > TITLE_MAX_LENGTH
      || typeof content !== "string"
      || !content.trim()
      || typeof category !== "string"
      || !category.trim()
      || category.trim().length > CATEGORY_MAX_LENGTH
    ) {
      return NextResponse.json(
        { error: "필수 입력 데이터가 누락되었습니다." },
        { status: 400 }
      );
    }

    if (content.length > 300000) {
      return NextResponse.json(
        { error: "게시글 용량이 너무 큽니다. 불필요한 이미지 데이터를 제거해 주세요." },
        { status: 413 }
      );
    }
    const safeTitle = title.trim();
    // 사용자 입력 HTML 은 저장 전에 서버에서 정화한다.
    // 클라이언트 dompurify 는 브라우저 전용이라 SSR·API 경로를 보호하지 못한다.
    const safeContent = sanitizeBoardHtml(content.trim());
    const safeCategory = category.trim();
    if (
      discord_url != null
      && (typeof discord_url !== "string" || discord_url.length > DISCORD_URL_MAX_LENGTH)
    ) {
      return NextResponse.json({ error: "디스코드 링크가 올바르지 않습니다." }, { status: 400 });
    }
    if (!isOptionalBoundedString(image_url, IMAGE_URL_MAX_LENGTH)) {
      return NextResponse.json({ error: "이미지 URL이 올바르지 않습니다." }, { status: 400 });
    }
    if (!isOptionalBoundedString(discord_channel_id, DISCORD_CHANNEL_ID_MAX_LENGTH)) {
      return NextResponse.json({ error: "디스코드 채널 ID가 올바르지 않습니다." }, { status: 400 });
    }
    if (is_notice != null && typeof is_notice !== "boolean") {
      return NextResponse.json({ error: "공지 설정이 올바르지 않습니다." }, { status: 400 });
    }
    if (
      user_id != null
      && (
        typeof user_id !== "string"
        || !user_id.trim()
        || user_id.length > USER_ID_MAX_LENGTH
      )
    ) {
      return NextResponse.json({ error: "사용자 ID가 올바르지 않습니다." }, { status: 400 });
    }
    if (
      turnstileToken != null
      && (
        typeof turnstileToken !== "string"
        || !turnstileToken.trim()
        || turnstileToken.length > TURNSTILE_TOKEN_MAX_LENGTH
      )
    ) {
      return NextResponse.json({ error: "보안 인증 토큰이 올바르지 않습니다." }, { status: 400 });
    }
    if (clan_info != null && !isValidClanInfo(clan_info)) {
      return NextResponse.json({ error: "클랜 정보가 올바르지 않습니다." }, { status: 400 });
    }
    if (
      editingPostId != null
      && (
        typeof editingPostId !== "number"
        || !Number.isInteger(editingPostId)
        || editingPostId <= 0
      )
    ) {
      return NextResponse.json({ error: "수정할 게시글 ID가 올바르지 않습니다." }, { status: 400 });
    }
    if (
      (editingPostId != null && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      || (editingPostId == null && expectedRevision != null)
      || !isValidImageIds(contentImageIds)
      || (thumbnailImageId != null && !isUuid(thumbnailImageId))
    ) {
      return NextResponse.json({ error: "이미지 참조 또는 수정 버전이 올바르지 않습니다." }, { status: 400 });
    }
    const safeExpectedRevision = typeof expectedRevision === "number" ? expectedRevision : null;
    if (author != null && typeof author !== "string") {
      return NextResponse.json({ error: "작성자 정보가 올바르지 않습니다." }, { status: 400 });
    }
    if (
      password != null
      && (
        typeof password !== "string"
        || password.trim().length < GUEST_PASSWORD_MIN_LENGTH
        || password.length > GUEST_PASSWORD_MAX_LENGTH
      )
    ) {
      return NextResponse.json({ error: "비밀번호는 4~20자로 입력해주세요." }, { status: 400 });
    }
    if (
      typeof password === "string"
      && (
        typeof author !== "string"
        || !author.trim()
        || author.trim().length > GUEST_AUTHOR_MAX_LENGTH
      )
    ) {
      return NextResponse.json({ error: "닉네임은 20자 이하로 입력해주세요." }, { status: 400 });
    }
    const discordUrl = typeof discord_url === "string" ? discord_url : "";
    const guestPassword = typeof password === "string" ? password : "";
    const safeClanInfo = clan_info == null
      ? clan_info
      : {
          id: clan_info.id,
          name: clan_info.name,
          tag: clan_info.tag,
          level: clan_info.level,
          memberCount: clan_info.memberCount,
        };

    const auth = await withOptionalAuth();
    if (auth.error) return auth.error;
    const { user, supabaseAdmin } = auth;

    let isRequesterAdmin = false;
    let memberAuthor = "익명";

    if (user) {
      const { data: requesterProfile } = await supabaseAdmin
        .from("profiles")
        .select("role, nickname")
        .eq("id", user.id)
        .single();

      isRequesterAdmin = requesterProfile?.role === "admin";
      memberAuthor = typeof requesterProfile?.nickname === "string" && requesterProfile.nickname.trim()
        ? requesterProfile.nickname.trim()
        : "익명";

      if (user_id !== user.id && !isRequesterAdmin) {
        return NextResponse.json(
          { error: "인증된 사용자와 요청자가 일치하지 않습니다." },
          { status: 403 }
        );
      }
    } else {
      if (contentImageIds.length > 0 || thumbnailImageId !== null) {
        return NextResponse.json({ error: "비회원은 이미지 업로드를 사용할 수 없습니다." }, { status: 400 });
      }
      if (!editingPostId) {
        if (typeof author !== "string" || typeof password !== "string") {
          return NextResponse.json(
            { error: "닉네임과 비밀번호를 입력해 주세요." },
            { status: 400 }
          );
        }
        const token = typeof turnstileToken === "string" ? turnstileToken.trim() : "";
        if (!token || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
          return NextResponse.json(
            { error: "보안 인증 토큰이 올바르지 않습니다." },
            { status: 400 },
          );
        }
      }
    }

    if (editingPostId) {
      if (!user) {
        return NextResponse.json(
          { error: "비회원 게시글은 수정이 불가합니다. 삭제 후 재작성해 주세요." },
          { status: 401 }
        );
      }

      const preflight = await getEditPreflight({
        supabaseAdmin: supabaseAdmin as unknown as EditQueryAdmin,
        postId: editingPostId,
        actorUserId: user.id,
        isRequesterAdmin,
        expectedRevision: safeExpectedRevision,
      });
      if (preflight instanceof NextResponse) return preflight;

      const retainedImageIds = await getRetainedImageIds({
        supabaseAdmin: supabaseAdmin as unknown as EditQueryAdmin,
        postId: editingPostId,
        content: safeContent,
        imageUrl: typeof image_url === "string" ? image_url : null,
      });
      if (retainedImageIds instanceof NextResponse) return retainedImageIds;

      const mergedContentImageIds = mergeImageIds(contentImageIds, retainedImageIds.contentImageIds);
      if (mergedContentImageIds.length > 20) {
        return NextResponse.json({ error: "이미지 참조 또는 수정 버전이 올바르지 않습니다." }, { status: 400 });
      }

      if (safeCategory === "듀오/스쿼드 모집" && discordUrl) {
        const isValid = await validateDiscordUrl(discordUrl);
        if (!isValid) {
          return NextResponse.json(
            { error: "BGMS 공식 디스코드 서버의 초대 링크 또는 채널 링크만 등록할 수 있습니다." },
            { status: 400 },
          );
        }
      }

      return writePostWithImages({
        supabaseAdmin,
        postId: editingPostId,
        actorUserId: user.id,
        expectedRevision: safeExpectedRevision,
        title: safeTitle,
        content: safeContent,
        category: safeCategory,
        imageUrl: typeof image_url === "string" ? image_url : null,
        isNotice: isRequesterAdmin ? is_notice === true : false,
        author: memberAuthor,
        userId: user.id,
        passwordHash: null,
        ipAddress: null,
        discordUrl,
        discordChannelId: typeof discord_channel_id === "string" ? discord_channel_id : null,
        clanInfo: safeClanInfo,
        contentImageIds: mergedContentImageIds,
        thumbnailImageId: retainedImageIds.thumbnailImageId ?? thumbnailImageId,
      });
    } else {
      const finalAuthor = user ? memberAuthor : (author as string).trim();
      const finalUserId = user ? user.id : null;
      let passwordHash = null;
      const clientIp = extractClientIp(request);

      if (!user) {
        const isIpBlocked = await checkIpBlacklist(clientIp, supabaseAdmin);
        if (isIpBlocked) {
          return NextResponse.json(
            { error: "차단된 IP 대역에서는 글 작성이 불가합니다." },
            { status: 403 }
          );
        }
      }

      if (!user) {
        const turnstile = await verifyTurnstileToken({
          token: turnstileToken,
          remoteIp: clientIp,
          expectedAction: TURNSTILE_ACTIONS.post,
        });
        if (!turnstile.ok) {
          return NextResponse.json({ error: turnstile.error }, { status: turnstile.status });
        }
      }

      const quota = await consumeBoardWriteQuota({
        supabaseAdmin,
        scope: "post",
        actor: user?.id ?? clientIp,
      });
      if (!quota.ok) {
        return NextResponse.json({ error: quota.error }, { status: quota.status });
      }

      if (safeCategory === "듀오/스쿼드 모집" && discordUrl) {
        const isValid = await validateDiscordUrl(discordUrl);
        if (!isValid) {
          return NextResponse.json(
            { error: "BGMS 공식 디스코드 서버의 초대 링크 또는 채널 링크만 등록할 수 있습니다." },
            { status: 400 },
          );
        }
      }

      if (!user) {
        const titleProfanity = checkProfanity(safeTitle);
        const contentProfanity = checkProfanity(safeContent);
        if (titleProfanity.blocked || contentProfanity.blocked) {
          return NextResponse.json(
            { error: "제목 또는 본문에 비속어가 포함되어 있어 작성이 차단되었습니다." },
            { status: 400 }
          );
        }

        const salt = await bcrypt.genSalt(10);
        passwordHash = await bcrypt.hash(guestPassword, salt);
      }

      return writePostWithImages({
        supabaseAdmin,
        postId: null,
        actorUserId: user?.id ?? null,
        expectedRevision: null,
        title: safeTitle,
        content: safeContent,
        category: safeCategory,
        imageUrl: typeof image_url === "string" ? image_url : null,
        isNotice: isRequesterAdmin ? is_notice === true : false,
        author: finalAuthor,
        userId: finalUserId,
        passwordHash,
        ipAddress: clientIp,
        discordUrl,
        discordChannelId: typeof discord_channel_id === "string" ? discord_channel_id : null,
        clanInfo: safeClanInfo,
        contentImageIds: user ? contentImageIds : [],
        thumbnailImageId: user ? thumbnailImageId : null,
      });
    }

  } catch {
    return NextResponse.json(
      { error: "서버 내부 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

function isValidImageIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 20
    && value.every(isUuid)
    && new Set(value).size === value.length;
}

async function writePostWithImages(input: {
  supabaseAdmin: { rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
  postId: number | null;
  actorUserId: string | null;
  expectedRevision: number | null;
  title: string;
  content: string;
  category: string;
  imageUrl: string | null;
  isNotice: boolean;
  author: string;
  userId: string | null;
  passwordHash: string | null;
  ipAddress: string | null;
  discordUrl: string;
  discordChannelId: string | null;
  clanInfo: ClanInfo | null | undefined;
  contentImageIds: string[];
  thumbnailImageId: string | null;
}): Promise<NextResponse> {
  let result: { data: unknown; error: unknown };
  try {
    result = await input.supabaseAdmin.rpc("write_board_post_with_images", {
      p_post_id: input.postId,
      p_actor_user_id: input.actorUserId,
      p_expected_revision: input.expectedRevision,
      p_title: input.title,
      p_content: input.content,
      p_category: input.category,
      p_image_url: input.imageUrl,
      p_is_notice: input.isNotice,
      p_author: input.author,
      p_user_id: input.userId,
      p_password_hash: input.passwordHash,
      p_ip_address: input.ipAddress,
      p_discord_url: input.discordUrl,
      p_discord_channel_id: input.discordChannelId,
      p_clan_info: input.clanInfo ?? null,
      p_content_image_ids: input.contentImageIds,
      p_thumbnail_image_id: input.thumbnailImageId,
    });
  } catch {
    return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
  }
  if (result.error) {
    return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
  }
  const row = getWriteResult(result.data);
  if (!row) return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
  if (row.result_code === "ok") {
    return NextResponse.json({ success: true, data: { id: row.post_id, revision: row.revision } });
  }
  if (row.result_code === "revision_conflict") {
    return NextResponse.json({ error: "게시글이 다른 곳에서 수정되었습니다." }, { status: 409 });
  }
  if (row.result_code === "forbidden") {
    return NextResponse.json({ error: "게시글 수정 권한이 없습니다." }, { status: 403 });
  }
  if (row.result_code === "not_found") {
    return NextResponse.json({ error: "수정할 게시글을 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
}

type WriteResult =
  | { result_code: "ok" | "revision_conflict" | "forbidden"; post_id: number; revision: number }
  | { result_code: "not_found"; post_id: null; revision: null };

function getWriteResult(value: unknown): WriteResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (record.result_code === "not_found") {
    return record.post_id === null && record.revision === null
      ? { result_code: "not_found", post_id: null, revision: null }
      : null;
  }
  if (
    (record.result_code === "ok" || record.result_code === "revision_conflict" || record.result_code === "forbidden")
    && typeof record.post_id === "number"
    && Number.isSafeInteger(record.post_id)
    && typeof record.revision === "number"
    && Number.isSafeInteger(record.revision)
  ) return { result_code: record.result_code, post_id: record.post_id, revision: record.revision };
  return null;
}

type EditQueryResult = { data: unknown; error: unknown };
type EditQueryAdmin = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: number) => {
        maybeSingle?: () => PromiseLike<EditQueryResult>;
      } | PromiseLike<EditQueryResult>;
    };
  };
};

async function getEditPreflight(input: {
  supabaseAdmin: EditQueryAdmin;
  postId: number;
  actorUserId: string;
  isRequesterAdmin: boolean;
  expectedRevision: number | null;
}): Promise<NextResponse | null> {
  try {
    const query = input.supabaseAdmin.from("posts").select("user_id, revision").eq("id", input.postId);
    const result: EditQueryResult = "maybeSingle" in query && typeof query.maybeSingle === "function"
      ? await query.maybeSingle()
      : await (query as PromiseLike<EditQueryResult>);
    if (result.error) return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
    if (!isEditPost(result.data)) return result.data === null
      ? NextResponse.json({ error: "수정할 게시글을 찾을 수 없습니다." }, { status: 404 })
      : NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
    if (!input.isRequesterAdmin && result.data.user_id !== input.actorUserId) {
      return NextResponse.json({ error: "게시글 수정 권한이 없습니다." }, { status: 403 });
    }
    if (result.data.revision !== input.expectedRevision) {
      return NextResponse.json({ error: "게시글이 다른 곳에서 수정되었습니다." }, { status: 409 });
    }
    return null;
  } catch {
    return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
  }
}

function isEditPost(value: unknown): value is { user_id: string | null; revision: number } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (typeof (value as Record<string, unknown>).user_id === "string" || (value as Record<string, unknown>).user_id === null)
    && typeof (value as Record<string, unknown>).revision === "number"
    && Number.isSafeInteger((value as Record<string, unknown>).revision);
}

async function getRetainedImageIds(input: {
  supabaseAdmin: EditQueryAdmin;
  postId: number;
  content: string;
  imageUrl: string | null;
}): Promise<NextResponse | { contentImageIds: string[]; thumbnailImageId: string | null }> {
  try {
    const parsedContentImageSrcs = parseBoardImageSrcs(input.content);
    if (!parsedContentImageSrcs.ok) {
      return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
    }
    const result: EditQueryResult = await (input.supabaseAdmin.from("board_post_image_refs")
      .select("image_id, usage, board_image_objects(bucket_id, storage_key, status)")
      .eq("post_id", input.postId) as PromiseLike<EditQueryResult>);
    if (result.error || !Array.isArray(result.data)) {
      return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
    }
    const contentUrls = new Set(parsedContentImageSrcs.srcs.map(canonicalizeManagedBoardImageUrl).filter((url): url is string => url !== null));
    const contentImageIds: string[] = [];
    let thumbnailImageId: string | null = null;
    for (const row of result.data) {
      const ref = parseRetainedPostImageRef(row);
      if (!ref) return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
      if (ref.kind === "legacy") continue;
      const canonicalUrl = toBoardImagePublicUrl(ref.storageKey);
      if (contentUrls.has(canonicalUrl)) contentImageIds.push(ref.imageId);
      if (canonicalizeManagedBoardImageUrl(input.imageUrl ?? "") === canonicalUrl) thumbnailImageId = ref.imageId;
    }
    return { contentImageIds: [...new Set(contentImageIds)], thumbnailImageId };
  } catch {
    return NextResponse.json({ error: "게시글을 저장하지 못했습니다." }, { status: 503 });
  }
}

type RetainedPostImageRef =
  | { kind: "managed"; imageId: string; usage: "content" | "thumbnail"; storageKey: string }
  | { kind: "legacy" };

function parseRetainedPostImageRef(value: unknown): RetainedPostImageRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const image = row.board_image_objects;
  if (!image || typeof image !== "object" || Array.isArray(image)) return null;
  const object = image as Record<string, unknown>;
  if (typeof row.image_id !== "string" || !isUuid(row.image_id) || (row.usage !== "content" && row.usage !== "thumbnail")) {
    return null;
  }
  if (
    object.bucket_id === "board-images-v2"
    && object.storage_key === row.image_id
    && object.status === "ready"
  ) {
    return { kind: "managed", imageId: row.image_id, usage: row.usage, storageKey: object.storage_key };
  }
  if (
    object.bucket_id === "images"
    && typeof object.storage_key === "string"
    && object.storage_key.length > 0
    && object.status === "legacy_retained"
  ) {
    return { kind: "legacy" };
  }
  return null;
}

function mergeImageIds(clientImageIds: string[], retainedImageIds: string[]): string[] {
  return [...new Set([...retainedImageIds, ...clientImageIds])];
}

function toBoardImagePublicUrl(storageKey: string): string {
  const baseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://supabase.invalid").replace(/\/$/, "");
  return `${baseUrl}/storage/v1/object/public/board-images-v2/${encodeURIComponent(storageKey)}`;
}
