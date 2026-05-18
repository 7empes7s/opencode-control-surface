import { useState, useEffect } from "react";
import { FileBrowser } from "../components/FileBrowser";
import { authFetch } from "../lib/authFetch";

type Step = 1 | 2 | 3 | 4;

const STORAGE_KEY_STEP = "tib-install-wizard-step";
const STORAGE_KEY_DONE = "tib-install-wizard-done";

export function InstallWizardPage() {
  const [step, setStep] = useState<Step>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_STEP);
    return saved ? (parseInt(saved) as Step) : 1;
  });
  const [done, setDone] = useState(() => localStorage.getItem(STORAGE_KEY_DONE) === "true");
  const [token, setToken] = useState("");
  const [modelProvider, setModelProvider] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (done) {
      window.location.href = "/";
    }
  }, [done]);

  function saveStep(s: Step) {
    setStep(s);
    localStorage.setItem(STORAGE_KEY_STEP, String(s));
  }

  async function handleTokenNext() {
    if (!token.trim()) return;
    setSaving(true);
    try {
      await authFetch("/api/settings/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_token_set: "true" }),
      });
      saveStep(2);
    } finally {
      setSaving(false);
    }
  }

  async function handleProviderNext() {
    saveStep(3);
  }

  async function handleDetectProject() {
    setDetecting(true);
    try {
      const res = await authFetch("/api/projects/detect", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setProjectPath(data.path ?? "");
      }
    } finally {
      setDetecting(false);
    }
  }

  async function handleProjectNext() {
    setSaving(true);
    try {
      if (projectPath.trim()) {
        await authFetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: projectPath }),
        });
      }
      localStorage.setItem(STORAGE_KEY_DONE, "true");
      setDone(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-2xl font-semibold text-[var(--text-bright)] mb-6">Setup Wizard</h1>

      <div className="flex items-center gap-2 mb-8 text-sm">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
              step === s ? "bg-amber-500 text-black" : step > s ? "bg-green-600 text-white" : "bg-[var(--bg-hover)] text-[var(--text-muted)]"
            }`}>
              {step > s ? "✓" : s}
            </div>
            <div className="text-[var(--text-muted)] hidden sm:block">
              {s === 1 ? "Token" : s === 2 ? "Provider" : s === 3 ? "Project" : "Done"}
            </div>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="w-card space-y-4">
          <div className="text-sm font-medium text-[var(--text-secondary)]">Step 1 — Operator Token</div>
          <p className="text-sm text-[var(--text-muted)]">
            Enter your operator token to secure administrative endpoints.
          </p>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="operator-token"
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500"
          />
          <button
            onClick={handleTokenNext}
            disabled={saving || !token.trim()}
            className="px-4 py-2 text-black font-medium rounded text-sm disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {saving ? "Saving…" : "Next →"}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="w-card space-y-4">
          <div className="text-sm font-medium text-[var(--text-secondary)]">Step 2 — Model Provider</div>
          <div className="flex gap-2">
            {["openrouter", "litellm", "ollama"].map(p => (
              <button
                key={p}
                onClick={() => setModelProvider(p)}
                className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                  modelProvider === p ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-[var(--border)] text-[var(--text-muted)]"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {modelProvider !== "ollama" && (
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={modelProvider === "openrouter" ? "OpenRouter API Key" : "LiteLLM API Key"}
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500"
            />
          )}
          {modelProvider === "ollama" && (
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500"
            />
          )}
          <button
            onClick={handleProviderNext}
            className="px-4 py-2 text-black font-medium rounded text-sm"
            style={{ background: "var(--accent)" }}
          >
            Next →
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="w-card space-y-4">
          <div className="text-sm font-medium text-[var(--text-secondary)]">Step 3 — First Project</div>
          <p className="text-sm text-[var(--text-muted)]">
            Detect a local repository or enter the path manually.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDetectProject}
              disabled={detecting}
              className="px-3 py-1.5 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-sm"
            >
              {detecting ? "Detecting…" : "Auto-detect"}
            </button>
          </div>
          <FileBrowser
            value={projectPath}
            onChange={(path) => setProjectPath(path)}
            type="directory"
            placeholder="/opt/my-project"
          />
          <button
            onClick={handleProjectNext}
            disabled={saving}
            className="px-4 py-2 text-black font-medium rounded text-sm disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            {saving ? "Saving…" : "Finish Setup"}
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="w-card space-y-4">
          <div className="text-sm font-medium text-[var(--text-secondary)]">Setup Complete</div>
          <div style={{ color: "var(--green)" }}>✓ All steps completed successfully.</div>
          <div className="flex gap-4 text-sm">
            <a href="/builder" className="underline hover:text-amber-300">Go to Builder</a>
            <a href="/projects" className="underline hover:text-amber-300">View Projects</a>
          </div>
        </div>
      )}
    </div>
  );
}