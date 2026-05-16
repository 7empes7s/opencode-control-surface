import { useMemo, useState } from "react";
import { SectionCard } from "../components/SectionCard";
import type { ModelsDetail, WorkloadScores, RatingBreakdown } from "../../server/api/types";

type ModelRow = ModelsDetail["models"][number];

type PricingTier = "free-local" | "free-rate-limited" | "subscription" | "api-paid";

const TIER_LABEL: Record<PricingTier, string> = {
  "free-local": "free·local",
  "free-rate-limited": "free·rl",
  "subscription": "sub",
  "api-paid": "paid",
};

const TIER_COLOR: Record<PricingTier, string> = {
  "free-local": "var(--green)",
  "free-rate-limited": "var(--green)",
  "subscription": "var(--blue, #5b7ec9)",
  "api-paid": "var(--amber)",
};

function scoreBar(score: number | null) {
  if (score == null) return null;
  const pct = Math.min(100, Math.round(score));
  const color = score >= 80 ? "var(--green)" : score >= 60 ? "var(--accent)" : "var(--amber)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 6, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color, minWidth: 32, textAlign: "right" }}>
        {Number.isInteger(score) ? score : score.toFixed(1)}
      </span>
    </div>
  );
}

function BreakdownCard({ m }: { m: ModelRow }) {
  const r = (m as { ratingBreakdown?: RatingBreakdown | null }).ratingBreakdown;
  const ws = (m as { workloadScores?: WorkloadScores | null }).workloadScores;
  const r100 = (m as { rating100?: number | null }).rating100;
  const tier = ((m as { pricingTier?: string }).pricingTier ?? "subscription") as PricingTier;

  return (
    <div className="ratings-card">
      <div className="ratings-card-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div className="ratings-card-name">{m.logicalName.toUpperCase()}</div>
          {r && <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", marginLeft: 8 }}>{r.confidence}% conf.</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
          <span className={`pill ${m.capability === "heavy" ? "blue" : "gray"}`}>{m.capability}</span>
          <span className="pill" style={{ color: TIER_COLOR[tier], borderColor: TIER_COLOR[tier] }}>{TIER_LABEL[tier]}</span>
          {m.available
            ? <span className="pill green">up</span>
            : <span className="pill red">down</span>}
        </div>
      </div>

      <div className="ratings-card-score">
        {r100 != null ? (
          <>
            <span style={{ fontSize: 32, fontFamily: "var(--mono)", color: r100 >= 80 ? "var(--green)" : r100 >= 60 ? "var(--text)" : "var(--amber)", fontWeight: 700 }}>{r100}</span>
            <span style={{ fontSize: 14, color: "var(--text-dim)", marginLeft: 2 }}>/100</span>
          </>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 14 }}>no rating</span>
        )}
      </div>

      {r && Object.keys(r.components).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Breakdown</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {Object.entries(r.components).map(([key, c]) => (
                <tr key={key}>
                  <td style={{ color: "var(--text-dim)", fontSize: 11, paddingRight: 8, whiteSpace: "nowrap", paddingBottom: 4 }}>{key}</td>
                  <td style={{ width: "100%", paddingBottom: 4 }}>{scoreBar(c.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.missing.length > 0 && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>missing: {r.missing.join(", ")}</div>
          )}
        </div>
      )}

      {ws && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Workload</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {([["JSON", ws.json], ["Coding", ws.coding], ["Writing", ws.writing], ["Reasoning", ws.reasoning]] as [string, number | null][]).map(([label, score]) => (
                <tr key={label}>
                  <td style={{ color: "var(--text-dim)", fontSize: 11, paddingRight: 8, whiteSpace: "nowrap", paddingBottom: 4 }}>{label}</td>
                  <td style={{ width: "100%", paddingBottom: 4 }}>{scoreBar(score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ws.lastProbedAt && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
              probed {new Date(ws.lastProbedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
        <span style={{ color: "var(--text-dim)" }}>latency <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{m.latency != null ? `${m.latency}ms` : "—"}</span></span>
        <span className={`pill ${m.qualityStatus === "healthy" ? "green" : m.qualityStatus === "blocked" ? "red" : "amber"}`}>{m.qualityStatus}</span>
      </div>
    </div>
  );
}

export function RatingsSection({ models }: { models: ModelRow[] }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [capFilter, setCapFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"rating100" | "latency" | "quality">("rating100");

  const hasRatings = models.some(m => (m as { rating100?: number | null }).rating100 != null);

  const rankedModels = useMemo(() => {
    const filtered = models.filter(m => {
      if (capFilter !== "all" && m.capability !== capFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!m.logicalName.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortBy === "rating100") {
        const ra = (a as { rating100?: number | null }).rating100 ?? -1;
        const rb = (b as { rating100?: number | null }).rating100 ?? -1;
        return rb - ra;
      }
      if (sortBy === "latency") {
        return (a.latency ?? 999999) - (b.latency ?? 999999);
      }
      const qOrder: Record<string, number> = { healthy: 0, probation: 1, degraded: 2, blocked: 3, unknown: 4 };
      return (qOrder[a.qualityStatus] ?? 5) - (qOrder[b.qualityStatus] ?? 5);
    });
  }, [models, search, capFilter, sortBy]);

  const selectedModels = useMemo(
    () => selected.map(n => models.find(m => m.logicalName === n)).filter(Boolean) as ModelRow[],
    [models, selected],
  );

  const toggleSelect = (name: string) => {
    setSelected(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : prev.length >= 6 ? prev : [...prev, name],
    );
  };

  return (
    <>
      {!hasRatings && (
        <div style={{ background: "var(--surface-2, #1a1f2e)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px", marginBottom: 16, fontSize: 12, color: "var(--amber)" }}>
          No ratings yet — run a full model-health-check to populate workload scores and rating100.
          <br /><code style={{ fontSize: 11 }}>systemctl start model-health-check.service</code>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <input
          className="filter-input"
          type="search"
          placeholder="search models…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <select className="filter-select" value={capFilter} onChange={e => setCapFilter(e.target.value)}>
          <option value="all">all caps</option>
          <option value="heavy">heavy</option>
          <option value="medium">medium</option>
          <option value="light">light</option>
        </select>
        <select className="filter-select" value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
          <option value="rating100">sort: rating</option>
          <option value="latency">sort: latency</option>
          <option value="quality">sort: quality</option>
        </select>
        <span style={{ color: "var(--text-dim)", fontSize: 11, marginLeft: "auto" }}>
          {selected.length > 0 ? `${selected.length}/6 selected for comparison` : "click rows to compare (max 6)"}
        </span>
        {selected.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected([])}>clear</button>
        )}
      </div>

      {selectedModels.length > 0 && (
        <SectionCard title={`Comparing ${selectedModels.length} / 6 · ${selectedModels.map(m => m.logicalName).join(" · ")}`} defaultOpen={true}
          right={<button className="btn btn-sm btn-ghost" onClick={() => setSelected([])}>Clear</button>}
        >
          <div className="section-card-body">
            <div className="ratings-grid">
              {selectedModels.map(m => <BreakdownCard key={m.logicalName} m={m} />)}
            </div>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="ratings"
        defaultOpen={true}
        right={<span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{rankedModels.length} shown</span>}
      >
        <div className="section-card-body table-wrap">
          <table className="data-table ratings-table">
            <colgroup>
              <col className="rt-name-col" />
              <col className="rt-cap-col" />
              <col className="rt-rating-col" />
              <col className="rt-json-col" />
              <col className="rt-coding-col" />
              <col className="rt-writing-col" />
              <col className="rt-reasoning-col" />
              <col className="rt-latency-col" />
              <col className="rt-quality-col" />
              <col className="rt-pricing-col" />
              <col className="rt-conf-col" />
            </colgroup>
            <thead>
              <tr>
                <th>model</th>
                <th>cap</th>
                <th className="rt-rating-col" style={{ textAlign: "right" }}>rating</th>
                <th className="rt-json-col" style={{ textAlign: "right" }}>json</th>
                <th className="rt-coding-col" style={{ textAlign: "right" }}>coding</th>
                <th className="rt-writing-col" style={{ textAlign: "right" }}>writing</th>
                <th className="rt-reasoning-col" style={{ textAlign: "right" }}>reasoning</th>
                <th className="rt-latency-col" style={{ textAlign: "right" }}>latency</th>
                <th className="rt-quality-col">quality</th>
                <th className="rt-pricing-col">pricing</th>
                <th className="rt-conf-col">conf.</th>
              </tr>
            </thead>
            <tbody>
              {rankedModels.map(m => {
                const r100 = (m as { rating100?: number | null }).rating100;
                const bd = (m as { ratingBreakdown?: RatingBreakdown | null }).ratingBreakdown;
                const ws = (m as { workloadScores?: WorkloadScores | null }).workloadScores;
                const isSelected = selected.includes(m.logicalName);
                const tier = ((m as { pricingTier?: string }).pricingTier ?? "subscription") as PricingTier;
                return (
                  <tr
                    key={m.logicalName}
                    onClick={() => toggleSelect(m.logicalName)}
                    style={{ cursor: "pointer", background: isSelected ? "var(--surface-2, rgba(91,126,201,0.08))" : undefined }}
                  >
                    <td className="mono" style={{ color: m.available ? "var(--text-bright)" : "var(--text-dim)" }}>
                      {isSelected && <span style={{ color: "var(--accent)", marginRight: 6 }}>●</span>}
                      {m.logicalName}
                    </td>
                    <td><span className={`pill ${m.capability === "heavy" ? "blue" : "gray"}`}>{m.capability}</span></td>
                    <td className="rt-rating-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 12, color: r100 != null ? (r100 >= 80 ? "var(--green)" : r100 >= 60 ? "var(--text)" : "var(--amber)") : "var(--text-dim)" }}>
                      {r100 != null ? r100 : "—"}
                    </td>
                    <td className="rt-json-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{ws?.json ?? "—"}</td>
                    <td className="rt-coding-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{ws?.coding ?? "—"}</td>
                    <td className="rt-writing-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{ws?.writing ?? "—"}</td>
                    <td className="rt-reasoning-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{ws?.reasoning ?? "—"}</td>
                    <td className="rt-latency-col" style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{m.latency != null ? `${m.latency}ms` : "—"}</td>
                    <td className="rt-quality-col"><span className={`pill ${m.qualityStatus === "healthy" ? "green" : m.qualityStatus === "blocked" ? "red" : "amber"}`}>{m.qualityStatus}</span></td>
                    <td className="rt-pricing-col"><span style={{ fontSize: 11, color: TIER_COLOR[tier] }}>{TIER_LABEL[tier]}</span></td>
                    <td className="rt-conf-col" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>{bd ? `${bd.confidence}%` : "—"}</td>
                  </tr>
                );
              })}
              {rankedModels.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: "center", padding: 24, color: "var(--text-dim)" }}>no models match</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}
