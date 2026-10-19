export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Human friendly, compact age: "45m", "5h", "3d", "2mo", "1.5y". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 0) ms = 0;
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = ms / DAY;
  if (days < 60) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  const years = days / 365;
  return `${years >= 10 ? Math.round(years) : Math.round(years * 10) / 10}y`;
}

/** Describes a threshold in the most natural unit ("7 days", "36 hours", "90 minutes"). */
export function formatThreshold(ms: number): string {
  if (ms <= 0) return "0 (disabled)";
  if (ms % DAY === 0) return plural(ms / DAY, "day");
  if (ms % HOUR === 0) return plural(ms / HOUR, "hour");
  if (ms % MINUTE === 0) return plural(ms / MINUTE, "minute");
  return plural(Math.round((ms / DAY) * 100) / 100, "day");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
