import { VERSION } from "./version.ts";

export interface UpdateInfo {
  latestVersion: string;
  releaseUrl: string;
  changelog: string;
}

let cachedUpdateInfo: UpdateInfo | null = null;
let lastCheckTime: number = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch("https://releases.tib-builder.dev/latest/version.json", {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      const data = await resp.json() as { version: string; url?: string; changelog?: string };
      if (!data.version) return null;
      if (data.version === VERSION) return null;
      return {
        latestVersion: data.version,
        releaseUrl: data.url ?? "https://releases.tib-builder.dev",
        changelog: data.changelog ?? "",
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  } catch {
    return null;
  }
}

export function getCachedUpdateInfo(): UpdateInfo | null {
  return cachedUpdateInfo;
}

export function setCachedUpdateInfo(info: UpdateInfo | null): void {
  cachedUpdateInfo = info;
  lastCheckTime = Date.now();
}

export function shouldRefreshCache(): boolean {
  if (!cachedUpdateInfo) return true;
  return Date.now() - lastCheckTime > CACHE_TTL_MS;
}