export type SvgIconName =
  | "alert"
  | "check"
  | "error"
  | "flame"
  | "info"
  | "map"
  | "pin"
  | "skull"
  | "target"
  | "vehicle"
  | "weapon"
  | "zap";

interface SvgIconOptions {
  className?: string;
  color?: string;
  size?: number;
}

const PATHS: Record<SvgIconName, string> = {
  alert:
    '<path d="M12 9v4m0 4h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  error:
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
  flame:
    '<path d="M8.5 14.5A4.5 4.5 0 0 0 13 19a4.5 4.5 0 0 0 4.5-4.5c0-2.9-1.6-4.8-3.2-6.4-.4 1.8-1.4 2.8-2.7 3.7.2-2.2-.5-4.1-2.3-5.8C9 8.4 7 10.5 7 13c0 .5.1 1 .3 1.5"/>',
  info:
    '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  skull:
    '<path d="M12 2a8 8 0 0 0-8 8c0 3 1.8 5.6 4.4 6.9V21h7.2v-4.1A7.9 7.9 0 0 0 20 10a8 8 0 0 0-8-8Z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M9 15h6"/>',
  target:
    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  vehicle:
    '<path d="M5 17h14l-1.5-5h-11L5 17Z"/><path d="M7 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/><path d="M7 12l2-5h6l2 5"/>',
  weapon:
    '<path d="M14 6 3 17"/><path d="m5 19-2-2 3-3 2 2-3 3Z"/><path d="M14 6h7v4h-3l-2 3-4-4 2-3Z"/>',
  zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
};

export function svgIcon(name: SvgIconName, options: SvgIconOptions = {}) {
  const size = options.size ?? 14;
  const color = options.color ?? "currentColor";
  const className = options.className ? ` class="${options.className}"` : "";

  return `<svg${className} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
