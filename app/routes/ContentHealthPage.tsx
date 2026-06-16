import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Image, Link as LinkIcon, RefreshCw, ShieldCheck } from "lucide-react";
import { TableControls } from "../components/TableControls";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { useTableControls } from "../hooks/useTableControls";
import type { ContentHealthFinding, ContentHealthResponse, ContentHealthRunResponse } from "../../server/api/content-health";

const KIND_LABEL: Record<string, string> = {
  "article.missing_image": "Missing image",
  "article.thin_digest": "Thin digest",
  "article.invalid_vertical": "Invalid vertical",
  "article.broken_link": "Broken link",
  "content.near_duplicate": "Near duplicate",
  "content.vertical_concentration": "Vertical concentration",
  "content.vertical_gap": "Vertical gap",
};

function severityClass(severity: string): string {
  if (severity === "error" || severity === "critical" || severity === "high") return "red";
  if (severity === "warn" || severity === "medium") return "amber";
  return "blue";
}

function ageLabel(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function kindIcon(kind: string) {
  if (kind.includes("image")) return <Image size={16} />;
  if (kind.includes("link")) return <LinkIcon size={16} />;
  if (kind.includes("digest")) return <FileText size={16} />;
  return <AlertTriangle size={16} />;
}

function FindingRow({ finding }: { finding: ContentHealthFinding }) {
  const [expanded, setExpanded] = useState(false);
  const liveUrl = finding.slug ? `https://news.techinsiderbytes.com/articles/${encodeURIComponent(finding.slug)}` : null;
  return (
    <div className="content-health-row">
      <button type="button" className="content-health-row-main" onClick={() => setExpanded((v) => !v)}>
        <span className="content-health-kind-icon">{kindIcon(finding.kind)}</span>
        <span className="content-health-row-copy">
          <strong>{finding.title || finding.slug || "Unknown article"}</strong>
          <span>{finding.summary}</span>
        </span>
        <span className={`pill ${severityClass(finding.severity)}`}>{finding.severity}</span>
        <span className="pill gray">{KIND_LABEL[finding.kind] ?? finding.kind}</span>
        <span className="dim">{ageLabel(finding.ts)}</span>
      </button>
      {expanded && (
        <div className="content-health-detail">
          <div><strong>Slug:</strong> {finding.slug || "unknown"}</div>
          <div><strong>Vertical:</strong> {finding.vertical || "unknown"}</div>
          {finding.path && <div><strong>File:</strong> <code>{finding.path}</code></div>}
          {finding.dedupeKey && <div><strong>Dedupe:</strong> <code>{finding.dedupeKey}</code></div>}
          {liveUrl && (
            <a className="btn secondary" href={liveUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Open live article
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function ContentHealthPage() {
  const { data, loading, error, refresh, request } = useAuthenticatedApi<ContentHealthResponse>("/api/content-health?limit=100", 30_000);
  const [severityFilter, setSeverityFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [runningScan, setRunningScan] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastScanCount, setLastScanCount] = useState<number | null>(null);

  const topKinds = useMemo(() => {
    const entries = Object.entries(data?.summary.byKind ?? {});
    return entries.sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [data]);

  const findings = data?.findings ?? [];
  const severityOptions = useMemo(() => {
    return Array.from(new Set(findings.map((finding) => finding.severity))).sort();
  }, [findings]);
  const kindOptions = useMemo(() => {
    return Array.from(new Set(findings.map((finding) => finding.kind))).sort();
  }, [findings]);
  const filteredFindings = useMemo(() => {
    return findings.filter((finding) => {
      if (severityFilter !== "all" && finding.severity !== severityFilter) return false;
      if (kindFilter !== "all" && finding.kind !== kindFilter) return false;
      return true;
    });
  }, [findings, kindFilter, severityFilter]);
  const findingControls = useTableControls<ContentHealthFinding, "ts">({
    rows: filteredFindings,
    pageSize: 20,
    defaultSort: { key: "ts", dir: "desc" },
    filterText: (finding) => [
      finding.title,
      finding.slug,
      finding.summary,
      finding.vertical,
      finding.path,
      finding.kind,
      finding.severity,
    ],
    sortValue: (finding) => finding.ts,
  });
  const healthy = !loading && !error && findings.length === 0 && !data?.degraded;

  async function runScan() {
    setRunningScan(true);
    setRunError(null);
    try {
      const response = await request("/api/content-health/run?limit=100", { method: "POST" });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `HTTP ${response.status}`);
      }
      const json = await response.json() as { data: ContentHealthRunResponse };
      setLastScanCount(json.data.scan.generatedFindings);
      refresh();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningScan(false);
    }
  }

  return (
    <div className="dash-page content-health-page">
      <section className="content-health-hero">
        <div>
          <div className="dash-section-title">content health</div>
          <h1>Article quality findings</h1>
          <p>Monitor NewsBites publishing issues from the detector: missing images, thin digests, invalid verticals, link health, duplicate risks, and coverage gaps.</p>
        </div>
        <div className="button-row">
          <button type="button" className="btn" onClick={runScan} disabled={runningScan}>
            <RefreshCw size={14} />
            {runningScan ? "Running..." : "Run check"}
          </button>
          <button type="button" className="btn secondary" onClick={refresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </section>

      <section className="content-health-summary">
        <div className="metric-tile">
          <span>Total findings</span>
          <strong>{data?.summary.total ?? 0}</strong>
        </div>
        <div className="metric-tile">
          <span>Affected articles</span>
          <strong>{data?.summary.affectedArticles ?? 0}</strong>
        </div>
        <div className="metric-tile">
          <span>Warnings</span>
          <strong>{data?.summary.bySeverity.warn ?? 0}</strong>
        </div>
        <div className="metric-tile">
          <span>Errors</span>
          <strong>{data?.summary.bySeverity.error ?? 0}</strong>
        </div>
      </section>

      {data?.degraded && <div className="loading-panel error">Content health is degraded: {data.reason ?? "unknown reason"}.</div>}
      {runError && <div className="loading-panel error">Content health scan failed: {runError}</div>}
      {lastScanCount !== null && !runError && (
        <div className="loading-panel success">Latest scan generated {lastScanCount} finding{lastScanCount === 1 ? "" : "s"}.</div>
      )}
      {loading && !data && <div className="loading-panel">Loading content health findings.</div>}
      {error && !data && <div className="loading-panel error">Content health did not load: {error}</div>}
      {healthy && (
        <div className="empty-state">
          <ShieldCheck size={24} />
          <strong>No content health findings.</strong>
          <span>The latest detector output does not show open article quality issues.</span>
        </div>
      )}

      {topKinds.length > 0 && (
        <section className="dash-section">
          <div className="dash-section-title">top finding classes</div>
          <div className="content-health-kind-grid">
            {topKinds.map(([kind, count]) => (
              <div className="content-health-kind-card" key={kind}>
                <span>{KIND_LABEL[kind] ?? kind}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      {findings.length > 0 && (
        <section className="dash-section">
          <div className="insight-group-title">
            <span>Quality violations</span>
            <span className="pill gray">{findingControls.filteredCount} / {findings.length}</span>
          </div>
          <div className="content-health-filters">
            <TableControls
              {...findingControls.controlsProps}
              searchPlaceholder="Search title, slug, summary, vertical..."
              className="content-health-search"
            />
            <label>
              Severity
              <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
                <option value="all">All severities</option>
                {severityOptions.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
              </select>
            </label>
            <label>
              Finding
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                <option value="all">All findings</option>
                {kindOptions.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind] ?? kind}</option>)}
              </select>
            </label>
          </div>
          <div className="content-health-list">
            {findingControls.rows.map((finding) => <FindingRow key={`${finding.id}-${finding.kind}-${finding.slug}`} finding={finding} />)}
          </div>
          {findingControls.filteredCount === 0 && (
            <div className="empty-state content-health-filter-empty">
              <ShieldCheck size={24} />
              <strong>No matching findings.</strong>
              <span>Adjust the search text or filters to widen the triage queue.</span>
            </div>
          )}
        </section>
      )}

      {data?.summary.latestTs && (
        <div className="content-health-footer">
          <CheckCircle2 size={14} />
          Last detector evidence: {new Date(data.summary.latestTs).toLocaleString()}
        </div>
      )}
    </div>
  );
}
