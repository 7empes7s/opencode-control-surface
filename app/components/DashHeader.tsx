import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Activity, ExternalLink } from "lucide-react";
import { useStream } from "../hooks/useStream";
import type { HomeData } from "../../server/api/types";

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": { title: "Operations", sub: "Live stack telemetry — last 5 min" },
  "/autopipeline": { title: "Autopipeline", sub: "Editorial queue, stages, throughput" },
  "/doctor": { title: "Doctor", sub: "Auto-repair history & error analysis" },
  "/models": { title: "Models", sub: "Inventory, health, discovery" },
  "/newsbites": { title: "NewsBites", sub: "Articles, deploys, site health" },
  "/infra": { title: "Infrastructure", sub: "Hetzner · Vast · GPU · services" },
  "/incidents": { title: "Incidents", sub: "Cross-cutting failure timeline" },
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

export function DashHeader() {
  const [location] = useLocation();
  const meta = pickMeta(location);
  const { connected } = useStream<HomeData>("/api/stream");
  const [now, setNow] = useState<string>(new Date().toUTCString().slice(17, 25));

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
        <span className={`live-indicator ${connected ? "on" : "off"}`}>
          <Activity size={12} strokeWidth={2} />
          {connected ? "live" : "polling"}
        </span>
        <span className="dash-header-clock">{now} UTC</span>
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
