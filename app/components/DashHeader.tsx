import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Activity, ExternalLink, ChevronDown } from "lucide-react";
import { useStream } from "../hooks/useStream";
import { useTenantContext } from "../hooks/useTenantContext";
import { authFetch } from "../lib/authFetch";
import type { HomeData } from "../../server/api/types";

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/admin": { title: "Admin Center", sub: "Health score · Detections · Audit · Governance" },
  "/insights": { title: "Detections & Auto-fix", sub: "AI-reasoned findings, risk-tiered remediations" },
  "/": { title: "Operations", sub: "Live stack telemetry — last 5 min" },
  "/autopipeline": { title: "Autopipeline", sub: "Editorial queue, stages, throughput" },
  "/doctor": { title: "Doctor", sub: "Auto-repair history & error analysis" },
  "/models": { title: "Models", sub: "Inventory, health, discovery" },
  "/litellm": { title: "LiteLLM", sub: "Routing config, health, fallback chains" },
  "/newsbites": { title: "NewsBites", sub: "Articles, deploys, site health" },
  "/infra": { title: "Infrastructure", sub: "Hetzner · Vast · GPU · services" },
  "/incidents": { title: "Incidents", sub: "Cross-cutting failure timeline" },
  "/data-explorer": { title: "Data Explorer", sub: "Read-only allowlisted operational tables" },
  "/opencode": { title: "OpenCode", sub: "Agent sessions" },
  "/codex": { title: "Codex", sub: "Headless codex exec" },
  "/claude": { title: "Claude Code", sub: "Headless claude wrapper (planned)" },
};

function pickMeta(loc: string) {
  if (loc === "/") return PAGE_META["/"];
  for (const [path, meta] of Object.entries(PAGE_META)) {
    if (path !== "/" && loc.startsWith(path)) return meta;
  }
  return PAGE_META["/"];
}

interface Tenant { id: string; name: string; }
interface ProjectItem { id: string; name: string; }

function TenantProjectPills() {
  const { tenantId, projectId, setTenantId, setProjectId } = useTenantContext();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [tenantOpen, setTenantOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const tenantRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    authFetch("/api/tenants")
      .then((r) => r.json() as Promise<{ tenants: Tenant[] }>)
      .then((d) => setTenants(d.tenants ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    authFetch(`/api/projects?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => r.json() as Promise<{ projects: ProjectItem[] }>)
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {});
  }, [tenantId]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (tenantRef.current && !tenantRef.current.contains(e.target as Node)) setTenantOpen(false);
      if (projectRef.current && !projectRef.current.contains(e.target as Node)) setProjectOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const tenantLabel = tenants.find((t) => t.id === tenantId)?.name ?? tenantId;
  const projectLabel = projects.find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <div className="tenant-project-pills">
      <div className="ctx-pill-wrap" ref={tenantRef}>
        <button className="ctx-pill" onClick={() => { setTenantOpen((o) => !o); setProjectOpen(false); }}>
          <span className="ctx-pill-label">tenant</span>
          <span className="ctx-pill-sep">:</span>
          <span className="ctx-pill-value">{tenantLabel}</span>
          <ChevronDown size={11} />
        </button>
        {tenantOpen && (
          <div className="ctx-dropdown">
            {tenants.map((t) => (
              <button
                key={t.id}
                className={`ctx-dropdown-item${t.id === tenantId ? " active" : ""}`}
                onClick={() => { setTenantId(t.id); setTenantOpen(false); }}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ctx-pill-wrap" ref={projectRef}>
        <button className="ctx-pill" onClick={() => { setProjectOpen((o) => !o); setTenantOpen(false); }}>
          <span className="ctx-pill-label">project</span>
          <span className="ctx-pill-sep">:</span>
          <span className="ctx-pill-value">{projectLabel}</span>
          <ChevronDown size={11} />
        </button>
        {projectOpen && (
          <div className="ctx-dropdown">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`ctx-dropdown-item${p.id === projectId ? " active" : ""}`}
                onClick={() => { setProjectId(p.id); setProjectOpen(false); }}
              >
                {p.name}
              </button>
            ))}
            {projects.length === 0 && <span className="ctx-dropdown-empty">No projects</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export function DashHeader() {
  const [location] = useLocation();
  const meta = pickMeta(location);
  const { connected } = useStream<HomeData>("/api/stream");
  const [now, setNow] = useState<string>(new Date().toUTCString().slice(17, 25));
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    authFetch("/api/version")
      .then((r) => r.json() as Promise<{ version?: string }>)
      .then((d) => { if (d.version) setVersion(d.version); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date().toUTCString().slice(17, 25));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="dash-header">
      <div className="dash-header-titles">
        <h1 className="dash-header-title">{meta.title}</h1>
        <span className="dash-header-sub">{meta.sub}</span>
      </div>
      <div className="dash-header-right">
        <TenantProjectPills />
        <span className={`live-indicator ${connected ? "on" : "off"}`}>
          <Activity size={12} strokeWidth={2} />
          {connected ? "live" : "polling"}
        </span>
        <span className="dash-header-clock">{now} UTC</span>
        {version && (
          <span className="version-badge" title={`API Version: v1`}>{version}</span>
        )}
        <a
          className="dash-header-link"
          href="https://news.techinsiderbytes.com"
          target="_blank"
          rel="noreferrer"
          title="Open news.techinsiderbytes.com"
        >
          news <ExternalLink size={11} strokeWidth={2} />
        </a>
      </div>
    </header>
  );
}
