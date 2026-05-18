export type RouteStatus = "core" | "advanced" | "labs" | "hidden";

export interface RouteEntry {
  status: RouteStatus;
  experimental?: boolean;
}

/**
 * Nav readiness registry: every route has a product status.
 * - core: shown in primary nav, stable, operator-ready
 * - advanced: available in drawer, stable but secondary
 * - labs: experimental, may change or break
 * - hidden: not linked in nav (e.g. legacy or admin-only)
 */
export const NAV_REGISTRY: Record<string, RouteEntry> = {
  "/": { status: "core" },
  "/today": { status: "core" },
  "/autopipeline": { status: "core" },
  "/doctor": { status: "core" },
  "/models": { status: "core" },
  "/newsbites": { status: "core" },
  "/infra": { status: "core" },
  "/incidents": { status: "core" },
  "/jobs": { status: "core" },
  "/audit": { status: "core" },
  "/builder": { status: "core" },
  "/settings": { status: "core" },
  "/opencode": { status: "core" },
  "/codex": { status: "core" },
  "/claude": { status: "core" },
  "/gemini": { status: "core" },
  "/workflows": { status: "advanced", experimental: true },
  "/marketplace": { status: "labs", experimental: true },
  "/traces": { status: "labs", experimental: true },
  "/gateway": { status: "advanced", experimental: true },
  "/governance": { status: "labs", experimental: true },
  "/compliance": { status: "labs", experimental: true },
  "/projects": { status: "advanced", experimental: true },
  "/about": { status: "labs", experimental: true },
  "/install": { status: "labs", experimental: true },
  "/finance-intel": { status: "advanced", experimental: true },
  "/litellm": { status: "advanced", experimental: true },
  "/paperclip": { status: "advanced", experimental: true },
  "/scout": { status: "advanced", experimental: true },
  "/channels": { status: "advanced", experimental: true },
};

export function getRouteStatus(href: string): RouteStatus {
  return NAV_REGISTRY[href]?.status ?? "labs";
}

export function isExperimental(href: string): boolean {
  return NAV_REGISTRY[href]?.experimental ?? false;
}
