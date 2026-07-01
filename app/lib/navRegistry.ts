export type RouteStatus = "core" | "advanced" | "labs" | "hidden";

export interface RouteEntry {
  href: string;
  label: string;
  status: RouteStatus;
  experimental?: boolean;
  sub?: string;
}

export interface NavMeta {
  href: string;
  label: string;
  sub?: string;
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
export const NAV_ITEMS: NavMeta[] = [
  { href: "/admin", label: "Admin Center", status: "core", sub: "Health score / Detections / Audit / Governance" },
  { href: "/", label: "Home", status: "core", sub: "Live stack telemetry - last 5 min" },
  { href: "/insights", label: "Detections", status: "core", sub: "AI-reasoned findings, risk-tiered remediations" },
  { href: "/security", label: "Security", status: "core" },
  { href: "/agents", label: "Agents", status: "core" },
  { href: "/today", label: "Today", status: "core" },
  { href: "/autopipeline", label: "Pipeline", status: "core", sub: "Editorial queue, stages, throughput" },
  { href: "/agent-team", label: "Agent Team", status: "core" },
  { href: "/doctor", label: "Doctor", status: "core", sub: "Auto-repair history & error analysis" },
  { href: "/models", label: "Models", status: "core", sub: "Inventory, health, discovery" },
  { href: "/cost", label: "Cost", status: "core" },
  { href: "/newsbites", label: "NewsBites", status: "core", sub: "Articles, deploys, site health" },
  { href: "/infra", label: "Infra", status: "core", sub: "Hetzner / Vast / GPU / services" },
  { href: "/incidents", label: "Incidents", status: "core", sub: "Cross-cutting failure timeline" },
  { href: "/jobs", label: "Jobs", status: "core" },
  { href: "/audit", label: "Audit", status: "core" },
  { href: "/builder", label: "Builder", status: "core" },
  { href: "/brainstorm", label: "Brainstorm", status: "core" },
  { href: "/settings", label: "Settings", status: "core" },
  { href: "/opencode", label: "OpenCode", status: "core", sub: "Agent sessions" },
  { href: "/codex", label: "Codex", status: "core", sub: "Headless codex exec" },
  { href: "/claude", label: "Claude Code", status: "core", sub: "Headless claude wrapper (planned)" },
  { href: "/gemini", label: "Gemini", status: "core" },
  { href: "/workflows", label: "Workflows", status: "advanced", experimental: true },
  { href: "/marketplace", label: "Marketplace", status: "labs", experimental: true },
  { href: "/traces", label: "Traces", status: "advanced" },
  { href: "/gateway", label: "Gateway", status: "core" },
  { href: "/governance", label: "Access & Policy", status: "core" },
  { href: "/compliance", label: "Compliance", status: "core" },
  { href: "/projects", label: "Projects", status: "advanced", experimental: true },
  { href: "/about", label: "About", status: "labs", experimental: true },
  { href: "/install", label: "Setup", status: "advanced" },
  { href: "/litellm", label: "LiteLLM", status: "advanced", experimental: true, sub: "Routing config, health, fallback chains" },
  { href: "/finance-intel", label: "Finance Intel", status: "advanced", experimental: true },
  { href: "/scout", label: "Scout", status: "advanced", experimental: true },
  { href: "/channels", label: "Channels", status: "advanced" },
  { href: "/content-health", label: "Content Health", status: "advanced", experimental: true },
  { href: "/reports", label: "Reports", status: "advanced" },
  { href: "/data-explorer", label: "Data Explorer", status: "advanced", experimental: true, sub: "Read-only allowlisted operational tables" },
  { href: "/status", label: "Status", status: "hidden" },
  { href: "/feature-flags", label: "Feature Flags", status: "advanced" },
];

export const NAV_REGISTRY: Record<string, RouteEntry> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.href, item])
);

export function getRouteStatus(href: string): RouteStatus {
  return NAV_REGISTRY[href]?.status ?? "labs";
}

export function isExperimental(href: string): boolean {
  return NAV_REGISTRY[href]?.experimental ?? false;
}

export function getRouteMeta(location: string): { title: string; sub?: string } {
  const normalized = location.split(/[?#]/, 1)[0] || "/";
  if (normalized === "/") {
    const home = NAV_REGISTRY["/"];
    return { title: "Operations", sub: home?.sub };
  }

  const match = NAV_ITEMS
    .filter((item) => item.href !== "/" && normalized.startsWith(item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return {
    title: match?.label ?? "Unknown",
    sub: match?.sub,
  };
}
