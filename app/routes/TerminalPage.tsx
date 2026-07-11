import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  Bot,
  ChevronDown,
  Clipboard,
  Copy,
  Expand,
  Keyboard,
  Minimize2,
  RefreshCw,
  Search,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { authFetch } from "../lib/authFetch";

type ConnectionState = "authorizing" | "connecting" | "connected" | "reconnecting" | "offline";

type TerminalStatus = {
  host: string;
  user: string;
  cwd: string;
  shell: string;
  session: string;
  persistent: boolean;
  sessionActive: boolean;
  connectedClients: number;
  cliCommands: string[];
};

type ServerControlMessage = {
  type: "ready" | "pong" | "error" | "exit";
  connectionId?: string;
  session?: string;
  host?: string;
  persistent?: boolean;
  connectedClients?: number;
  id?: string;
  error?: string;
  exitCode?: number | null;
};

const RECONNECT_DELAYS = [600, 1_200, 2_500, 5_000, 10_000];
const FALLBACK_CLIS = ["codex", "opencode", "claude", "gemini", "aider"];

const SOFT_KEYS = [
  { label: "Esc", value: "\u001b", title: "Escape" },
  { label: "Tab", value: "\t", title: "Tab" },
  { label: "Ctrl C", value: "\u0003", title: "Interrupt the foreground command" },
  { label: "Ctrl D", value: "\u0004", title: "End input / exit shell" },
  { label: "↑", value: "\u001b[A", title: "Up" },
  { label: "↓", value: "\u001b[B", title: "Down" },
  { label: "←", value: "\u001b[D", title: "Left" },
  { label: "→", value: "\u001b[C", title: "Right" },
  { label: "|", value: "|", title: "Pipe" },
  { label: "/", value: "/", title: "Slash" },
  { label: "~", value: "~", title: "Tilde" },
  { label: "-", value: "-", title: "Dash" },
] as const;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminal/ws`;
}

function connectionLabel(state: ConnectionState): string {
  if (state === "connected") return "Connected";
  if (state === "authorizing") return "Authorizing";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "connecting") return "Connecting";
  return "Offline";
}

export function TerminalPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => undefined);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const retryRef = useRef(0);
  const pingStartedRef = useRef(new Map<string, number>());

  const [connection, setConnection] = useState<ConnectionState>("authorizing");
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);

  const sendInput = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "input", data }));
    terminalRef.current?.focus();
    return true;
  }, []);

  const showClipboardNote = useCallback((message: string) => {
    setClipboardNote(message);
    window.setTimeout(() => setClipboardNote(null), 1_600);
  }, []);

  const copySelection = useCallback(async () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) {
      showClipboardNote("Select terminal text first");
      terminalRef.current?.focus();
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      showClipboardNote("Copied");
      terminalRef.current?.clearSelection();
    } catch {
      showClipboardNote("Clipboard permission blocked");
    }
    terminalRef.current?.focus();
  }, [showClipboardNote]);

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      terminalRef.current?.paste(text);
      showClipboardNote("Pasted");
    } catch {
      showClipboardNote("Tap the terminal and use system Paste");
    }
    terminalRef.current?.focus();
  }, [showClipboardNote]);

  const fitTerminal = useCallback(() => {
    const page = pageRef.current;
    if (page) {
      const viewport = window.visualViewport;
      const top = page.getBoundingClientRect().top;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const available = viewportHeight - Math.max(0, top - viewportTop);
      page.style.setProperty("--terminal-page-height", `${Math.max(260, Math.floor(available))}px`);
    }
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const terminal = terminalRef.current;
        const socket = socketRef.current;
        if (terminal && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        }
      } catch { /* terminal is between layouts */ }
    });
  }, []);

  const toggleImmersive = useCallback(() => {
    setImmersive((current) => {
      const next = !current;
      document.body.classList.toggle("terminal-immersive", next);
      window.setTimeout(fitTerminal, 0);
      return next;
    });
  }, [fitTerminal]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    disposedRef.current = false;
    const terminal = new XTerm({
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      cursorWidth: 2,
      drawBoldTextInBrightColors: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: window.matchMedia("(max-width: 600px)").matches ? 12 : 13,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.18,
      macOptionIsMeta: true,
      minimumContrastRatio: 5,
      rightClickSelectsWord: true,
      scrollback: 20_000,
      scrollOnUserInput: true,
      smoothScrollDuration: 90,
      theme: {
        background: "#0c1015",
        foreground: "#d7dde5",
        cursor: "#f3ae38",
        cursorAccent: "#0c1015",
        selectionBackground: "#6f542f99",
        selectionInactiveBackground: "#33404f88",
        black: "#141a21",
        red: "#e16d75",
        green: "#81b88b",
        yellow: "#d7ae61",
        blue: "#78a5c9",
        magenta: "#b69acb",
        cyan: "#70b6b1",
        white: "#c6ced8",
        brightBlack: "#566271",
        brightRed: "#f1868d",
        brightGreen: "#9aca9f",
        brightYellow: "#ecc47a",
        brightBlue: "#91bbda",
        brightMagenta: "#c9aed9",
        brightCyan: "#8acbc5",
        brightWhite: "#edf1f5",
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 500 });
    const unicodeAddon = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicodeAddon);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    }));
    terminal.unicode.activeVersion = "11";
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const sendResize = () => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };

    const onData = terminal.onData((data) => sendInput(data));
    const onBinary = terminal.onBinary((data) => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0));
      socket.send(bytes);
    });
    const onResize = terminal.onResize(sendResize);
    terminal.attachCustomKeyEventHandler((event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "f" && event.type === "keydown") {
        setSearchOpen(true);
        return false;
      }
      if (modifier && event.key.toLowerCase() === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        terminal.clearSelection();
        showClipboardNote("Copied");
        return false;
      }
      return true;
    });

    const scheduleReconnect = () => {
      if (disposedRef.current || reconnectTimerRef.current !== null) return;
      setConnection("reconnecting");
      const delay = RECONNECT_DELAYS[Math.min(retryRef.current, RECONNECT_DELAYS.length - 1)];
      retryRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectRef.current();
      }, delay);
    };

    const connect = async () => {
      if (disposedRef.current) return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

      setConnection(retryRef.current > 0 ? "reconnecting" : "authorizing");
      setError(null);
      try {
        const response = await authFetch("/api/terminal/status", { cache: "no-store" });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || `Terminal authorization failed (${response.status})`);
        }
        const nextStatus = await response.json() as TerminalStatus;
        if (disposedRef.current) return;
        setStatus(nextStatus);
        setConnection("connecting");

        const socket = new WebSocket(socketUrl());
        socket.binaryType = "arraybuffer";
        socketRef.current = socket;

        socket.onopen = () => {
          retryRef.current = 0;
          sendResize();
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") {
            terminal.write(new Uint8Array(event.data as ArrayBuffer));
            return;
          }
          let message: ServerControlMessage;
          try { message = JSON.parse(event.data) as ServerControlMessage; }
          catch { return; }

          if (message.type === "ready") {
            setConnection("connected");
            setError(null);
            setStatus((current) => current ? {
              ...current,
              host: message.host || current.host,
              session: message.session || current.session,
              sessionActive: true,
              connectedClients: message.connectedClients ?? current.connectedClients,
            } : current);
            fitTerminal();
            terminal.focus();
            return;
          }
          if (message.type === "pong" && message.id) {
            const started = pingStartedRef.current.get(message.id);
            if (started) {
              setLatency(Math.max(0, Date.now() - started));
              pingStartedRef.current.delete(message.id);
            }
            return;
          }
          if (message.type === "error") {
            setError(message.error || "Terminal error");
            return;
          }
          if (message.type === "exit") {
            setError(`Terminal client exited${message.exitCode == null ? "" : ` (${message.exitCode})`}; the tmux session is preserved.`);
          }
        };
        socket.onerror = () => setError("The terminal connection was interrupted.");
        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = null;
          if (!disposedRef.current) scheduleReconnect();
        };
      } catch (cause) {
        if (disposedRef.current) return;
        setConnection("offline");
        setError(cause instanceof Error ? cause.message : "Unable to authorize terminal access");
        scheduleReconnect();
      }
    };
    reconnectRef.current = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const socket = socketRef.current;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "manual reconnect");
      socketRef.current = null;
      retryRef.current = 0;
      void connect();
    };

    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(host);
    window.visualViewport?.addEventListener("resize", fitTerminal);
    window.visualViewport?.addEventListener("scroll", fitTerminal);
    window.addEventListener("resize", fitTerminal);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fitTerminal();
        if (!socketRef.current || socketRef.current.readyState >= WebSocket.CLOSING) reconnectRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    fitTerminal();
    void connect();
    const pingTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const id = `${Date.now()}`;
      pingStartedRef.current.set(id, Date.now());
      socket.send(JSON.stringify({ type: "ping", id }));
      for (const [key, started] of pingStartedRef.current) {
        if (Date.now() - started > 30_000) pingStartedRef.current.delete(key);
      }
    }, 10_000);

    return () => {
      disposedRef.current = true;
      document.body.classList.remove("terminal-immersive");
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      window.clearInterval(pingTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", fitTerminal);
      window.visualViewport?.removeEventListener("resize", fitTerminal);
      window.visualViewport?.removeEventListener("scroll", fitTerminal);
      resizeObserver.disconnect();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "terminal page closed");
      onData.dispose();
      onBinary.dispose();
      onResize.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
  }, [fitTerminal, sendInput, showClipboardNote]);

  useEffect(() => {
    window.setTimeout(fitTerminal, 0);
  }, [immersive, fitTerminal]);

  const runSearch = (direction: "next" | "previous") => {
    if (!searchValue) return;
    const options = {
      caseSensitive: false,
      incremental: direction === "next",
      decorations: {
        matchBackground: "#4f4028",
        matchOverviewRuler: "#8b713e",
        activeMatchBackground: "#b57b22",
        activeMatchColorOverviewRuler: "#f3ae38",
      },
    };
    if (direction === "next") searchAddonRef.current?.findNext(searchValue, options);
    else searchAddonRef.current?.findPrevious(searchValue, options);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  const cliCommands = status?.cliCommands?.length ? status.cliCommands : FALLBACK_CLIS;
  const connected = connection === "connected";

  return (
    <div className={`terminal-page${immersive ? " immersive" : ""}`} ref={pageRef}>
      <header className="terminal-toolbar">
        <div className="terminal-identity">
          <span className="terminal-prompt-mark" aria-hidden="true">›_</span>
          <div className="terminal-identity-copy">
            <strong>{status ? `root@${status.host}` : "root@vm"}</strong>
            <span>{status?.cwd || "/root"}</span>
          </div>
          <span className="terminal-root-badge"><ShieldAlert size={11} /> root</span>
        </div>

        <div className="terminal-session-meta" aria-label="Terminal session status">
          <span className={`terminal-connection ${connected ? "online" : "offline"}`}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            {connectionLabel(connection)}
          </span>
          <span className="terminal-meta-detail">
            {status?.session || "tib-root"} · persistent
            {latency !== null ? ` · ${latency}ms` : ""}
          </span>
        </div>

        <div className="terminal-actions">
          <div className="terminal-launcher-wrap">
            <button
              type="button"
              className={`terminal-icon-btn terminal-cli-btn${launcherOpen ? " active" : ""}`}
              onClick={() => setLauncherOpen((open) => !open)}
              title="Insert an AI CLI command"
              aria-expanded={launcherOpen}
            >
              <Bot size={16} /><span>AI CLI</span><ChevronDown size={12} />
            </button>
            {launcherOpen && (
              <div className="terminal-launcher" role="menu" aria-label="AI CLI commands">
                <div className="terminal-launcher-head">Insert at the prompt</div>
                {cliCommands.map((command) => (
                  <button
                    key={command}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      sendInput(command);
                      setLauncherOpen(false);
                    }}
                  >
                    <span className="terminal-command-glyph">$</span>
                    <span>{command}</span>
                  </button>
                ))}
                <p>Press Enter when you are ready.</p>
              </div>
            )}
          </div>
          <button type="button" className="terminal-icon-btn" onClick={() => setSearchOpen(true)} title="Find in terminal (Ctrl/⌘ F)" aria-label="Find in terminal">
            <Search size={16} />
          </button>
          <button type="button" className="terminal-icon-btn" onClick={() => void copySelection()} title="Copy selection" aria-label="Copy terminal selection">
            <Copy size={16} />
          </button>
          <button type="button" className="terminal-icon-btn" onClick={() => void pasteClipboard()} title="Paste from clipboard" aria-label="Paste into terminal">
            <Clipboard size={16} />
          </button>
          <button type="button" className="terminal-icon-btn" onClick={() => reconnectRef.current()} title="Reconnect to the persistent shell" aria-label="Reconnect terminal">
            <RefreshCw size={16} />
          </button>
          <button type="button" className="terminal-icon-btn" onClick={toggleImmersive} title={immersive ? "Exit focus mode" : "Focus mode"} aria-label={immersive ? "Exit terminal focus mode" : "Enter terminal focus mode"}>
            {immersive ? <Minimize2 size={16} /> : <Expand size={16} />}
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="terminal-search" role="search">
          <Search size={14} />
          <input
            autoFocus
            value={searchValue}
            onChange={(event) => {
              setSearchValue(event.target.value);
              if (event.target.value) {
                searchAddonRef.current?.findNext(event.target.value, { caseSensitive: false, incremental: true });
              } else {
                searchAddonRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") runSearch(event.shiftKey ? "previous" : "next");
              if (event.key === "Escape") closeSearch();
            }}
            placeholder="Find output…"
            aria-label="Find terminal output"
          />
          <button type="button" onClick={() => runSearch("previous")} title="Previous match">↑</button>
          <button type="button" onClick={() => runSearch("next")} title="Next match">↓</button>
          <button type="button" onClick={closeSearch} title="Close search"><X size={14} /></button>
        </div>
      )}

      <div className="terminal-stage" onClick={() => terminalRef.current?.focus()}>
        <div ref={hostRef} className="terminal-xterm" aria-label="Interactive root terminal" />
        {!connected && (
          <div className="terminal-connection-banner" role="status">
            <span className={`terminal-banner-dot ${connection}`} />
            <div>
              <strong>{connectionLabel(connection)}</strong>
              <span>{error || "Attaching to the persistent root shell…"}</span>
            </div>
            {connection === "offline" && (
              <button type="button" onClick={(event) => { event.stopPropagation(); reconnectRef.current(); }}>
                Reconnect
              </button>
            )}
          </div>
        )}
        {clipboardNote && <div className="terminal-toast" role="status">{clipboardNote}</div>}
      </div>

      <div className="terminal-softbar" aria-label="Mobile terminal keys">
        <div className="terminal-softbar-label"><Keyboard size={14} /><span>Keys</span></div>
        {SOFT_KEYS.map((key) => (
          <button key={key.title} type="button" title={key.title} onClick={() => sendInput(key.value)}>
            {key.label}
          </button>
        ))}
        <button type="button" className="terminal-softbar-paste" onClick={() => void pasteClipboard()}>
          <Clipboard size={14} /> Paste
        </button>
      </div>
    </div>
  );
}
