import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/adminGuard";

export async function POST() {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.error;

  const token = process.env.GITHUB_ACTIONS_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "GitHub Actions 실행 토큰이 설정되지 않았습니다." }, { status: 503 });
  }

  try {
    const response = await fetch("https://api.github.com/repos/ka6865/BGMS/actions/workflows/patch-notes-sync.yml/dispatches", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({ ref: "main" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });

    if (!response.ok) {
      return NextResponse.json({ error: "GitHub Actions 실행 요청에 실패했습니다. 토큰 권한과 워크플로 배포 상태를 확인해 주세요." }, { status: 502 });
    }

    return NextResponse.json({ success: true, message: "패치노트 동기화 실행을 요청했습니다. 완료 여부는 Actions 실행 내역에서 확인해 주세요." }, { status: 202 });
  } catch {
    return NextResponse.json({ error: "GitHub Actions 응답을 확인하지 못했습니다. 실행 내역을 확인한 뒤 다시 시도해 주세요." }, { status: 502 });
  }
}
