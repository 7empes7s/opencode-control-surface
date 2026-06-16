import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useApi } from "../hooks/useApi";
import { authFetch } from "../lib/authFetch";
import { ConfirmModal } from "../components/ConfirmModal";
import { SectionCard } from "../components/SectionCard";
import { useTableControls } from "../hooks/useTableControls";
import { TableControls } from "../components/TableControls";
import type { NewsBitesDetail } from "../../server/api/types";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function statusColor(s: string) {
  if (s === "published") return "green";
  if (s === "approved") return "blue";
  return "gray";
}

// ── Change Picture Modal ────────────────────────────────────────────────────

type PicMode = "search" | "upload";
interface PicResult { coverImage: string; photographer?: string; sourceUrl?: string; query?: string }

function ChangePicModal({
  slug, title,
  onClose, onDone,
}: { slug: string; title: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<PicMode>("search");
  const [keywords, setKeywords] = useState(title);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PicResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");

  const tabBtn = (m: PicMode, label: string) => (
    <button
      onClick={() => { setMode(m); setError(null); setResult(null); }}
      style={{
        fontFamily: "var(--mono)", fontSize: 11, padding: "6px 16px",
        background: "none", border: "none", cursor: "pointer",
        borderBottom: mode === m ? "2px solid var(--accent)" : "2px solid transparent",
        color: mode === m ? "var(--accent)" : "var(--text-dim)",
      }}
    >{label}</button>
  );

  const doSearch = async () => {
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await authFetch(`/api/newsbites/articles/${encodeURIComponent(slug)}/refresh-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: keywords.trim() }),
      });
      const json = await res.json() as PicResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  const doUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Select an image file first"); return; }
    setLoading(true); setError(null); setResult(null);
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await authFetch(`/api/newsbites/articles/${encodeURIComponent(slug)}/upload-image`, {
        method: "POST",
        body: form,
      });
      const json = await res.json() as PicResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResult(json);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, width: 480, maxWidth: "95vw" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-bright)" }}>Change cover image</div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: "8px 16px 4px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{slug}</div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 12px" }}>
          {tabBtn("search", "Search Pexels")}
          {tabBtn("upload", "Upload custom")}
        </div>

        <div style={{ padding: "16px" }}>
          {mode === "search" && (
            <>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>Search keywords</div>
              <input
                className="form-input"
                style={{ width: "100%", marginBottom: 12, boxSizing: "border-box" }}
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. basketball playoffs crowd"
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
              />
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginBottom: 12 }}>
                Will avoid the current image. Leave as-is to use the article title as the query.
              </div>
              {result && (
                <div style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, marginBottom: 12, fontFamily: "var(--mono)", fontSize: 11 }}>
                  <div style={{ color: "var(--accent)", marginBottom: 4 }}>✓ Image updated</div>
                  {result.photographer && <div className="dim">Photo: {result.photographer}</div>}
                  {result.query && <div className="dim">Query: {result.query}</div>}
                </div>
              )}
              {error && <div style={{ color: "var(--red)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 12 }}>{error}</div>}
              <div className="action-bar">
                <button className="btn btn-primary" onClick={doSearch} disabled={loading || !keywords.trim()}>
                  {loading ? "Searching…" : "Find new image"}
                </button>
                <button className="btn btn-ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}

          {mode === "upload" && (
            <>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>Image file (jpg, png, webp — max 10 MB)</div>
              <div
                style={{ border: "1px dashed var(--border)", borderRadius: 4, padding: "20px", textAlign: "center", marginBottom: 12, cursor: "pointer", color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 11 }}
                onClick={() => fileRef.current?.click()}
              >
                {fileName || "Click to select image file"}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
              />
              {result && (
                <div style={{ padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 3, marginBottom: 12, fontFamily: "var(--mono)", fontSize: 11 }}>
                  <div style={{ color: "var(--accent)" }}>✓ Custom image uploaded</div>
                </div>
              )}
              {error && <div style={{ color: "var(--red)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 12 }}>{error}</div>}
              <div className="action-bar">
                <button className="btn btn-primary" onClick={doUpload} disabled={loading || !fileName}>
                  {loading ? "Uploading…" : "Upload image"}
                </button>
                <button className="btn btn-ghost" onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function NewsBitesPage() {
  const { data, loading, error, refresh } = useApi<NewsBitesDetail>("/api/newsbites", 30_000);
  const [, navigate] = useLocation();
  const [filterStatus, setFilterStatus] = useState("");
  const [filterVertical, setFilterVertical] = useState("");
  const [deployModal, setDeployModal] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<{ status: string; output: string } | null>(null);

  // Article actions
  const [killSlug, setKillSlug] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [picSlug, setPicSlug] = useState<{ slug: string; title: string } | null>(null);

  useEffect(() => {
    if (!jobId) return;
    if (jobStatus?.status === "success" || jobStatus?.status === "failed") return;
    const poll = setInterval(async () => {
      const res = await authFetch(`/api/newsbites/deploy/${jobId}`);
      const json = await res.json() as { status: string; output: string };
      setJobStatus(json);
      if (json.status === "success" || json.status === "failed") clearInterval(poll);
    }, 2_000);
    return () => clearInterval(poll);
  }, [jobId, jobStatus?.status]);

  const articles = data?.articles ?? [];
  const dropdownFiltered = articles.filter((a) => {
    if (filterStatus && a.status !== filterStatus) return false;
    if (filterVertical && a.vertical !== filterVertical) return false;
    return true;
  });

  type ArticleSortKey = "title" | "vertical" | "date" | "status" | "wordCount";
  const articlesCtrl = useTableControls<typeof articles[0], ArticleSortKey>({
    rows: dropdownFiltered,
    defaultSort: { key: "date", dir: "desc" },
    filterText: (a) => [a.title, a.slug, a.vertical, a.status],
    sortValue: (a, key) => {
      if (key === "title") return a.title;
      if (key === "vertical") return a.vertical;
      if (key === "date") return a.date;
      if (key === "status") return a.status;
      if (key === "wordCount") return a.wordCount;
      return null;
    },
  });

  if (loading && !data) return <div className="loading-dim">loading…</div>;
  if (error && !data) return <div className="loading-dim error">error: {error}</div>;
  if (!data) return null;

  const d = data;
  const s = d.stats;
  const statuses = [...new Set(d.articles.map((a) => a.status).filter(Boolean))].sort();
  const verticals = [...new Set(d.articles.map((a) => a.vertical).filter(Boolean))].sort();
  const last30dTotal = s.publishedLast30d.reduce((acc, x) => acc + x.count, 0);

  const handleKill = async () => {
    if (!killSlug) return;
    setKilling(true); setKillError(null);
    try {
      const res = await authFetch(`/api/newsbites/articles/${encodeURIComponent(killSlug)}`, { method: "DELETE" });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setKillSlug(null);
      refresh();
    } catch (e) {
      setKillError(e instanceof Error ? e.message : String(e));
    } finally { setKilling(false); }
  };

  const handleInspect = async (slug: string) => {
    const res = await authFetch(`/api/newsbites/articles/${encodeURIComponent(slug)}/dossier-path`);
    const json = await res.json() as { date: string | null; slug: string };
    if (json.date) {
      navigate(`/autopipeline/dossier/${json.date}/${json.slug}`);
    } else {
      alert("No dossier found for this article.");
    }
  };

  return (
    <div className="dash-page">
      {/* Kill modal */}
      {killSlug && (
        <ConfirmModal
          title="Delete article?"
          message={`Permanently deletes "${killSlug}" from disk and removes its cover image. The NewsBites service will restart.`}
          confirmLabel="Delete"
          danger
          loading={killing}
          error={killError}
          onCancel={() => { setKillSlug(null); setKillError(null); }}
          onConfirm={handleKill}
        />
      )}

      {/* Change picture modal */}
      {picSlug && (
        <ChangePicModal
          slug={picSlug.slug}
          title={picSlug.title}
          onClose={() => setPicSlug(null)}
          onDone={() => { setPicSlug(null); refresh(); }}
        />
      )}

      {/* Deploy modal */}
      {deployModal && (
        <ConfirmModal
          title="Deploy NewsBites?"
          message="Runs ./deploy.sh — npm install + build + restart. Takes ~15 seconds."
          confirmLabel="Deploy"
          loading={deploying}
          error={deployError}
          onCancel={() => { setDeployModal(false); setDeployError(null); }}
          onConfirm={async () => {
            setDeploying(true); setDeployError(null);
            try {
              const res = await authFetch("/api/newsbites/deploy", { method: "POST", headers: { "Content-Type": "application/json" } });
              const json = await res.json() as { jobId?: string; error?: string };
              if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
              if (json.jobId) { setJobId(json.jobId); setJobStatus(null); }
              setDeployModal(false);
            } catch (e) {
              setDeployError(e instanceof Error ? e.message : String(e));
            } finally { setDeploying(false); }
          }}
        />
      )}

      <div className="page-header">
        <div className="page-title">NewsBites</div>
        <div className="stat-row">
          <div className="stat-item"><div className="stat-val">{s.totalPublished}</div><div className="stat-lbl">published</div></div>
          <div className="stat-item"><div className="stat-val">{s.totalApproved}</div><div className="stat-lbl">approved</div></div>
          <div className="stat-item"><div className="stat-val">{s.totalDraft}</div><div className="stat-lbl">draft/other</div></div>
          <div className="stat-item"><div className="stat-val">{s.publishedToday}</div><div className="stat-lbl">today</div></div>
          <div className="stat-item"><div className="stat-val">{last30dTotal}</div><div className="stat-lbl">last 30d</div></div>
          <div className="stat-item">
            <div className="stat-lbl">site</div>
            <Pill color={d.deploy.siteReachable ? "green" : "red"}>{d.deploy.siteReachable ? "up" : "down"}</Pill>
          </div>
        </div>
      </div>

      {/* Deploy info */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", padding: "8px 12px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4 }}>
          {d.deploy.lastDeployAt
            ? <>last deploy: <span style={{ color: "var(--text)" }}>{d.deploy.lastDeployAt}</span>
              {d.deploy.lastCommitHash && <> · commit <span style={{ color: "var(--text-dim)" }}>{d.deploy.lastCommitHash.slice(0, 8)}</span></>}
            </>
            : "deploy info unavailable"}
        </div>
        <button className="btn btn-primary" onClick={() => setDeployModal(true)}>Deploy</button>
      </div>

      {jobId && jobStatus && (
        <div style={{ marginBottom: 16, padding: "10px 12px", background: "var(--bg-panel)", border: `1px solid ${jobStatus.status === "success" ? "var(--accent-dim)" : jobStatus.status === "failed" ? "rgba(248,113,113,0.3)" : "var(--border)"}`, borderRadius: 4 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, marginBottom: 6 }}>
            deploy job {jobId}: <span style={{ color: jobStatus.status === "success" ? "var(--accent)" : jobStatus.status === "failed" ? "var(--red)" : "var(--amber)" }}>{jobStatus.status}</span>
          </div>
          {jobStatus.output && (
            <pre style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{jobStatus.output.slice(-2000)}</pre>
          )}
        </div>
      )}

      {/* Vertical mix */}
      <SectionCard title="vertical mix (published)" id="by-vertical" defaultOpen={false}>
        <div className="section-card-body" style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {s.verticalMix.map((v) => (
            <span key={v.vertical} className="pill gray" style={{ cursor: "pointer" }}
              onClick={() => setFilterVertical(filterVertical === v.vertical ? "" : v.vertical)}>
              {v.vertical} {v.count}
            </span>
          ))}
        </div>
      </SectionCard>

      {/* Publish rate */}
      <SectionCard
        title="publish rate · last 30 days"
        id="publish-rate"
        defaultOpen={false}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{last30dTotal} articles</span>}
      >
        <div className="section-card-body" style={{ padding: "10px 14px" }}>
          <ResponsiveContainer width="100%" height={80}>
            <BarChart data={s.publishedLast30d} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" tick={false} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip
                contentStyle={{ background: "#111", border: "1px solid #222", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 11 }}
                labelStyle={{ color: "#999" }}
                itemStyle={{ color: "#4ade80" }}
                formatter={(v: number) => [v, "articles"]}
              />
              <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={18}>
                {s.publishedLast30d.map((entry) => (
                  <Cell key={entry.date} fill={entry.count > 0 ? "#4ade80" : "#222"} opacity={entry.count > 0 ? 0.75 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
            {s.publishedLast30d[0]?.date} → {s.publishedLast30d[s.publishedLast30d.length - 1]?.date}
          </div>
        </div>
      </SectionCard>

      {/* Articles table */}
      <SectionCard
        title="articles"
        defaultOpen={true}
        right={
          <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
            {articlesCtrl.controlsProps.filteredRows} of {d.articles.length}
          </span>
        }
      >
        <div className="section-card-body table-wrap">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <TableControls {...articlesCtrl.controlsProps} searchPlaceholder="Search articles…" />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "6px 9px", borderRadius: 3 }}
            >
              <option value="">all status</option>
              {statuses.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
            <select
              value={filterVertical}
              onChange={(e) => setFilterVertical(e.target.value)}
              style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text)", padding: "6px 9px", borderRadius: 3 }}
            >
              <option value="">all verticals</option>
              {verticals.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            {(filterStatus || filterVertical) && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setFilterStatus(""); setFilterVertical(""); }}>Clear</button>
            )}
          </div>

          {articlesCtrl.rows.length === 0 ? (
            <div className="loading-dim">no articles match filters</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th {...articlesCtrl.sortHeaderProps("title")}>title <span className="sortable-th-arrow">{articlesCtrl.sort.key === "title" ? (articlesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...articlesCtrl.sortHeaderProps("vertical")}>vertical <span className="sortable-th-arrow">{articlesCtrl.sort.key === "vertical" ? (articlesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...articlesCtrl.sortHeaderProps("date")}>date <span className="sortable-th-arrow">{articlesCtrl.sort.key === "date" ? (articlesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...articlesCtrl.sortHeaderProps("status")}>status <span className="sortable-th-arrow">{articlesCtrl.sort.key === "status" ? (articlesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th {...articlesCtrl.sortHeaderProps("wordCount")}>~words <span className="sortable-th-arrow">{articlesCtrl.sort.key === "wordCount" ? (articlesCtrl.sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span></th>
                  <th style={{ width: 160 }}>actions</th>
                </tr>
              </thead>
              <tbody>
                {articlesCtrl.rows.map((a) => (
                  <tr key={a.slug}>
                    <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <a href={`https://news.techinsiderbytes.com/articles/${a.slug}`}
                        target="_blank" rel="noreferrer"
                        style={{ color: "var(--text)", textDecoration: "none" }}
                        onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
                        onMouseOut={(e) => (e.currentTarget.style.color = "var(--text)")}>
                        {a.title || a.slug}
                      </a>
                    </td>
                    <td className="mono dim">{a.vertical}</td>
                    <td className="mono dim">{a.date}</td>
                    <td><Pill color={statusColor(a.status)}>{a.status}</Pill></td>
                    <td className="mono dim">{a.wordCount > 0 ? `~${a.wordCount}` : "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          className="btn btn-sm btn-ghost"
                          title="Inspect dossier"
                          onClick={() => handleInspect(a.slug)}
                        >inspect</button>
                        <button
                          className="btn btn-sm btn-ghost"
                          title="Replace cover image"
                          onClick={() => setPicSlug({ slug: a.slug, title: a.title || a.slug })}
                        >pic</button>
                        <button
                          className="btn btn-sm btn-danger"
                          title="Permanently delete article"
                          onClick={() => setKillSlug(a.slug)}
                        >kill</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
