import { type ReactNode } from "react";
import { BgmsIcon, type BgmsIconName } from "@/components/common/BgmsIcon";

interface InlineIconLabelProps {
  icon: BgmsIconName;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  iconSize?: number;
}

export function InlineIconLabel({
  icon,
  children,
  className = "",
  iconClassName = "",
  iconSize = 16,
}: InlineIconLabelProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <BgmsIcon
        name={icon}
        size={iconSize}
        className={`shrink-0 ${iconClassName}`}
      />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
