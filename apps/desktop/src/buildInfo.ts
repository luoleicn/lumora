export const buildTime = __LUMORA_BUILD_TIME__;
export const gitCommit = __LUMORA_GIT_COMMIT__;

export function formatBuildTime(value: string, timezoneOffsetMinutes?: number): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const offsetMinutes = timezoneOffsetMinutes ?? date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offsetMinutes * 60 * 1_000);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(localDate.getUTCDate()).padStart(2, "0");
  const hours = String(localDate.getUTCHours()).padStart(2, "0");
  const minutes = String(localDate.getUTCMinutes()).padStart(2, "0");
  const seconds = String(localDate.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${formatUtcOffset(offsetMinutes)}`;
}

function formatUtcOffset(timezoneOffsetMinutes: number): string {
  if (timezoneOffsetMinutes === 0) {
    return "UTC";
  }

  const absoluteMinutes = Math.abs(timezoneOffsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  const sign = timezoneOffsetMinutes < 0 ? "+" : "-";

  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}
