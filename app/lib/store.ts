import { create } from "zustand";
import { authFetch } from "./authFetch";

const API = "/opencode-api";

// ── Types ──────────────────────────────────────────────────────────────────

export type Session = {
  id: string;
  slug: string;
  title: string;
  projectID: string;
  directory: string;
  version: string;
  time: { created: number; updated: number };
};

export type Part =
  | { id: string; messageID: string; sessionID: string; type: "text"; text: string }
  | { id: string; messageID: string; sessionID: string; type: "reasoning"; text: string }
  | { id: string; messageID: string; sessionID: string; type: "tool"; callID: string; tool: string; state: ToolState }
  | { id: string; messageID: string; sessionID: string; type: "step-start" }
  | { id: string; messageID: string; sessionID: string; type: "step-finish"; tokens?: unknown; cost?: number }
  | { id: string; messageID: string; sessionID: string; type: "patch"; files: string[] }
  | { id: string; messageID: string; sessionID: string; type: string; [k: string]: unknown };

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; time: { start: number } }
  | { status: "completed"; input: Record<string, unknown>; output: string; title: string; time: { start: number; end: number } }
  | { status: "error"; input: Record<string, unknown>; error: string };

export type Message = {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time: { created: number; completed?: number };
    modelID?: string;
    providerID?: string;
    error?: unknown;
  };
  parts: Part[];
};

export type Permission = {
  id: string;
  sessionID: string;
  createdAt?: number;
  permission?: string;
  patterns?: string[];
  metadata: { message?: string; title?: string; [k: string]: unknown };
};

export type ProviderModel = {
  id: string;
  providerID: string;
  name: string;
  capabilities?: {
    input?: { text?: boolean; image?: boolean; audio?: boolean; pdf?: boolean };
    attachment?: boolean;
  };
};

export type Provider = {
  id: string;
  name: string;
  models: Record<string, ProviderModel>;
};

export type Attachment = {
  id: string;
  filename: string;
  mime: string;
  url: string;
  size: number;
  kind: "image" | "file";
};

// ── Store ──────────────────────────────────────────────────────────────────

interface State {
  ready: boolean;
  serverStatus: "available" | "unavailable";
  serverVersion: string | null;
  serverUrl: string;
  error: string | null;
  sessions: Session[];
  activeSession: Session | null;
  messages: Message[];
  parts: Record<string, Part>;
  messageOrder: string[];
  messageParts: Record<string, string[]>;
  running: boolean;
  isStreaming: boolean;
  permission: Permission | null;

  providers: Provider[];
  currentModel: string | null;

  init: () => Promise<void>;
  connect: (url?: string, username?: string, password?: string) => Promise<void>;
  disconnect: () => void;
  setActiveSession: (session: Session | null) => void;
  selectSession: (session: Session) => Promise<void>;
  createSession: (opts?: { directory?: string; title?: string }) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (content: string, attachments?: Attachment[]) => Promise<void>;
  abortSession: () => Promise<void>;
  replyPermission: (id: string, action: "allow" | "deny") => Promise<void>;
  loadProviders: () => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
}

let sse: EventSource | null = null;

function startSSE(dispatch: (event: MessageEvent) => void) {
  if (sse) { sse.close(); sse = null; }
  sse = new EventSource(`${API}/event`);
  sse.onmessage = dispatch;
  sse.onerror = () => {
    setTimeout(() => {
      if (sse) { sse.close(); sse = null; }
      startSSE(dispatch);
    }, 3000);
  };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPostJsonOk(path: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await authFetch(`${API}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return false;
  await res.json().catch(() => null);
  return true;
}

export const useStore = create<State>((set, get) => {
  function handleSSE(event: MessageEvent) {
    let ev: { type: string; properties: Record<string, unknown> };
    try { ev = JSON.parse(event.data); }
    catch { return; }

    const { activeSession } = get();

    switch (ev.type) {
      case "message.part.updated": {
        const part = ev.properties.part as Part;
        const delta = ev.properties.delta as string | undefined;
        if (!activeSession || part.sessionID !== activeSession.id) return;

        set((s) => {
          const existing = s.parts[part.id];
          let updated: Part;
          if (part.type === "text" && delta && existing?.type === "text") {
            updated = { ...existing, text: (existing as { type: "text"; text: string }).text + delta };
          } else {
            updated = part;
          }
          const newParts = { ...s.parts, [part.id]: updated };
          const msgId = part.messageID;
          const existingIds = s.messageParts[msgId] ?? [];
          const newIds = existingIds.includes(part.id) ? existingIds : [...existingIds, part.id];
          return { parts: newParts, messageParts: { ...s.messageParts, [msgId]: newIds } };
        });
        break;
      }

      case "message.updated": {
        const info = ev.properties.info as Message["info"];
        if (!activeSession || info.sessionID !== activeSession.id) return;
        set((s) => {
          const idx = s.messages.findIndex((m) => m.info.id === info.id);
          if (idx >= 0) {
            const updated = [...s.messages];
            updated[idx] = { ...updated[idx], info };
            return { messages: updated };
          }
          const newOrder = s.messageOrder.includes(info.id)
            ? s.messageOrder : [...s.messageOrder, info.id];
          return { messages: [...s.messages, { info, parts: [] }], messageOrder: newOrder };
        });
        break;
      }

      case "session.idle": {
        const sid = (ev.properties as { sessionID: string }).sessionID;
        if (!activeSession || sid !== activeSession.id) return;
        set({ running: false, isStreaming: false });
        apiFetch<Session[]>("/session").then((sessions) => set({ sessions })).catch(() => {});
        break;
      }

      case "session.status": {
        const sid = (ev.properties as { sessionID: string }).sessionID;
        if (!activeSession || sid !== activeSession.id) return;
        const status = (ev.properties as { status: string }).status;
        set({ running: status === "running", isStreaming: status === "running" });
        break;
      }

      case "permission.updated":
      case "permission.asked": {
        const perm = ev.properties as unknown as Permission;
        if (!activeSession || perm.sessionID !== activeSession.id) return;
        set({ permission: perm });
        break;
      }

      case "permission.replied": {
        set({ permission: null });
        break;
      }
    }
  }

  return {
    ready: false,
    serverStatus: "unavailable",
    serverVersion: null,
    serverUrl: API,
    error: null,
    sessions: [],
    activeSession: null,
    messages: [],
    parts: {},
    messageOrder: [],
    messageParts: {},
    running: false,
    isStreaming: false,
    permission: null,
    providers: [],
    currentModel: null,

    init: async () => {
      try {
        startSSE(handleSSE);
        const sessions = await apiFetch<Session[]>("/session");
        set({ sessions, ready: true, serverStatus: "available", error: null });
        get().loadProviders().catch(() => {});
      } catch (e) {
        set({
          ready: false,
          serverStatus: "unavailable",
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },

    connect: async (url?: string) => {
      if (url) set({ serverUrl: url });
      await get().init();
    },

    disconnect: () => {
      if (sse) { sse.close(); sse = null; }
      set({
        ready: false,
        serverStatus: "unavailable",
        activeSession: null,
        sessions: [],
        messages: [],
        parts: {},
        messageOrder: [],
        messageParts: {},
        running: false,
        isStreaming: false,
        permission: null,
      });
    },

    setActiveSession: (session) => {
      set({ activeSession: session });
    },

    selectSession: async (session: Session) => {
      set({
        activeSession: session,
        messages: [],
        parts: {},
        messageOrder: [],
        messageParts: {},
        running: false,
        isStreaming: false,
        permission: null,
      });
      type RawMsg = { info: Message["info"]; parts: Part[] };
      const raw = await apiFetch<RawMsg[]>(`/session/${session.id}/message`);
      const parts: Record<string, Part> = {};
      const messageParts: Record<string, string[]> = {};
      const messageOrder: string[] = [];
      for (const msg of raw) {
        messageOrder.push(msg.info.id);
        messageParts[msg.info.id] = msg.parts.map((p) => p.id);
        for (const p of msg.parts) parts[p.id] = p;
      }
      set({ messages: raw, parts, messageParts, messageOrder });
    },

    createSession: async (opts) => {
      const body: Record<string, unknown> = {};
      if (opts?.directory) body.directory = opts.directory;
      if (opts?.title) body.title = opts.title;
      const session = await apiFetch<Session>("/session", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const sessions = await apiFetch<Session[]>("/session");
      set({ sessions });
      await get().selectSession(session);
      return session;
    },

    deleteSession: async (id: string) => {
      await apiFetch(`/session/${id}`, { method: "DELETE" });
      const sessions = await apiFetch<Session[]>("/session");
      const { activeSession } = get();
      if (activeSession?.id === id) {
        set({ sessions, activeSession: null, messages: [], parts: {}, messageOrder: [], messageParts: {} });
      } else {
        set({ sessions });
      }
    },

    sendMessage: async (content: string, attachments) => {
      const { activeSession } = get();
      if (!activeSession) return;
      set({ running: true, isStreaming: true });
      const parts: Array<Record<string, unknown>> = [];
      if (content.trim()) parts.push({ type: "text", text: content });
      for (const a of attachments ?? []) {
        parts.push({
          type: "file",
          mime: a.mime,
          filename: a.filename,
          url: a.url,
        });
      }
      await apiFetch(`/session/${activeSession.id}/message`, {
        method: "POST",
        body: JSON.stringify({ parts }),
      });
    },

    abortSession: async () => {
      const { activeSession } = get();
      if (activeSession) {
        await apiFetch(`/session/${activeSession.id}/abort`, { method: "POST" }).catch(() => null);
      }
      set({ running: false, isStreaming: false });
    },

    replyPermission: async (id: string, action: "allow" | "deny") => {
      const { activeSession } = get();
      if (!activeSession) return;

      const reply = action === "allow" ? "once" : "reject";
      const ok =
        await apiPostJsonOk(`/permission/${id}/reply`, { reply }) ||
        await apiPostJsonOk(`/session/${activeSession.id}/permissions/${id}`, { response: reply }) ||
        await apiPostJsonOk(`/session/${activeSession.id}/permission/${id}`, { action });

      if (!ok) throw new Error("permission reply failed");
      set({ permission: null });
    },

    loadProviders: async () => {
      try {
        const cfg = await apiFetch<{ model?: string }>("/config");
        const provData = await apiFetch<{ providers: Provider[] }>("/config/providers");
        set({
          providers: provData.providers ?? [],
          currentModel: cfg.model ?? null,
        });
      } catch {
        set({ providers: [], currentModel: null });
      }
    },

    setModel: async (modelId: string) => {
      try {
        await apiFetch("/global/config", {
          method: "PATCH",
          body: JSON.stringify({ model: modelId }),
        });
        set({ currentModel: modelId });
      } catch (e) {
        console.error("setModel failed", e);
      }
    },
  };
});

export const useAppStore = useStore;
