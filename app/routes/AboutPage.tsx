import { useState, useEffect } from "react";
import { authFetch } from "../lib/authFetch";

interface VersionData {
  version: string;
  commit: string;
  buildTime: string;
  nodeEnv: string;
  platform: string;
  arch: string;
  updateAvailable: { latestVersion: string; releaseUrl: string; changelog: string } | null;
}

interface HomeData {
  startedAt: number;
  memoryMB: number;
  sqlitePath: string | null;
}

export function AboutPage() {
  const [versionData, setVersionData] = useState<VersionData | null>(null);
  const [homeData, setHomeData] = useState<HomeData | null>(null);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      authFetch("/api/version").then(r => r.json()),
      authFetch("/api/home").then(r => r.json()),
    ]).then(([v, h]) => {
      setVersionData(v);
      setHomeData(h);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    try {
      const res = await authFetch("/api/update-check", { method: "POST" });
      const data = await res.json();
      setVersionData(prev => prev ? { ...prev, updateAvailable: data.updateAvailable } : null);
    } finally {
      setChecking(false);
    }
  }

  if (loading) return <div className="p-6 text-[var(--text-muted)]">Loading…</div>;

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-[var(--text-bright)]">About Control Surface</h1>

      {versionData?.updateAvailable && (
        <div className="w-card" style={{ background: "color-mix(in oklch, var(--amber-warn) 7%, transparent)", border: "1px solid color-mix(in oklch, var(--amber-warn) 30%, transparent)", borderRadius: 6, padding: "14px 16px" }}>
          <div className="text-sm font-medium text-amber-400">Update Available</div>
          <div className="text-sm text-[var(--text-secondary)] mt-1">
            Version <span className="font-mono">{versionData.updateAvailable.latestVersion}</span> is available.{" "}
            <a href={versionData.updateAvailable.releaseUrl} target="_blank" rel="noopener" className="underline hover:text-amber-300">
              View Release
            </a>
          </div>
        </div>
      )}

      <div className="w-card">
        <div className="text-sm font-medium text-[var(--text-secondary)] mb-3">Version Info</div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Version</div>
            <div className="font-mono text-[var(--text-bright)] mt-1">
              <span className="px-2 py-0.5 bg-[var(--bg-hover)] rounded text-amber-400 font-bold">
                {versionData?.version ?? "—"}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Build Commit</div>
            <div className="font-mono text-[var(--text-bright)] mt-1">
              {versionData?.commit ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Build Time</div>
            <div className="font-mono text-[var(--text-bright)] mt-1">
              {versionData?.buildTime ? new Date(versionData.buildTime).toLocaleString() : "—"}
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Platform</div>
            <div className="font-mono text-[var(--text-bright)] mt-1">
              {versionData?.platform}/{versionData?.arch}
            </div>
          </div>
          <div>
            <div className="text-[var(--text-muted)] text-xs uppercase tracking-wide">Node Env</div>
            <div className="font-mono text-[var(--text-bright)] mt-1">
              {versionData?.nodeEnv ?? "—"}
            </div>
          </div>
        </div>
        <button
          onClick={checkForUpdates}
          disabled={checking}
          className="mt-4 px-4 py-2 bg-[var(--bg-hover)] hover:bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-sm transition-colors disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check for Updates"}
        </button>
      </div>

      <div className="w-card">
        <div className="text-sm font-medium text-[var(--text-secondary)] mb-3">Install Paths</div>
        <div className="space-y-2 text-sm font-mono">
          <div>
            <span className="text-[var(--text-muted)]">Binary: </span>
            <span className="text-[var(--text-bright)]">/usr/local/bin/tib-builder</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Data Dir: </span>
            <span className="text-[var(--text-bright)]">/var/lib/tib-builder</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Config: </span>
            <span className="text-[var(--text-bright)]">/etc/tib-builder/config.yaml</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">SQLite: </span>
            <span className="text-[var(--text-bright)]">{homeData?.sqlitePath ?? "—"}</span>
          </div>
        </div>
      </div>

      <div className="w-card">
        <div className="text-sm font-medium text-[var(--text-secondary)] mb-3">Runtime Stats</div>
        <div className="space-y-2 text-sm">
          <div>
            <span className="text-[var(--text-muted)]">Uptime: </span>
            <span className="text-[var(--text-bright)]">
              {homeData?.startedAt ? `${Math.round((Date.now() - homeData.startedAt) / 1000 / 60)} min` : "—"}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Memory (RSS): </span>
            <span className="text-[var(--text-bright)]">
              {homeData?.memoryMB ? `${homeData.memoryMB} MB` : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}