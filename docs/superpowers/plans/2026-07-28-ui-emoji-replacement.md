# UI Emoji Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user-visible emoji across BGMS UI with SVG/lucide React icons and consistent inline icon components.

**Architecture:** Add a small common icon layer in `components/common` and use it from screen components. React-rendered UI uses lucide components through `BgmsIcon` and `InlineIconLabel`; string-rendered HTML and Leaflet `divIcon` use sanitized inline SVG helpers or emoji-free labels.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, lucide-react 0.562.0, Leaflet.

## Global Constraints

- 모든 설명과 계획서는 반드시 한국어로 작성한다.
- 코드 구현은 Next 16 & React 19 최신 문법 기반으로 작성한다.
- Tailwind v4 스타일링 기반으로 디자인을 미려하게 구현한다.
- `console.log`, 사용되지 않는 임포트, 주석 처리된 코드는 발견 즉시 삭제한다.
- 서버 로그, 개발 스크립트 로그, 주석처럼 사용자 화면에 직접 노출되지 않는 이모지는 이번 작업의 필수 범위에서 제외한다.
- 사용자 화면, 관리자 화면, 토스트, 동적 HTML 문자열, Open Graph 이미지는 이번 작업 범위에 포함한다.
- 새 의존성은 추가하지 않는다. 기존 `lucide-react`와 프로젝트 SVG만 사용한다.

---

## File Structure

- Create: `components/common/BgmsIcon.tsx`
  - 의미 기반 아이콘 이름을 lucide React 컴포넌트로 매핑한다.
  - `BgmsIconName` 타입을 export해서 호출부와 선언부 동기화를 보장한다.
- Create: `components/common/InlineIconLabel.tsx`
  - 아이콘과 텍스트를 한 줄 라벨로 렌더링한다.
  - 버튼, 탭, 카드 제목, 배지에서 반복되는 `inline-flex items-center gap-*` 패턴을 통일한다.
- Create: `lib/ui/icon-svg.ts`
  - React가 아닌 문자열 HTML 환경에서 사용할 작은 SVG 문자열 헬퍼를 제공한다.
  - Leaflet `divIcon` 및 AI 요약 HTML 문자열에서 텍스트 이모지를 대체한다.
- Modify: `components/common/*`, `components/Sidebar.tsx`, `components/ads/AdSenseBanner.tsx`
  - 공통 화면과 토스트의 이모지를 아이콘 컴포넌트로 교체한다.
- Modify: `components/board/*`, `components/BoardWrite.tsx`
  - 게시판 공지, 작성 폼, 동적 AI 요약 HTML의 이모지를 교체한다.
- Modify: `components/stat/*`, `app/stats/battle/BattleClient.tsx`
  - 전적/AI 요약/스쿼드/매치 카드의 이모지를 교체한다.
- Modify: `components/map/*`, `components/map/telemetry/*`
  - 지도 안내문, 리포트 폼, 킬피드, 텔레메트리 UI와 Leaflet 마커의 이모지를 교체한다.
- Modify: `components/admin/GameDataEditor.tsx`, `app/admin/**/*.tsx`
  - 관리자 탭, 상태 배지, 위험 버튼, 대시보드 라벨의 이모지를 교체한다.
- Modify: `app/rankings/*`, `app/weapons/*`, `app/crates/*`, `app/backpack/*`, `app/**/opengraph-image.tsx`, `app/api/og/**/*.tsx`
  - 공개 화면과 OG 이미지의 이모지를 교체한다.

---

### Task 1: Common Icon Foundation

**Files:**
- Create: `components/common/BgmsIcon.tsx`
- Create: `components/common/InlineIconLabel.tsx`
- Create: `lib/ui/icon-svg.ts`
- Test: `npm run verify:core`

**Interfaces:**
- Produces: `type BgmsIconName = "activity" | "admin" | "alert" | "award" | "backpack" | "battle" | "board" | "bot" | "box" | "check" | "chevronDown" | "chevronUp" | "clock" | "crosshair" | "database" | "delete" | "download" | "error" | "eye" | "file" | "flame" | "image" | "info" | "link" | "loader" | "map" | "mapPin" | "message" | "package" | "plane" | "rank" | "refresh" | "save" | "search" | "shield" | "skull" | "sparkles" | "star" | "team" | "tool" | "vehicle" | "weapon" | "x" | "zap"`
- Produces: `function BgmsIcon(props: BgmsIconProps): JSX.Element`
- Produces: `function InlineIconLabel(props: InlineIconLabelProps): JSX.Element`
- Produces: `function svgIcon(name: SvgIconName, options?: SvgIconOptions): string`

- [ ] **Step 1: Create `BgmsIcon.tsx`**

```tsx
"use client";

import {
  Activity,
  AlertTriangle,
  Award,
  Bot,
  Box,
  Briefcase,
  Car,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Database,
  Download,
  Eye,
  FileText,
  Flame,
  Hammer,
  Image,
  Info,
  Link,
  Loader2,
  Map,
  MapPin,
  MessageSquare,
  Package,
  Plane,
  RefreshCw,
  Save,
  Search,
  Shield,
  Skull,
  Sparkles,
  Star,
  Swords,
  Target,
  Trash2,
  Trophy,
  Users,
  Wrench,
  X,
  XCircle,
  Zap,
  type LucideIcon
} from "lucide-react";

export type BgmsIconName =
  | "activity" | "admin" | "alert" | "award" | "backpack" | "battle" | "board"
  | "bot" | "box" | "check" | "chevronDown" | "chevronUp" | "clock" | "crosshair"
  | "database" | "delete" | "download" | "error" | "eye" | "file" | "flame"
  | "image" | "info" | "link" | "loader" | "map" | "mapPin" | "message"
  | "package" | "plane" | "rank" | "refresh" | "save" | "search" | "shield"
  | "skull" | "sparkles" | "star" | "team" | "tool" | "vehicle" | "weapon"
  | "x" | "zap";

const ICONS: Record<BgmsIconName, LucideIcon> = {
  activity: Activity,
  admin: Hammer,
  alert: AlertTriangle,
  award: Award,
  backpack: Briefcase,
  battle: Swords,
  board: MessageSquare,
  bot: Bot,
  box: Box,
  check: CheckCircle2,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  clock: Clock,
  crosshair: Crosshair,
  database: Database,
  delete: Trash2,
  download: Download,
  error: XCircle,
  eye: Eye,
  file: FileText,
  flame: Flame,
  image: Image,
  info: Info,
  link: Link,
  loader: Loader2,
  map: Map,
  mapPin: MapPin,
  message: MessageSquare,
  package: Package,
  plane: Plane,
  rank: Trophy,
  refresh: RefreshCw,
  save: Save,
  search: Search,
  shield: Shield,
  skull: Skull,
  sparkles: Sparkles,
  star: Star,
  team: Users,
  tool: Wrench,
  vehicle: Car,
  weapon: Target,
  x: X,
  zap: Zap
};

export interface BgmsIconProps {
  name: BgmsIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
}

export function BgmsIcon({ name, size = 16, strokeWidth = 2.4, className, "aria-hidden": ariaHidden = true }: BgmsIconProps) {
  const Icon = ICONS[name];
  return <Icon aria-hidden={ariaHidden} className={className} size={size} strokeWidth={strokeWidth} />;
}
```

- [ ] **Step 2: Create `InlineIconLabel.tsx`**

```tsx
import { type ReactNode } from "react";
import { BgmsIcon, type BgmsIconName } from "@/components/common/BgmsIcon";

interface InlineIconLabelProps {
  icon: BgmsIconName;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  iconSize?: number;
}

export function InlineIconLabel({ icon, children, className = "", iconClassName = "", iconSize = 16 }: InlineIconLabelProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <BgmsIcon name={icon} size={iconSize} className={`shrink-0 ${iconClassName}`} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
```

- [ ] **Step 3: Create `lib/ui/icon-svg.ts`**

```ts
export type SvgIconName = "alert" | "check" | "error" | "flame" | "info" | "map" | "pin" | "skull" | "target" | "vehicle" | "weapon" | "zap";

interface SvgIconOptions {
  className?: string;
  color?: string;
  size?: number;
}

const PATHS: Record<SvgIconName, string> = {
  alert: '<path d="M12 9v4m0 4h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
  flame: '<path d="M8.5 14.5A4.5 4.5 0 0 0 13 19a4.5 4.5 0 0 0 4.5-4.5c0-2.9-1.6-4.8-3.2-6.4-.4 1.8-1.4 2.8-2.7 3.7.2-2.2-.5-4.1-2.3-5.8C9 8.4 7 10.5 7 13c0 .5.1 1 .3 1.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.8 5.6 4.4 6.9V21h7.2v-4.1A7.9 7.9 0 0 0 20 10a8 8 0 0 0-8-8Z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9 15h6"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  vehicle: '<path d="M5 17h14l-1.5-5h-11L5 17Z"/><path d="M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/><path d="M7 12l2-5h6l2 5"/>',
  weapon: '<path d="M14 6 3 17"/><path d="m5 19-2-2 3-3 2 2-3 3Z"/><path d="M14 6h7v4h-3l-2 3-4-4 2-3Z"/>',
  zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>'
};

export function svgIcon(name: SvgIconName, options: SvgIconOptions = {}) {
  const size = options.size ?? 14;
  const color = options.color ?? "currentColor";
  const className = options.className ? ` class="${options.className}"` : "";
  return `<svg${className} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
```

- [ ] **Step 4: Run verification**

Run: `npm run verify:core`
Expected: PASS. If TypeScript reports an unused import, remove it immediately.

- [ ] **Step 5: Commit**

```bash
git add components/common/BgmsIcon.tsx components/common/InlineIconLabel.tsx lib/ui/icon-svg.ts
git commit -m "feat: add BGMS icon primitives"
```

---

### Task 2: Public Shell, Board, Rankings, Weapons, Crates, Backpack

**Files:**
- Modify: `components/Sidebar.tsx`
- Modify: `components/ads/AdSenseBanner.tsx`
- Modify: `components/common/GlobalHeader.tsx`
- Modify: `components/board/PostItem.tsx`
- Modify: `components/BoardWrite.tsx`
- Modify: `components/board/BoardWriteClient.tsx`
- Modify: `app/rankings/RankingsClient.tsx`
- Modify: `app/weapons/WeaponsClient.tsx`
- Modify: `app/crates/CratesClient.tsx`
- Modify: `app/crates/CrateModals.tsx`
- Modify: `app/crates/CrateCards.tsx`
- Modify: `app/backpack/BackpackClient.tsx`

**Interfaces:**
- Consumes: `InlineIconLabel({ icon: BgmsIconName, children })`
- Consumes: `BgmsIcon({ name: BgmsIconName })`
- Consumes: `svgIcon(name: SvgIconName, options?: SvgIconOptions): string`

- [ ] **Step 1: Replace simple React text emoji**

Use this pattern:

```tsx
import { InlineIconLabel } from "@/components/common/InlineIconLabel";

<InlineIconLabel icon="image" iconClassName="text-[#F2A900]">
  대표 이미지 (썸네일) 설정
</InlineIconLabel>
```

Map files as follows:

```ts
const replacements = {
  "👀": "eye",
  "🖼️": "image",
  "📢": "message",
  "✅": "check",
  "❌": "error",
  "✨": "sparkles",
  "👾": "bot",
  "🔗": "link",
  "🎮": "battle",
  "🎖️": "award",
  "🛡️": "shield",
  "🥇": "rank",
  "🥈": "award",
  "🥉": "award",
  "📭": "message",
  "📝": "file",
  "🔧": "tool",
  "🔫": "weapon",
  "⚠️": "alert",
  "💎": "award",
  "⚡": "zap",
  "🛠️": "tool",
  "📋": "file",
  "💸": "package",
  "🎒": "backpack",
  "🚗": "vehicle"
} as const;
```

- [ ] **Step 2: Replace ranking medal emoji data**

In `app/rankings/RankingsClient.tsx`, change `topThreeStyles` from `emoji` string to `icon` name:

```ts
const topThreeStyles = {
  1: { icon: "rank", color: "text-yellow-400", glow: "shadow-[0_0_20px_rgba(250,204,21,0.3)]" },
  2: { icon: "award", color: "text-gray-300", glow: "shadow-[0_0_16px_rgba(209,213,219,0.2)]" },
  3: { icon: "award", color: "text-orange-400", glow: "shadow-[0_0_16px_rgba(251,146,60,0.2)]" }
} satisfies Record<1 | 2 | 3, { icon: BgmsIconName; color: string; glow: string }>;
```

Render with:

```tsx
<BgmsIcon name={style.icon} className={style.color} size={28} />
```

- [ ] **Step 3: Replace dynamic board HTML emoji**

In `components/board/BoardWriteClient.tsx`, import `svgIcon` and replace emoji prefix strings:

```ts
import { svgIcon } from "@/lib/ui/icon-svg";

const htmlIcon = svgIcon("info", { className: "inline-block mr-2 align-[-2px]", color: "#F2A900", size: 15 });
```

Change generated headings from:

```ts
🤖 BGMS AI 배그 소식 핵심 요약
```

to:

```ts
<span class="inline-flex items-center gap-2">${svgIcon("zap", { color: "#F2A900", size: 16 })}<span>BGMS AI 배그 소식 핵심 요약</span></span>
```

- [ ] **Step 4: Remove emoji from loading/success/error button strings**

Change strings like:

```tsx
{isSaving ? "⏳ 저장 중..." : "💾 은신처 상점 모든 변경사항 저장하기"}
```

to:

```tsx
<InlineIconLabel icon={isSaving ? "loader" : "save"} iconClassName={isSaving ? "animate-spin" : ""}>
  {isSaving ? "저장 중..." : "은신처 상점 모든 변경사항 저장하기"}
</InlineIconLabel>
```

- [ ] **Step 5: Run focused static search**

Run:

```bash
rg -n --pcre2 "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" components/Sidebar.tsx components/ads/AdSenseBanner.tsx components/common/GlobalHeader.tsx components/board components/BoardWrite.tsx app/rankings/RankingsClient.tsx app/weapons/WeaponsClient.tsx app/crates app/backpack -g '*.tsx'
```

Expected: no user-visible emoji matches. Matches inside comments are acceptable only if the comment is not adjacent to edited code; otherwise remove the comment per project rule.

- [ ] **Step 6: Run verification**

Run: `npm run verify:core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/Sidebar.tsx components/ads/AdSenseBanner.tsx components/common/GlobalHeader.tsx components/board components/BoardWrite.tsx app/rankings/RankingsClient.tsx app/weapons/WeaponsClient.tsx app/crates app/backpack
git commit -m "refactor: replace public UI emoji with icons"
```

---

### Task 3: Stats and Battle UI

**Files:**
- Modify: `components/stat/StatSearch.tsx`
- Modify: `components/stat/RecentAISummary.tsx`
- Modify: `components/stat/MatchCard.tsx`
- Modify: `components/stat/SquadAnalysisPanel.tsx`
- Modify: `components/stat/MapKingCard.tsx`
- Modify: `components/stat/SpiderChart.tsx`
- Modify: `components/stat/MatchTimeline.tsx`
- Modify: `components/stat/MiniStatWidget.tsx`
- Modify: `app/stats/battle/BattleClient.tsx`

**Interfaces:**
- Consumes: `BgmsIconName`
- Consumes: `BgmsIcon`
- Consumes: `InlineIconLabel`

- [ ] **Step 1: Convert stats headings and CTA strings**

Replace visible labels using `InlineIconLabel`:

```tsx
<InlineIconLabel icon="activity">AI 전적 검색</InlineIconLabel>
<InlineIconLabel icon="weapon">무기 마스터리 분석</InlineIconLabel>
<InlineIconLabel icon="battle">최근 매치 <span className="text-xs text-white/40 font-bold">(최대 20게임)</span></InlineIconLabel>
<InlineIconLabel icon="shield">제재 상태 확인</InlineIconLabel>
```

- [ ] **Step 2: Replace AI summary tone and tier emoji**

In `components/stat/RecentAISummary.tsx`, replace tone labels:

```tsx
<InlineIconLabel icon="shield" iconClassName="text-green-400">착한맛 승</InlineIconLabel>
<InlineIconLabel icon="zap" iconClassName="text-red-400">매운맛 승</InlineIconLabel>
<InlineIconLabel icon="team" iconClassName="text-yellow-400">무승부</InlineIconLabel>
```

Replace tier icon ternary with a typed function:

```ts
function getAiTierIconName(tier?: string | null): BgmsIconName {
  if (tier === "S") return "award";
  if (tier?.startsWith("A")) return "flame";
  if (tier?.startsWith("B")) return "battle";
  if (tier?.startsWith("C")) return "zap";
  return "shield";
}
```

- [ ] **Step 3: Replace match badge emoji**

In `components/stat/MatchCard.tsx`, replace `badgeIcon` string logic:

```ts
const badgeIconName: BgmsIconName =
  badge.id === "smoke_master" ? "shield" :
  badge.id === "sharpshooter" ? "crosshair" :
  badge.id === "zone_wizard" ? "zap" :
  badge.id === "last_survivor" ? "shield" :
  badge.id === "damage_carry" ? "flame" :
  "award";
```

Render:

```tsx
<BgmsIcon name={badgeIconName} size={14} className="shrink-0" />
```

- [ ] **Step 4: Replace map emoji dictionary**

In `components/stat/MapKingCard.tsx`, replace `MAP_EMOJIS` with `MAP_ICON_TONES`:

```ts
const MAP_ICON_TONES: Record<string, string> = {
  "에란겔": "text-emerald-400",
  "미라마": "text-amber-400",
  "사녹": "text-green-400",
  "태이고": "text-red-300",
  "론도": "text-sky-300",
  "데스턴": "text-yellow-300",
  "칼린도": "text-cyan-300",
  "헤이븐": "text-zinc-300"
};
```

Render:

```tsx
<BgmsIcon name="map" className={MAP_ICON_TONES[bestMap.displayName] ?? "text-[#F2A900]"} size={32} />
```

- [ ] **Step 5: Replace battle UI error/loading labels**

In `app/stats/battle/BattleClient.tsx`, replace:

```tsx
{loading ? "⏳ 분석 중..." : "⚔️ 대결 시작!"}
```

with:

```tsx
<InlineIconLabel icon={loading ? "loader" : "battle"} iconClassName={loading ? "animate-spin" : ""}>
  {loading ? "분석 중..." : "대결 시작!"}
</InlineIconLabel>
```

- [ ] **Step 6: Run focused search**

Run:

```bash
rg -n --pcre2 "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" components/stat app/stats/battle/BattleClient.tsx -g '*.tsx'
```

Expected: no user-visible emoji matches.

- [ ] **Step 7: Run verification**

Run: `npm run verify:core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add components/stat app/stats/battle/BattleClient.tsx
git commit -m "refactor: replace stats UI emoji with icons"
```

---

### Task 4: Map, Telemetry, and Leaflet Marker UI

**Files:**
- Modify: `components/map/MapShell.tsx`
- Modify: `components/map/MapView.tsx`
- Modify: `components/map/ReportForm.tsx`
- Modify: `components/map/KillFeed.tsx`
- Modify: `components/map/TelemetryPlayer.tsx`
- Modify: `components/map/MobileBottomSheet.tsx`
- Modify: `components/map/MapEditor.tsx`
- Modify: `components/map/SimulatorLayer.tsx`
- Modify: `components/map/telemetry/CombatRenderer.tsx`
- Modify: `components/map/telemetry/PlayerMarkerRenderer.tsx`
- Modify: `components/map/telemetry/TelemetryCanvasLayer.tsx`

**Interfaces:**
- Consumes: `svgIcon(name, options)` for `L.divIcon` HTML strings.
- Consumes: `InlineIconLabel` for React UI labels.

- [ ] **Step 1: Replace React-rendered map UI labels**

Use:

```tsx
<InlineIconLabel icon="crosshair">[박격포] 지도 위에 내 위치와 타겟 지점을 순서대로 클릭하세요.</InlineIconLabel>
<InlineIconLabel icon="activity">[시뮬레이터] 지도를 클릭해 서클 및 가상 경로 지점을 추가하세요.</InlineIconLabel>
<InlineIconLabel icon="alert">[차량 제보] 지도 위에 차량을 제보할 위치를 클릭하세요.</InlineIconLabel>
```

- [ ] **Step 2: Replace report form labels**

Use:

```tsx
<InlineIconLabel icon="message">차량 위치 제보</InlineIconLabel>
<InlineIconLabel icon="map">{activeMapId}</InlineIconLabel>
<InlineIconLabel icon="mapPin">{location.lng.toFixed(1)}, {location.lat.toFixed(1)}</InlineIconLabel>
<InlineIconLabel icon={isSubmitting ? "loader" : "mapPin"} iconClassName={isSubmitting ? "animate-spin" : ""}>
  {isSubmitting ? "전송 중..." : "이 차량으로 제보하기"}
</InlineIconLabel>
```

- [ ] **Step 3: Replace kill feed labels**

Use:

```tsx
<BgmsIcon name={isKill ? "skull" : "battle"} className="shrink-0 text-red-300" size={12} />
{ev.weapon ? <InlineIconLabel icon="weapon">{getWeaponName(ev.weapon)}</InlineIconLabel> : null}
<InlineIconLabel icon="mapPin">{ev.distance}m</InlineIconLabel>
```

- [ ] **Step 4: Replace Leaflet marker emoji HTML**

In `components/stat/Squad2DMap.tsx`, `components/map/telemetry/CombatRenderer.tsx`, `components/map/telemetry/PlayerMarkerRenderer.tsx`, import:

```ts
import { svgIcon } from "@/lib/ui/icon-svg";
```

Replace marker content:

```ts
const deathSvg = svgIcon("skull", { color: "currentColor", size: 14 });
const vehicleSvg = svgIcon("vehicle", { color: "currentColor", size: 12 });
const targetSvg = svgIcon("target", { color: "currentColor", size: 12 });
```

Example:

```ts
html: `<div class="relative w-7 h-7 bg-red-600 border-2 border-white rounded-full flex items-center justify-center font-bold text-white shadow-lg text-sm">${deathSvg}</div>`
```

- [ ] **Step 5: Replace canvas emoji drawing**

In `components/map/telemetry/TelemetryCanvasLayer.tsx`, replace `ctx.fillText("✈️", 0, 0)` and `ctx.fillText("🚗", 0, -1)` with simple vector drawing helpers:

```ts
function drawPlaneGlyph(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(5, 7);
  ctx.lineTo(0, 4);
  ctx.lineTo(-5, 7);
  ctx.closePath();
  ctx.fill();
}

function drawVehicleGlyph(ctx: CanvasRenderingContext2D) {
  ctx.fillRect(-6, -3, 12, 6);
  ctx.fillRect(-4, -6, 8, 4);
  ctx.beginPath();
  ctx.arc(-4, 4, 2, 0, Math.PI * 2);
  ctx.arc(4, 4, 2, 0, Math.PI * 2);
  ctx.fill();
}
```

- [ ] **Step 6: Run focused search**

Run:

```bash
rg -n --pcre2 "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" components/map components/stat/Squad2DMap.tsx -g '*.tsx'
```

Expected: no user-visible emoji matches.

- [ ] **Step 7: Run verification**

Run: `npm run verify:core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add components/map components/stat/Squad2DMap.tsx
git commit -m "refactor: replace map UI emoji with SVG icons"
```

---

### Task 5: Admin UI and Open Graph Images

**Files:**
- Modify: `components/admin/GameDataEditor.tsx`
- Modify: `app/admin/review/page.tsx`
- Modify: `app/admin/map-settings/page.tsx`
- Modify: `app/admin/dashboard/page.tsx`
- Modify: `app/rankings/opengraph-image.tsx`
- Modify: `app/stats/[platform]/[nickname]/opengraph-image.tsx`
- Modify: `app/api/og/squad/route.tsx`

**Interfaces:**
- Consumes: `InlineIconLabel`
- Consumes: `BgmsIcon`
- Consumes: emoji-free OG labels

- [ ] **Step 1: Replace admin tab labels**

Change tab data:

```ts
const tabs = [
  { id: "crates", label: "은신처 상점", icon: "package" },
  { id: "users", label: "유저 관리", icon: "team" },
  { id: "system", label: "시스템/캐시", icon: "database" }
] satisfies Array<{ id: string; label: string; icon: BgmsIconName }>;
```

Render:

```tsx
<InlineIconLabel icon={tab.icon}>{tab.label}</InlineIconLabel>
```

- [ ] **Step 2: Replace admin status badges and buttons**

Use these mappings:

```ts
const adminIconMap = {
  missing: "alert",
  verified: "check",
  auth: "shield",
  user: "team",
  sync: "refresh",
  save: "save",
  delete: "delete",
  upload: "file",
  notice: "message",
  dashboard: "activity"
} satisfies Record<string, BgmsIconName>;
```

Replace all visible `✅`, `❌`, `⚠️`, `⏳`, `👤`, `👥`, `🎮`, `💬`, `✉️`, `📍`, `📝`, `📊`, `🤖`, `🔄`, `🗑️`, `📢`, `📁`, `💾`, `📋`, `📦`.

- [ ] **Step 3: Replace admin review page labels**

Use:

```tsx
<InlineIconLabel icon="alert">관제탑 제보 심사 조종석</InlineIconLabel>
<InlineIconLabel icon="map">맵 위치</InlineIconLabel>
<InlineIconLabel icon="vehicle">발견 물자</InlineIconLabel>
<InlineIconLabel icon="mapPin">좌표 (X, Y)</InlineIconLabel>
<InlineIconLabel icon="flame">유저 신뢰도(교차검증)</InlineIconLabel>
<InlineIconLabel icon="check">즉시 승인</InlineIconLabel>
<InlineIconLabel icon="error">거짓말 (파기)</InlineIconLabel>
```

- [ ] **Step 4: Replace OG image emoji text**

Because `opengraph-image.tsx` renders image markup, use emoji-free text and simple bordered glyph boxes:

```tsx
<div style={{ width: 34, height: 34, borderRadius: 8, border: "2px solid #f59e0b", display: "flex", alignItems: "center", justifyContent: "center", color: "#f59e0b", fontSize: 18, fontWeight: 900 }}>B</div>
<div style={{ fontSize: "32px", fontWeight: "900", color: "#f59e0b" }}>BGMS</div>
```

Change labels like `🔥 최고 딜량 1위` to `최고 딜량 1위`.

- [ ] **Step 5: Run focused search**

Run:

```bash
rg -n --pcre2 "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" components/admin app/admin app/rankings/opengraph-image.tsx app/stats/[platform]/[nickname]/opengraph-image.tsx app/api/og/squad/route.tsx -g '*.tsx'
```

Expected: no user-visible emoji matches.

- [ ] **Step 6: Run verification**

Run: `npm run verify:core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/admin app/admin app/rankings/opengraph-image.tsx app/stats/[platform]/[nickname]/opengraph-image.tsx app/api/og/squad/route.tsx
git commit -m "refactor: replace admin and OG emoji with icons"
```

---

### Task 6: Final Sweep and Mobile QA

**Files:**
- Modify: any missed `app/**/*.tsx` or `components/**/*.tsx` UI file from the final search.
- Test: `npm run verify:core`

**Interfaces:**
- Consumes: all previous icon primitives.
- Produces: emoji-free user-visible TSX UI in `app` and `components`.

- [ ] **Step 1: Run full UI emoji search**

Run:

```bash
rg -n --pcre2 "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" app components -g '*.tsx' -g '!*.test.tsx' -g '!*.spec.tsx'
```

Expected: remaining matches should be comments only, non-UI server route strings, or deliberate non-emoji symbols such as `✕`, `✓`, `★` if they are used as plain symbols. Replace any remaining visible emoji.

- [ ] **Step 2: Run full core verification**

Run: `npm run verify:core`
Expected: PASS.

- [ ] **Step 3: Start or reuse dev server**

Check:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

If no server is running:

```bash
npm run dev
```

- [ ] **Step 4: Mobile QA**

Check these routes:

```text
/stats
/maps/erangel
/stats/battle
/rankings
/admin
```

At viewports:

```text
375x667
390x844
430x932
```

Verify:

```text
아이콘과 텍스트가 겹치지 않는다.
버튼 텍스트가 줄바꿈되어도 버튼 밖으로 넘치지 않는다.
하단 내비게이션과 주요 CTA가 간섭하지 않는다.
로딩, 빈 상태, 에러 상태에서 이모지가 보이지 않는다.
```

- [ ] **Step 5: Commit final sweep**

```bash
git add app components lib/ui
git commit -m "chore: complete UI emoji replacement sweep"
```
