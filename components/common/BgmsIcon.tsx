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
  type LucideIcon,
} from "lucide-react";

export type BgmsIconName =
  | "activity"
  | "admin"
  | "alert"
  | "award"
  | "backpack"
  | "battle"
  | "board"
  | "bot"
  | "box"
  | "check"
  | "chevronDown"
  | "chevronUp"
  | "clock"
  | "crosshair"
  | "database"
  | "delete"
  | "download"
  | "error"
  | "eye"
  | "file"
  | "flame"
  | "image"
  | "info"
  | "link"
  | "loader"
  | "map"
  | "mapPin"
  | "message"
  | "package"
  | "plane"
  | "rank"
  | "refresh"
  | "save"
  | "search"
  | "shield"
  | "skull"
  | "sparkles"
  | "star"
  | "team"
  | "tool"
  | "vehicle"
  | "weapon"
  | "x"
  | "zap";

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
  zap: Zap,
};

export interface BgmsIconProps {
  name: BgmsIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean;
}

export function BgmsIcon({
  name,
  size = 16,
  strokeWidth = 2.4,
  className,
  "aria-hidden": ariaHidden = true,
}: BgmsIconProps) {
  const Icon = ICONS[name];

  return (
    <Icon
      aria-hidden={ariaHidden}
      className={className}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
