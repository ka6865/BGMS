"use client";

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "../lib/supabase";
import "react-quill-new/dist/quill.snow.css";
import imageCompression from "browser-image-compression";
import { toast } from "sonner";
import { ClanInfo } from "@/types/board";
import ConfirmModal from "@/components/common/ConfirmModal";
import { InlineIconLabel } from "@/components/common/InlineIconLabel";
import { classifyUploadedBoardImages, type UploadedBoardImage } from "@/lib/board-image-cleanup";

const ReactQuill = dynamic(() => import("react-quill-new"), {
  ssr: false,
}) as any;

const BOARD_CATEGORIES = ["배그 소식", "자유", "듀오/스쿼드 모집", "클랜홍보", "제보/문의"];
const IMAGE_CONFIG = {
  MAX_FILE_SIZE_MB: 20,
  COMPRESSION_MAX_SIZE_MB: 1.5,
  COMPRESSION_MAX_WIDTH_OR_HEIGHT: 1920,
} as const;

type BoardImageReservation = {
  imageId: string;
  bucketId: string;
  storageKey: string;
  token: string;
};

async function reserveBoardImage(file: File): Promise<BoardImageReservation> {
  const response = await fetch("/api/board/images/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mimeType: file.type, byteSize: file.size }),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isBoardImageReservation(payload)) {
    throw new Error("이미지 업로드를 준비하지 못했습니다.");
  }
  return payload;
}

async function completeBoardImage(imageId: string): Promise<UploadedBoardImage> {
  const response = await fetch("/api/board/images/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageId }),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isUploadedBoardImage(payload)) {
    throw new Error("이미지 업로드를 완료하지 못했습니다.");
  }
  return payload;
}

async function releaseBoardImages(imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const response = await fetch("/api/board/images/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageIds }),
  });
  if (!response.ok) throw new Error("이미지 정리를 요청하지 못했습니다.");
}

function isBoardImageReservation(value: unknown): value is BoardImageReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.imageId === "string"
    && typeof record.bucketId === "string"
    && typeof record.storageKey === "string"
    && typeof record.token === "string";
}

function isUploadedBoardImage(value: unknown): value is UploadedBoardImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.imageId === "string" && typeof record.publicUrl === "string";
}

const QuillGlobalStyles = (
  <style>{`
    .quill-wrapper .ql-toolbar {
      position: sticky;
      top: 0;
      z-index: 1000;
      background-color: #f3f4f6;
      border-top-left-radius: 4px;
      border-top-right-radius: 4px;
    }
    .quill-wrapper .ql-container {
      min-height: 240px;
      max-height: 40vh;
      overflow-y: auto;
      border-bottom-left-radius: 4px;
      border-bottom-right-radius: 4px;
      font-size: 15px;
      cursor: text;
    }
    .quill-wrapper .ql-editor {
      min-height: 240px;
    }
    .quill-wrapper .ql-editor.ql-blank::before {
      color: #adb5bd;
      font-style: normal;
    }
    /* 다크모드 하에서 ql-tooltip(링크 정보 레이어)이 보이지 않거나 깨지는 버그 수정 */
    .quill-wrapper .ql-tooltip {
      background-color: #252525 !important;
      color: #e5e5e5 !important;
      border: 1px solid #444 !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5) !important;
      border-radius: 4px !important;
      z-index: 2000 !important;
    }
    .quill-wrapper .ql-tooltip input[type=text] {
      background-color: #1a1a1a !important;
      color: #fff !important;
      border: 1px solid #333 !important;
      border-radius: 4px !important;
    }
    .quill-wrapper .ql-tooltip a {
      color: #F2A900 !important;
    }
  `}</style>
);

interface BoardWriteProps {
  newTitle: string;
  setNewTitle: (title: string) => void;
  newContent: string;
  setNewContent: (content: string) => void;
  newCategory: string;
  setNewCategory: (category: string) => void;
  newDiscordUrl: string; // 🌟 추가
  setNewDiscordUrl: (url: string) => void; // 🌟 추가
  newDiscordChannelId: string; // 🌟 추가
  setNewDiscordChannelId: (id: string) => void; // 🌟 추가
  newIsNotice: boolean;
  setNewIsNotice: (isNotice: boolean) => void;
  newClanInfo: ClanInfo | null; // 🌟 추가
  setNewClanInfo: (clanInfo: ClanInfo | null) => void; // 🌟 추가
  thumbnailUrl: string; // 🌟 썸네일 수동 등록 추가
  setThumbnailUrl: (url: string) => void; // 🌟 썸네일 수동 등록 추가
  handleSavePost: (images: { contentImageIds: string[]; thumbnailImageId: string | null }) => Promise<boolean>;
  setIsWriting: (isWriting: boolean) => void;
  isAdmin: boolean;
  isLoading: boolean;
  isMobile: boolean;
  isEditing?: boolean;
  // 🌟 비회원용 props 추가
  isGuest: boolean;
  guestNickname: string;
  setGuestNickname: (val: string) => void;
  guestPassword: string;
  setGuestPassword: (val: string) => void;
}

export default function BoardWrite({
  newTitle,
  setNewTitle,
  newContent,
  setNewContent,
  newCategory,
  setNewCategory,
  newDiscordUrl,
  setNewDiscordUrl,
  newDiscordChannelId,
  setNewDiscordChannelId,
  newIsNotice,
  setNewIsNotice,
  newClanInfo, // 🌟 추가
  setNewClanInfo, // 🌟 추가
  thumbnailUrl, // 🌟 썸네일 수동 등록 추가
  setThumbnailUrl, // 🌟 썸네일 수동 등록 추가
  handleSavePost,
  setIsWriting,
  isAdmin,
  isLoading,
  isMobile,
  isEditing,
  isGuest,
  guestNickname,
  setGuestNickname,
  guestPassword,
  setGuestPassword,
}: BoardWriteProps) {
  const quillRef = useRef<any>(null);
  const uploadedImagesRef = useRef<UploadedBoardImage[]>([]);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false); // 🌟 디스코드 방 생성 로딩 상태
  const [searchNickname, setSearchNickname] = useState(""); // 🌟 클랜 검색용 닉네임
  const [searchPlatform, setSearchPlatform] = useState("steam"); // 🌟 플랫폼
  const [isSearchingClan, setIsSearchingClan] = useState(false); // 🌟 로딩 상태

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 🌟 실시간 본문 내 첫 번째 이미지 자동 추출
  const autoExtractedImage = useMemo(() => {
    if (!newContent.includes("<img")) return "";
    const imgMatch = newContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    return imgMatch && imgMatch[1] ? imgMatch[1] : "";
  }, [newContent]);

  const handleThumbnailUploadClick = () => {
    if (isGuest) return;
    fileInputRef.current?.click();
  };

  const handleThumbnailFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const maxSize = IMAGE_CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxSize) {
      toast.warning(`대표 이미지 크기는 ${IMAGE_CONFIG.MAX_FILE_SIZE_MB}MB를 초과할 수 없습니다.`);
      return;
    }
    const toastId = toast.loading("대표 이미지를 업로드하고 있습니다...");
    try {
      const image = await uploadImage(file);
      if (image) {
        setThumbnailUrl(image.publicUrl);
        toast.success("대표 이미지가 업로드되었습니다.", { id: toastId });
      } else {
        toast.error("대표 이미지 업로드 실패", { id: toastId });
      }
    } catch {
      toast.error("대표 이미지 업로드 오류", { id: toastId });
    }
  };

  // 3단계 알럿 모달화 상태
  const [isDiscordModalOpen, setIsDiscordModalOpen] = useState(false);
  const [discordRoomType, setDiscordRoomType] = useState<"duo" | "squad" | null>(null);
  const [isResetStyleModalOpen, setIsResetStyleModalOpen] = useState(false);

  // 🌟 클랜 검색 API 연동 함수
  const handleSearchClan = async () => {
    if (!searchNickname.trim()) {
      toast.warning("배틀그라운드 닉네임을 입력해 주세요.");
      return;
    }
    setIsSearchingClan(true);
    const toastId = toast.loading("PUBG API에서 클랜 정보를 조회하는 중...");
    try {
      const res = await fetch(`/api/pubg/player?nickname=${encodeURIComponent(searchNickname.trim())}&platform=${searchPlatform}`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "플레이어 조회 실패");
      }
      const data = await res.json();
      if (!data.clan) {
        toast.error("가입된 클랜이 없는 플레이어입니다.", { id: toastId });
        setNewClanInfo(null);
      } else {
        setNewClanInfo({
          id: data.clan.id,
          name: data.clan.name,
          tag: data.clan.tag,
          level: data.clan.level,
          memberCount: data.clan.memberCount,
        });
        toast.success("클랜 정보를 성공적으로 조회하고 첨부했습니다!", { id: toastId });
      }
    } catch (err: any) {
      toast.error(err.message || "클랜 조회 중 오류가 발생했습니다.", { id: toastId });
    } finally {
      setIsSearchingClan(false);
    }
  };

  // 🌟 디스코드 음성 채널 자동 생성 함수 - 확인 모달 노출
  const createDiscordRoom = (type: "duo" | "squad") => {
    setDiscordRoomType(type);
    setIsDiscordModalOpen(true);
  };

  // 실제 디스코드 방 생성 로직 실행
  const executeCreateDiscordRoom = async () => {
    if (!discordRoomType || isCreatingRoom) return;
    setIsDiscordModalOpen(false);
    const type = discordRoomType;

    setIsCreatingRoom(true);
    const toastId = toast.loading(`${type.toUpperCase()} 채널 생성 중...`);

    // 닉네임 정보 (author) - 닉네임 표시되는 태그에서 추출 시도
    const authorElement = document.querySelector(".nickname-display");
    const author = authorElement?.textContent?.trim() || "익명";

    try {
      const res = await fetch("/api/discord/room/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, author }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "채널 생성 실패");

      // 성공 시 주소와 ID 저장
      setNewDiscordUrl(data.inviteUrl);
      setNewDiscordChannelId(data.channelId);

      toast.success(`${type.toUpperCase()} 채널이 생성되었습니다!`, { id: toastId });
    } catch (err: any) {
      toast.error(err.message || "채널 생성 중 오류가 발생했습니다.", { id: toastId });
    } finally {
      setIsCreatingRoom(false);
      setDiscordRoomType(null);
    }
  };

  const uploadImage = useCallback(async (file: File) => {
    try {
      const options = {
        maxSizeMB: IMAGE_CONFIG.COMPRESSION_MAX_SIZE_MB,
        maxWidthOrHeight: IMAGE_CONFIG.COMPRESSION_MAX_WIDTH_OR_HEIGHT,
        useWebWorker: true,
      };

      const compressedFile = await imageCompression(file, options);
      const reservation = await reserveBoardImage(compressedFile);
      const { error } = await supabase.storage
        .from(reservation.bucketId)
        .uploadToSignedUrl(reservation.storageKey, reservation.token, compressedFile, {
          contentType: compressedFile.type,
          cacheControl: "31536000",
          upsert: false,
        });
      if (error) throw new Error("이미지 업로드에 실패했습니다.");
      const completed = await completeBoardImage(reservation.imageId);
      const image = { imageId: completed.imageId, publicUrl: completed.publicUrl };
      uploadedImagesRef.current.push(image);
      return image;
    } catch {
      toast.error("이미지 업로드 중 오류가 발생했습니다.");
    }
  }, []);

  const imageHandler = useCallback(() => {
    if (isGuest) return;
    const existingInputs = document.querySelectorAll(".quill-image-input");
    existingInputs.forEach((el) => el.remove());

    const input = document.createElement("input");
    input.setAttribute("type", "file");
    input.setAttribute("accept", "image/*");
    input.setAttribute("id", "quill-image-upload"); // 🌟 ID 추가
    input.setAttribute("name", "quill-image");     // 🌟 Name 추가
    input.classList.add("quill-image-input");
    input.style.display = "none";
    input.style.position = "absolute";
    input.style.left = "-9999px";

    document.body.appendChild(input);
    input.click();

    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        if (document.body.contains(input)) document.body.removeChild(input);
        return;
      }

      const file = input.files[0];
      const maxSize = IMAGE_CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;

      if (file.size > maxSize) {
        toast.warning(`이미지 크기는 ${IMAGE_CONFIG.MAX_FILE_SIZE_MB}MB를 초과할 수 없습니다.`);
        if (document.body.contains(input)) document.body.removeChild(input);
        return;
      }

      const editor = quillRef.current.getEditor();
      const range = editor.getSelection(true) || { index: editor.getLength() };

      try {
        setIsUploadingImage(true);
        editor.enable(false);
        const image = await uploadImage(file);
        if (image) {
          editor.insertEmbed(range.index, "image", image.publicUrl);
          editor.setSelection(range.index + 1);
        } else {
          toast.error("이미지 업로드 실패");
        }
      } catch {
      } finally {
        editor.enable(true);
        setIsUploadingImage(false);
        if (document.body.contains(input)) document.body.removeChild(input);
      }
    };
  }, [isGuest, uploadImage]);

  const linkHandler = useCallback(() => {
    if (!quillRef.current) return;
    const editor = quillRef.current.getEditor();
    const range = editor.getSelection();

    if (range) {
      if (range.length === 0) {
        // 드래그한 텍스트가 없는 경우: 텍스트와 링크 주소를 모두 입력받아 삽입
        const text = prompt("링크로 표시할 텍스트를 입력하세요:");
        if (text === null || text.trim() === "") return;

        const url = prompt("링크 주소를 입력하세요 (예: https://example.com):", "https://");
        if (url === null || url.trim() === "") return;

        let targetUrl = url.trim();
        if (!/^https?:\/\//i.test(targetUrl) && !/^mailto:/i.test(targetUrl) && !/^tel:/i.test(targetUrl)) {
          targetUrl = "https://" + targetUrl;
        }

        editor.insertText(range.index, text, { link: targetUrl });
        editor.setSelection(range.index + text.length);
        toast.success("링크가 삽입되었습니다.");
      } else {
        // 드래그한 텍스트가 있는 경우: 기존 선택한 텍스트에 링크만 적용
        const [format] = editor.getFormat(range);
        const initialUrl = typeof format === 'object' && format.link ? format.link : "";

        const url = prompt("링크 주소를 입력하세요 (예: https://example.com):", initialUrl || "https://");
        if (url === null) return;

        if (url.trim() === "") {
          editor.format("link", false);
          toast.success("링크가 제거되었습니다.");
        } else {
          let targetUrl = url.trim();
          if (!/^https?:\/\//i.test(targetUrl) && !/^mailto:/i.test(targetUrl) && !/^tel:/i.test(targetUrl)) {
            targetUrl = "https://" + targetUrl;
          }
          editor.format("link", targetUrl);
          toast.success("링크가 삽입되었습니다.");
        }
      }
    } else {
      toast.warning("에디터를 먼저 선택해 주세요.");
    }
  }, []);

  const handleWrapperClick = useCallback(() => {
    if (quillRef.current) {
      const editor = quillRef.current.getEditor();
      if (!editor.hasFocus()) {
        editor.focus();
      }
    }
  }, []);

  // 🌟 [추가] 드래그 앤 드롭 이미지 업로드 핸들러
  useEffect(() => {
    if (!quillRef.current) return;
    const editor = quillRef.current.getEditor();
    const root = editor.root;

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      if (isGuest) return;
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith("image/")) {
          const maxSize = IMAGE_CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
          if (file.size > maxSize) {
            toast.warning(`이미지 크기는 ${IMAGE_CONFIG.MAX_FILE_SIZE_MB}MB를 초과할 수 없습니다.`);
            return;
          }

          const range = editor.getSelection(true) || { index: editor.getLength() };
          try {
            setIsUploadingImage(true);
            editor.enable(false);
            const image = await uploadImage(file);
            if (image) {
              editor.insertEmbed(range.index, "image", image.publicUrl);
              editor.setSelection(range.index + 1);
            }
          } finally {
            editor.enable(true);
            setIsUploadingImage(false);
          }
        }
      }
    };

    root.addEventListener("drop", handleDrop);
    return () => root.removeEventListener("drop", handleDrop);
  }, [isGuest, uploadImage]);

  const handleCancel = async () => {
    try {
      if (uploadedImagesRef.current.length > 0) {
        await releaseBoardImages(uploadedImagesRef.current.map((image) => image.imageId));
        uploadedImagesRef.current = [];
      }
    } catch {
      toast.error("업로드한 이미지 정리를 요청하지 못했습니다.");
    } finally {
      setIsWriting(false);
    }
  };

  const onSaveClick = async () => {
    // 🌟 이미 업로드 중이거나 저장 중이면 차단 (안전장치)
    if (isLoading || isUploadingImage) return;

    try {
      const imageClassification = classifyUploadedBoardImages(
        uploadedImagesRef.current,
        newContent,
        thumbnailUrl
      );
      if (!imageClassification.ok) {
        toast.error("본문 이미지 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }

      if (imageClassification.unusedImageIds.length > 0) {
        try {
          await releaseBoardImages(imageClassification.unusedImageIds);
          uploadedImagesRef.current = uploadedImagesRef.current.filter(
            (image) => !imageClassification.unusedImageIds.includes(image.imageId)
          );
        } catch {
          toast.error("미사용 이미지 정리를 요청하지 못했습니다.");
        }
      }

      // 🌟 [검증] 디스코드 링크 형식만 간단히 체크 (상세 검증은 서버 API에서 수행)
      if (newCategory === "듀오/스쿼드 모집" && newDiscordUrl) {
        const isDiscordUrl = /discord\.(gg|com)/.test(newDiscordUrl);
        if (!isDiscordUrl) {
          toast.error("올바른 디스코드 링크 형식이 아닙니다.");
          return;
        }
      }

      const contentImageIds = imageClassification.contentImageIds;
      const thumbnailImageId = uploadedImagesRef.current.find(
        (image) => image.publicUrl === thumbnailUrl,
      )?.imageId ?? null;
      const saved = await handleSavePost({ contentImageIds, thumbnailImageId });
      if (saved) {
        uploadedImagesRef.current = [];
      }
    } catch {
      toast.error("저장을 준비하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  // 🌟 [추가] 텍스트 스타일 전체 초기화 함수 - 모달 트리거
  const handleClearFormatting = () => {
    if (!quillRef.current) return;
    const editor = quillRef.current.getEditor();
    const length = editor.getLength();
    
    if (length <= 1) return; // 내용이 없을 때

    setIsResetStyleModalOpen(true);
  };

  // 실제 스타일 초기화 로직 실행
  const executeClearFormatting = () => {
    setIsResetStyleModalOpen(false);
    if (!quillRef.current) return;
    const editor = quillRef.current.getEditor();
    const length = editor.getLength();
    
    const range = { index: 0, length: length };
    // 1. Quill의 기본 서식 제거
    editor.removeFormat(range.index, range.length);
    
    // 2. 인라인 스타일(배경색 등)이 남아있을 수 있으므로 강제 세척 처리
    const cleanContent = newContent.replace(/style="[^"]*"/g, (match) => {
      // 이미지 태그의 인라인 스타일은 유지 (크기 등 때문)
      if (match.includes("max-width") || match.includes("display:block")) return match;
      return "";
    });
    setNewContent(cleanContent);
    
    toast.success("스타일이 초기화되었습니다.");
  };

  const modules = useMemo(() => ({
    toolbar: {
      container: [
        [{ header: [1, 2, false] }],
        ["bold", "italic", "underline", "strike", "blockquote"],
        [{ list: "ordered" }, { list: "bullet" }],
        ["link", ...(isGuest ? [] : ["image"])],
        ["clean"],
      ],
      handlers: { 
        image: imageHandler,
        link: linkHandler
      },
    },
    // 🌟 [안전] 클립보드 붙여넣기 시 Base64 이미지 자동 필터링 및 스타일 클리닝
    clipboard: {
      matchers: [
        ["IMG", (node: any, delta: any) => {
          const src = node.getAttribute("src");
          if (src && src.startsWith("data:image")) {
            // Base64 이미지는 용량 문제로 차단하고 사용자에게 안내
            toast.warning("이미지 직접 붙여넣기는 서버 부하 방지를 위해 제한됩니다. 상단 업로드 버튼이나 드래그 앤 드롭을 이용해 주세요.", {
              duration: 5000,
              description: "고화질 이미지는 DB 저장 시 글이 잘릴 원인이 됩니다."
            });
            return { ops: [] }; 
          }
          return delta;
        }],
        [1, (node: HTMLElement, delta: any) => {
          // 외부에서 복사된 배경색(특히 흰색 배경) 및 스타일 제거
          delta.ops.forEach((op: any) => {
            if (op.attributes) {
              // 배경색 무조건 제거
              if (op.attributes.background) delete op.attributes.background;
              
              // 글자색이 검은색 계열이거나 너무 어두우면 제거하여 기본 밝은색이 나오게 함
              if (op.attributes.color) {
                const color = op.attributes.color.toLowerCase();
                if (color === "black" || color === "#000000" || color === "#000" || color.startsWith("rgb(0,0,0)")) {
                  delete op.attributes.color;
                }
              }
            }
          });
          return delta;
        }]
      ]
    }
  }), [imageHandler, isGuest, linkHandler]);

  return (
    <div
      style={{
        backgroundColor: "#1a1a1a",
        padding: isMobile ? "12px" : "20px",
        borderRadius: "8px",
        border: "1px solid #333",
      }}
    >
      {QuillGlobalStyles}
      <h2 style={{ marginBottom: "12px", color: "#F2A900", fontSize: "18px", fontWeight: "bold" }}>
        {isEditing ? "게시글 수정" : "새 게시글 작성"}
      </h2>

      {isGuest && !isEditing && (
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: "10px", marginBottom: "10px" }}>
          <input
            id="post-guest-nickname"
            name="guest_nickname"
            type="text"
            placeholder="닉네임"
            value={guestNickname}
            onChange={(e) => setGuestNickname(e.target.value)}
            style={{ flex: 1, padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "14px", outline: "none" }}
          />
          <input
            id="post-guest-password"
            name="guest_password"
            type="password"
            placeholder="비밀번호"
            value={guestPassword}
            onChange={(e) => setGuestPassword(e.target.value)}
            style={{ flex: 1, padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "14px", outline: "none" }}
          />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: "10px", marginBottom: "10px" }}>
        <select
          id="post-category"
          name="category"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          style={{ padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px" }}
        >
          {BOARD_CATEGORIES.filter((c) => isAdmin || c !== "패치노트").map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          id="post-title"
          name="title"
          type="text"
          placeholder="제목을 입력하세요 (최대 50자)"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          maxLength={50}
          style={{ flex: 1, padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "15px" }}
        />
        <button
          type="button"
          onClick={handleClearFormatting}
          style={{ padding: "0 15px", backgroundColor: "#333", color: "#F2A900", border: "1px solid #F2A900", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", cursor: "pointer", transition: "all 0.2s" }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#F2A900", e.currentTarget.style.color = "black")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#333", e.currentTarget.style.color = "#F2A900")}
        >
          스타일 초기화
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "15px", padding: "12px", backgroundColor: "#252525", border: "1px solid #333", borderRadius: "4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#F2A900", fontWeight: "bold", fontSize: "14px" }}>
            <InlineIconLabel icon="image">대표 이미지 (썸네일) 설정</InlineIconLabel>
          </span>
        </div>
        
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          {/* 업로드된 파일 입력용 hidden input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleThumbnailFileChange}
            accept="image/*"
            disabled={isGuest || isUploadingImage}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={handleThumbnailUploadClick}
            disabled={isGuest || isUploadingImage}
            style={{ padding: "8px 12px", backgroundColor: "#333", color: "#F2A900", border: "1px solid #F2A900", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}
          >
            이미지 업로드
          </button>
          
          <input
            type="text"
            placeholder="직접 이미지 URL 주소를 입력할 수도 있습니다."
            value={thumbnailUrl}
            onChange={(e) => setThumbnailUrl(e.target.value)}
            style={{ flex: 1, minWidth: "200px", padding: "8px 10px", backgroundColor: "#1a1a1a", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "12px" }}
          />

          {thumbnailUrl && (
            <button
              type="button"
              onClick={() => setThumbnailUrl("")}
              style={{ padding: "8px 12px", backgroundColor: "#551a1a", color: "#ff4444", border: "1px solid #ff4444", borderRadius: "4px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" }}
            >
              수동 지정 해제
            </button>
          )}
        </div>

        {/* 썸네일 미리보기 영역 */}
        {(thumbnailUrl || autoExtractedImage) ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "5px", padding: "8px", backgroundColor: "#1a1a1a", borderRadius: "4px" }}>
            <img 
              src={thumbnailUrl || autoExtractedImage} 
              alt="대표 썸네일 미리보기" 
              style={{ width: "80px", height: "60px", objectFit: "cover", borderRadius: "4px", border: "1px solid #333" }} 
            />
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "12px", fontWeight: "bold", color: thumbnailUrl ? "#43b581" : "#F2A900" }}>
                {thumbnailUrl ? (
                  <InlineIconLabel icon="check">수동 지정된 대표 이미지 사용 중</InlineIconLabel>
                ) : (
                  <InlineIconLabel icon="sparkles">본문 내 첫 번째 이미지 자동 추출 중</InlineIconLabel>
                )}
              </span>
              <span style={{ fontSize: "10px", color: "#888", wordBreak: "break-all" }}>
                {thumbnailUrl || autoExtractedImage}
              </span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: "12px", color: "#888", padding: "4px" }}>
            * 대표 이미지가 지정되지 않았습니다. 본문에 이미지를 삽입하면 자동으로 첫 번째 이미지가 대표 썸네일로 사용됩니다.
          </div>
        )}
      </div>

      {newCategory === "듀오/스쿼드 모집" && (
        <div style={{ marginBottom: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ color: "#7289da", fontWeight: "bold", fontSize: "14px" }}>
              <InlineIconLabel icon="bot">디스코드 채널 링크</InlineIconLabel>
            </span>
            <div 
              style={{ 
                position: "relative", 
                cursor: "help",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "#444",
                color: "#ddd",
                fontSize: "12px"
              }}
              className="group"
            >
              ?
              <div className="invisible group-hover:visible absolute left-[25px] top-0 w-[300px] p-4 bg-[#333] text-white text-[12px] rounded-lg shadow-2xl border border-[#444] z-[3000] leading-relaxed">
                <p style={{ fontWeight: "bold", color: "#F2A900", marginBottom: "8px", fontSize: "13px" }}>
                  <InlineIconLabel icon="link">디스코드 채널 링크 넣는 법</InlineIconLabel>
                </p>
                <div style={{ marginBottom: "10px" }}>
                  <strong style={{ color: "#7289da" }}>방식 A. 초대 링크 (추천)</strong><br/>
                  1. 보이스 채널 우클릭 - [초대하기]<br/>
                  2. [링크 편집] - 만료 기간 [무제한] 설정<br/>
                  3. 생성된 주소(discord.gg/...) 복사
                </div>
                <div>
                  <strong style={{ color: "#7289da" }}>방식 B. 채널 링크</strong><br/>
                  1. 보이스 채널 우클릭 - [링크 복사]<br/>
                  2. 주소창의 링크 그대로 붙여넣기
                </div>
                <p style={{ marginTop: "10px", color: "#ff4444", fontSize: "11px", borderTop: "1px solid #444", paddingTop: "8px" }}>
                  * 다른 디스코드 서버 링크는 자동으로 차단됩니다.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => createDiscordRoom("duo")}
                disabled={isCreatingRoom}
                className="flex-1 py-[8px] bg-[#5865F2] hover:bg-[#4752C4] text-white rounded font-bold text-[12px] transition-colors flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <InlineIconLabel
                  icon={isCreatingRoom ? "loader" : "battle"}
                  iconClassName={isCreatingRoom ? "animate-spin" : ""}
                >
                  {isCreatingRoom ? "생성 중..." : "듀오 방 자동 생성 (2인)"}
                </InlineIconLabel>
              </button>
              <button
                type="button"
                onClick={() => createDiscordRoom("squad")}
                disabled={isCreatingRoom}
                className="flex-1 py-[8px] bg-[#5865F2] hover:bg-[#4752C4] text-white rounded font-bold text-[12px] transition-colors flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <InlineIconLabel
                  icon={isCreatingRoom ? "loader" : "team"}
                  iconClassName={isCreatingRoom ? "animate-spin" : ""}
                >
                  {isCreatingRoom ? "생성 중..." : "스쿼드 방 자동 생성 (4인)"}
                </InlineIconLabel>
              </button>
            </div>

            <div className="relative">
              <input
                id="post-discord-url"
                name="discord_url"
                type="text"
                placeholder="자동 생성 버튼을 누르거나 직접 링크를 입력하세요."
                value={newDiscordUrl}
                onChange={(e) => {
                  const val = e.target.value;
                  setNewDiscordUrl(val);
                  // 직접 입력 시에는 채널 ID 초기화 (자동 삭제 대상 제외)
                  if (newDiscordChannelId) {
                    setNewDiscordChannelId("");
                  }
                }}
                className={`w-full p-2 bg-[#252525] text-white border rounded text-[14px] outline-none transition-colors ${
                  newDiscordChannelId ? "border-[#43b581] border-2" : "border-[#333] focus:border-[#5865F2]"
                }`}
              />
              {newDiscordChannelId && (
                <div className="mt-1 text-[11px] text-[#43b581] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  전용 채널이 생성되었습니다. (종료 시 자동 삭제됨)
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {newCategory === "클랜홍보" && (
        <div style={{ marginBottom: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ color: "#F2A900", fontWeight: "bold", fontSize: "14px" }}>
              <InlineIconLabel icon="award">PUBG 클랜 정보 첨부</InlineIconLabel>
            </span>
            <div 
              style={{ 
                position: "relative", 
                cursor: "help",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "18px",
                height: "18px",
                borderRadius: "50%",
                backgroundColor: "#444",
                color: "#ddd",
                fontSize: "12px"
              }}
              className="group"
            >
              ?
              <div className="invisible group-hover:visible absolute left-[25px] top-0 w-[300px] p-4 bg-[#333] text-white text-[12px] rounded-lg shadow-2xl border border-[#444] z-[3000] leading-relaxed">
                <p style={{ fontWeight: "bold", color: "#F2A900", marginBottom: "8px", fontSize: "13px" }}>
                  <InlineIconLabel icon="shield">클랜 정보 첨부하는 법</InlineIconLabel>
                </p>
                <div>
                  1. 클랜원 또는 클랜 마스터 본인의 배틀그라운드 인게임 닉네임을 입력합니다.<br/>
                  2. 계정이 존재하는 플랫폼(Steam/Kakao 등)을 선택한 뒤 [클랜 조회]를 클릭합니다.<br/>
                  3. 검색된 클랜 정보가 있으면 게시글에 자동으로 첨부됩니다.
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <select
                value={searchPlatform}
                onChange={(e) => setSearchPlatform(e.target.value)}
                style={{ padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "14px" }}
              >
                <option value="steam">Steam</option>
                <option value="kakao">Kakao</option>
                <option value="xbox">Xbox</option>
                <option value="psn">PlayStation</option>
              </select>
              <input
                type="text"
                placeholder="클랜 소속 유저 닉네임을 입력해 주세요."
                value={searchNickname}
                onChange={(e) => setSearchNickname(e.target.value)}
                style={{ flex: 1, padding: "8px 10px", backgroundColor: "#252525", color: "white", border: "1px solid #333", borderRadius: "4px", fontSize: "14px" }}
              />
              <button
                type="button"
                onClick={handleSearchClan}
                disabled={isSearchingClan}
                style={{ padding: "0 15px", backgroundColor: "#F2A900", color: "black", border: "none", borderRadius: "4px", fontSize: "14px", fontWeight: "bold", cursor: "pointer" }}
              >
                {isSearchingClan ? "조회 중..." : "클랜 조회"}
              </button>
            </div>

            {newClanInfo ? (
              <div 
                style={{ 
                  display: "flex", 
                  justifyContent: "space-between", 
                  alignItems: "center", 
                  padding: "12px 15px", 
                  backgroundColor: "#252525", 
                  border: "1px solid #F2A900", 
                  borderRadius: "4px" 
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <span style={{ 
                    padding: "2px 8px", 
                    backgroundColor: "#F2A900", 
                    color: "black", 
                    fontSize: "12px", 
                    fontWeight: "bold", 
                    borderRadius: "4px" 
                  }}>
                    [{newClanInfo.tag}]
                  </span>
                  <span style={{ color: "white", fontWeight: "bold", fontSize: "14px" }}>
                    {newClanInfo.name}
                  </span>
                  <span style={{ color: "#aaa", fontSize: "12px" }}>
                    Lv. {newClanInfo.level}
                  </span>
                  <span style={{ color: "#888", fontSize: "12px" }}>
                    멤버: {newClanInfo.memberCount}명
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setNewClanInfo(null)}
                  style={{ 
                    backgroundColor: "transparent", 
                    color: "#ff4444", 
                    border: "none", 
                    fontSize: "12px", 
                    fontWeight: "bold", 
                    cursor: "pointer" 
                  }}
                >
                  첨부 취소
                </button>
              </div>
            ) : (
              <div style={{ color: "#888", fontSize: "12px", padding: "4px" }}>
                * 첨부된 클랜 정보가 없습니다. 닉네임 조회를 통해 클랜을 첨부해 주세요.
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className="quill-wrapper"
        style={{ marginBottom: "12px", backgroundColor: "#252525", color: "#e5e5e5", borderRadius: "4px", position: "relative", border: "1px solid #333" }}
        onClick={handleWrapperClick}
      >
        {isUploadingImage && (
          <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(255,255,255,0.8)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px", fontWeight: "bold", color: "#F2A900", borderRadius: "4px" }}>
            이미지를 서버에 업로드 중입니다...
          </div>
        )}
        <ReactQuill
          ref={quillRef}
          theme="snow"
          value={newContent}
          onChange={setNewContent}
          modules={modules}
          placeholder="생존자님의 소중한 정보를 공유해 주세요! (이미지는 드래그 혹은 아이콘 클릭으로 첨부 가능)"
        />
      </div>

      {isAdmin && (
        <label style={{ display: "flex", gap: "8px", marginBottom: "12px", color: "#F2A900" }}>
          <input 
            id="post-notice-check"
            name="is_notice"
            type="checkbox" 
            checked={newIsNotice} 
            onChange={(e) => setNewIsNotice(e.target.checked)} 
          /> 공지사항
        </label>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
        <button
          onClick={handleCancel}
          disabled={isLoading || isUploadingImage}
          style={{ padding: "10px 20px", backgroundColor: (isLoading || isUploadingImage) ? "#222" : "#333", color: (isLoading || isUploadingImage) ? "#666" : "#ccc", borderRadius: "4px", border: "none" }}
        >
          취소
        </button>
        <button
          onClick={onSaveClick}
          disabled={isLoading || isUploadingImage}
          style={{ padding: "10px 30px", backgroundColor: "#F2A900", color: "black", fontWeight: "bold", borderRadius: "4px", border: "none" }}
        >
          {isLoading ? "처리 중..." : isEditing ? "수정하기" : "등록하기"}
        </button>
      </div>

      {/* 디스코드 방 생성 확인 모달 */}
      <ConfirmModal
        isOpen={isDiscordModalOpen}
        title="디스코드 보이스 채널 생성"
        description={`${discordRoomType === "duo" ? "2인 듀오" : "4인 스쿼드"} 전용 보이스 채널을 생성하시겠습니까?\n\n* 사람이 모두 나가면 봇이 자동으로 삭제합니다.`}
        confirmText="생성"
        cancelText="취소"
        type="info"
        onConfirm={executeCreateDiscordRoom}
        onCancel={() => {
          setIsDiscordModalOpen(false);
          setDiscordRoomType(null);
        }}
      />

      {/* 스타일 초기화 확인 모달 */}
      <ConfirmModal
        isOpen={isResetStyleModalOpen}
        title="스타일 초기화"
        description="글의 모든 스타일(배경색, 글자색 등)을 초기화하시겠습니까? (이미지는 유지됩니다)"
        confirmText="초기화"
        cancelText="취소"
        type="warning"
        onConfirm={executeClearFormatting}
        onCancel={() => setIsResetStyleModalOpen(false)}
      />

    </div>
  );
}
