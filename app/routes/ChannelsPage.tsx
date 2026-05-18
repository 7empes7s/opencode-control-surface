import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { useAuthenticatedApi } from "../hooks/useAuthenticatedApi";
import { SectionCard } from "../components/SectionCard";
import { authFetch } from "../lib/authFetch";
import type { ChannelLogRow, NotificationRuleRow } from "../../server/db/writer";

interface ChannelsData {
  entries: ChannelLogRow[];
  degraded: boolean;
  reason?: string;
}

interface NotificationRulesData {
  rules: NotificationRuleRow[];
  degraded: boolean;
  reason?: string;
}

interface RuleDraft {
  id?: number;
  kind: string;
  enabled: boolean;
  thresholdText: string;
  channelsText: string;
  dirty?: boolean;
}

interface BriefActionResult {
  ok?: boolean;
  message?: string;
  preview?: unknown;
  output?: string;
  error?: string;
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function summarizePayload(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function ruleKey(rule: Pick<NotificationRuleRow, "id" | "kind">): string {
  return rule.id !== undefined ? `id:${rule.id}` : `kind:${rule.kind}`;
}

function parseChannelsList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function toDraft(rule: NotificationRuleRow): RuleDraft {
  const channels = Array.isArray(rule.channels)
    ? rule.channels.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: rule.id,
    kind: rule.kind,
    enabled: rule.enabled,
    thresholdText: safeJson(rule.threshold) || "{}",
    channelsText: channels.join(", "),
    dirty: false,
  };
}

function Pill({ children, color = "gray" }: { children: React.ReactNode; color?: string }) {
  return <span className={`pill ${color}`}>{children}</span>;
}

function LogTable({ entries }: { entries: ChannelLogRow[] }) {
  if (entries.length === 0) {
    return <div className="loading-dim">no entries</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 180 }}>time</th>
            <th style={{ width: 100 }}>channel</th>
            <th style={{ width: 90 }}>direction</th>
            <th>summary</th>
            <th style={{ width: 260 }}>payload</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="mono dim">{fmtTs(entry.ts)}</td>
              <td className="mono">{entry.channel}</td>
              <td><Pill color={entry.direction === "out" ? "blue" : entry.direction === "in" ? "green" : "gray"}>{entry.direction}</Pill></td>
              <td>{entry.summary}</td>
              <td className="mono trunc" title={safeJson(entry.payload)}>{summarizePayload(entry.payload)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChannelsPage() {
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [savingSuccess, setSavingSuccess] = useState<string | null>(null);
  const [rulesDrafts, setRulesDrafts] = useState<Record<string, RuleDraft>>({});
  const [newRule, setNewRule] = useState<RuleDraft>({
    kind: "",
    enabled: true,
    thresholdText: "{}",
    channelsText: "telegram",
  });

  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [briefResult, setBriefResult] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [briefPreview, setBriefPreview] = useState<string>("");

  const { data: channelsData, loading: channelsLoading, error: channelsError, refresh: refreshChannels } =
    useAuthenticatedApi<ChannelsData>("/api/channels?limit=250", 20_000);
  const { data: rulesData, loading: rulesLoading, error: rulesError, refresh: refreshRules } =
    useAuthenticatedApi<NotificationRulesData>("/api/notifications/rules?limit=200", 20_000);

  const allEntries = channelsData?.entries ?? [];

  useEffect(() => {
    const next: Record<string, RuleDraft> = {};
    for (const rule of rulesData?.rules ?? []) {
      const key = ruleKey(rule);
      const existing = rulesDrafts[key];
      if (existing?.dirty) {
        next[key] = existing;
      } else {
        next[key] = toDraft(rule);
      }
    }
    setRulesDrafts(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesData?.rules]);

  const telegramEntries = useMemo(() => {
    return allEntries.filter((entry) => {
      const haystack = `${entry.channel} ${entry.summary}`.toLowerCase();
      return haystack.includes("telegram");
    });
  }, [allEntries]);

  const alertEntries = useMemo(() => {
    return allEntries.filter((entry) => {
      const haystack = `${entry.channel} ${entry.summary} ${safeJson(entry.payload)}`.toLowerCase();
      return haystack.includes("alert") || haystack.includes("notification") || haystack.includes("threshold");
    });
  }, [allEntries]);

  const briefEntries = useMemo(() => {
    return allEntries.filter((entry) => {
      const haystack = `${entry.channel} ${entry.summary} ${safeJson(entry.payload)}`.toLowerCase();
      return haystack.includes("brief") || haystack.includes("newsbites");
    });
  }, [allEntries]);

  const totalRules = rulesData?.rules.length ?? 0;

  async function upsertRule(draft: RuleDraft, key: string) {
    setSavingError(null);
    setSavingSuccess(null);
    if (!draft.kind.trim()) {
      setSavingError("rule kind is required");
      return;
    }

    let threshold: unknown = {};
    try {
      threshold = draft.thresholdText.trim() ? JSON.parse(draft.thresholdText) : {};
    } catch {
      setSavingError(`invalid threshold JSON for ${draft.kind}`);
      return;
    }

    const body = {
      id: draft.id,
      kind: draft.kind.trim(),
      enabled: draft.enabled,
      threshold,
      channels: parseChannelsList(draft.channelsText),
    };

    setSavingKey(key);
    try {
      const res = await authFetch("/api/notifications/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }

      setSavingSuccess(`saved ${draft.kind}`);
      setRulesDrafts((prev) => ({
        ...prev,
        [key]: { ...draft, dirty: false },
      }));
      refreshRules();
    } catch (error: unknown) {
      setSavingError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingKey(null);
    }
  }

  async function addNewRule() {
    const key = `new:${newRule.kind}`;
    await upsertRule(newRule, key);
    setNewRule({ kind: "", enabled: true, thresholdText: "{}", channelsText: "telegram" });
  }

  async function runBriefAction(mode: "preview" | "send") {
    setBriefError(null);
    setBriefResult(null);
    if (mode === "preview") setPreviewLoading(true);
    else setSendLoading(true);

    try {
      const endpoint = mode === "preview" ? "/api/channels/brief/preview" : "/api/channels/brief/send";
      const res = await authFetch(endpoint, { method: "POST" });
      const payload = await res.json().catch(() => ({})) as BriefActionResult;
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.message ?? payload.error ?? `HTTP ${res.status}`);
      }

      setBriefResult(payload.message ?? (mode === "preview" ? "preview generated" : "brief sent"));
      if (mode === "preview") {
        const previewText = payload.preview !== undefined
          ? safeJson(payload.preview)
          : payload.output ?? "";
        setBriefPreview(previewText);
      }
      refreshChannels();
    } catch (error: unknown) {
      setBriefError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mode === "preview") setPreviewLoading(false);
      else setSendLoading(false);
    }
  }

  if (channelsLoading && !channelsData) return <div className="loading-dim">loading...</div>;
  if (channelsError && !channelsData) return <div className="loading-dim error">error: {channelsError}</div>;

  return (
    <div className="dash-page">
      <div className="page-header">
        <div className="page-title">Channels</div>
        <div className="page-subtitle">Telegram activity, notification rules, and manual brief operations.</div>
        <div className="stat-row">
          <div className="stat-item"><div className="stat-val">{allEntries.length}</div><div className="stat-lbl">events loaded</div></div>
          <div className="stat-item"><div className="stat-val">{telegramEntries.length}</div><div className="stat-lbl">telegram</div></div>
          <div className="stat-item"><div className="stat-val">{alertEntries.length}</div><div className="stat-lbl">alerts</div></div>
          <div className="stat-item"><div className="stat-val">{briefEntries.length}</div><div className="stat-lbl">briefs</div></div>
          <div className="stat-item"><div className="stat-val">{totalRules}</div><div className="stat-lbl">rules</div></div>
        </div>
      </div>

      {(channelsData?.degraded || rulesData?.degraded) && (
        <div className="loading-dim error">
          degraded mode: {channelsData?.reason ?? rulesData?.reason ?? "unknown"}
        </div>
      )}

      <SectionCard
        title="Brief Actions"
        right={
          <button className="btn btn-sm btn-ghost" onClick={refreshChannels}>
            <RefreshCw size={13} /> refresh
          </button>
        }
      >
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          <div className="action-bar">
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => runBriefAction("preview")}
              disabled={previewLoading || sendLoading}
            >
              {previewLoading ? "previewing..." : "preview brief"}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => runBriefAction("send")}
              disabled={previewLoading || sendLoading}
            >
              {sendLoading ? "sending..." : "send brief now"}
            </button>
            {briefResult && <span className="pill green">{briefResult}</span>}
            {briefError && <span className="pill red">{briefError}</span>}
          </div>

          {briefPreview && (
            <div style={{ marginTop: 12 }}>
              <div className="w-label">latest preview</div>
              <pre className="audit-pre" style={{ maxHeight: 260 }}>{briefPreview}</pre>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Notification Rules"
        right={
          <button className="btn btn-sm btn-ghost" onClick={refreshRules} disabled={rulesLoading}>
            <RefreshCw size={13} /> refresh
          </button>
        }
      >
        <div className="section-card-body" style={{ padding: "12px 14px" }}>
          {rulesError && <div className="loading-dim error" style={{ marginBottom: 8 }}>{rulesError}</div>}
          {savingError && <div className="loading-dim error" style={{ marginBottom: 8 }}>{savingError}</div>}
          {savingSuccess && <div className="loading-dim" style={{ marginBottom: 8 }}>{savingSuccess}</div>}

          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 220 }}>kind</th>
                  <th style={{ width: 90 }}>enabled</th>
                  <th style={{ width: 260 }}>threshold JSON</th>
                  <th>channels (csv)</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {rulesData?.rules.map((rule) => {
                  const key = ruleKey(rule);
                  const draft = rulesDrafts[key] ?? toDraft(rule);
                  return (
                    <tr key={key}>
                      <td>
                        <input
                          className="audit-select"
                          style={{ width: "100%" }}
                          value={draft.kind}
                          onChange={(event) => {
                            const value = event.target.value;
                            setRulesDrafts((prev) => ({
                              ...prev,
                              [key]: { ...draft, kind: value, dirty: true },
                            }));
                          }}
                        />
                      </td>
                      <td>
                        <select
                          className="audit-select"
                          value={draft.enabled ? "true" : "false"}
                          onChange={(event) => {
                            const value = event.target.value === "true";
                            setRulesDrafts((prev) => ({
                              ...prev,
                              [key]: { ...draft, enabled: value, dirty: true },
                            }));
                          }}
                        >
                          <option value="true">on</option>
                          <option value="false">off</option>
                        </select>
                      </td>
                      <td>
                        <textarea
                          className="audit-select"
                          style={{ width: "100%", minHeight: 64, padding: "8px 10px", fontFamily: "var(--mono)", resize: "vertical" }}
                          value={draft.thresholdText}
                          onChange={(event) => {
                            const value = event.target.value;
                            setRulesDrafts((prev) => ({
                              ...prev,
                              [key]: { ...draft, thresholdText: value, dirty: true },
                            }));
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="audit-select"
                          style={{ width: "100%" }}
                          value={draft.channelsText}
                          onChange={(event) => {
                            const value = event.target.value;
                            setRulesDrafts((prev) => ({
                              ...prev,
                              [key]: { ...draft, channelsText: value, dirty: true },
                            }));
                          }}
                        />
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => upsertRule(draft, key)}
                          disabled={savingKey === key}
                          title="Save rule"
                        >
                          <Save size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {(rulesData?.rules.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={5} className="loading-dim">no rules configured</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="w-label" style={{ marginBottom: 6 }}>add rule</div>
          <div className="action-bar" style={{ alignItems: "stretch" }}>
            <input
              className="audit-select"
              style={{ minWidth: 220 }}
              placeholder="kind (e.g. queue.approval_backlog)"
              value={newRule.kind}
              onChange={(event) => setNewRule((prev) => ({ ...prev, kind: event.target.value }))}
            />
            <select
              className="audit-select"
              value={newRule.enabled ? "true" : "false"}
              onChange={(event) => setNewRule((prev) => ({ ...prev, enabled: event.target.value === "true" }))}
            >
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
            <input
              className="audit-select"
              style={{ minWidth: 200 }}
              placeholder='threshold JSON (e.g. {"count":3})'
              value={newRule.thresholdText}
              onChange={(event) => setNewRule((prev) => ({ ...prev, thresholdText: event.target.value }))}
            />
            <input
              className="audit-select"
              style={{ minWidth: 200 }}
              placeholder="channels csv"
              value={newRule.channelsText}
              onChange={(event) => setNewRule((prev) => ({ ...prev, channelsText: event.target.value }))}
            />
            <button className="btn btn-sm btn-primary" onClick={addNewRule} disabled={savingKey === `new:${newRule.kind}`}>
              add rule
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Telegram Activity Log" right={<span className="mono dim">{telegramEntries.length} rows</span>}>
        <div className="section-card-body">
          <LogTable entries={telegramEntries} />
        </div>
      </SectionCard>

      <SectionCard title="Alert Log" right={<span className="mono dim">{alertEntries.length} rows</span>} defaultOpen={false}>
        <div className="section-card-body">
          <LogTable entries={alertEntries} />
        </div>
      </SectionCard>

      <SectionCard title="Brief History" right={<span className="mono dim">{briefEntries.length} rows</span>} defaultOpen={false}>
        <div className="section-card-body">
          <LogTable entries={briefEntries} />
        </div>
      </SectionCard>
    </div>
  );
}
