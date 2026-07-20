import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RefreshCw, ShieldAlert, Wifi, WifiOff } from "lucide-react";

type PaneMode = "writer" | "spectator";

type ServerFrame =
  | { type: "ready"; connectionId: string; terminalId: string; mode: PaneMode; fenceEpoch: number; persistent: true; attachmentCount: number }
  | { type: "writer-state"; terminalId: string; connectionId: string; mode: PaneMode; fenceEpoch: number }
  | {
      type: "error";
      error: string;
      code?: "read-only" | "writer-fenced" | "takeover-conflict" | "unreachable";
      fenceEpoch?: number;
      holderConnectionId?: string;
    }
  | { type: "exit"; state: "unreachable"; exitCode?: number; signal?: string }
  | { type: "pong"; id: string; at: number };

type PaneStatus = "connecting" | "connected" | "reconnecting" | "attach-failed";

const RECONNECT_DELAYS = [600, 1_200, 2_500, 5_000, 10_000];
const MAX_SILENT_RETRIES = 3;
const ATTACH_FAILED_MESSAGE =
  "Attach failed — the operator connection limit may be reached; close another terminal tab or click Reconnect.";

function socketUrl(terminalId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminal/sessions/${encodeURIComponent(terminalId)}/ws`;
}

function clampCols(cols: number): number {
  return Math.min(400, Math.max(20, cols));
}

function clampRows(rows: number): number {
  return Math.min(200, Math.max(6, rows));
}

export function ManagedTerminalPane({ terminalId, title }: { terminalId: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const failureCountRef = useRef(0);
  const modeRef = useRef<PaneMode | null>(null);
  const fenceEpochRef = useRef<number | null>(null);
  const connectRef = useRef<() => void>(() => undefined);

  const [status, setStatus] = useState<PaneStatus>("connecting");
  const [mode, setMode] = useState<PaneMode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sendJson = useCallback((payload: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const requestTakeover = useCallback(() => {
    sendJson({ type: "takeover", expectedFenceEpoch: fenceEpochRef.current });
  }, [sendJson]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    disposedRef.current = false;
    const terminal = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: window.matchMedia("(max-width: 600px)").matches ? 12 : 13,
      lineHeight: 1.18,
      scrollback: 20_000,
      theme: {
        background: "#0c1015",
        foreground: "#d7dde5",
        cursor: "#f3ae38",
        cursorAccent: "#0c1015",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;

    const sendResize = () => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "resize", cols: clampCols(terminal.cols), rows: clampRows(terminal.rows) }));
    };

    const onData = terminal.onData((data) => {
      if (modeRef.current !== "writer") return;
      sendJson({ type: "input", data });
    });
    const onResize = terminal.onResize(sendResize);

    const scheduleReconnect = () => {
      if (disposedRef.current) return;
      failureCountRef.current += 1;
      if (failureCountRef.current >= MAX_SILENT_RETRIES) {
        setStatus("attach-failed");
        setErrorMessage(ATTACH_FAILED_MESSAGE);
        return;
      }
      setStatus("reconnecting");
      if (reconnectTimerRef.current !== null) return;
      const delay = RECONNECT_DELAYS[Math.min(failureCountRef.current - 1, RECONNECT_DELAYS.length - 1)];
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current();
      }, delay);
    };

    const connect = () => {
      if (disposedRef.current) return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setStatus(failureCountRef.current > 0 ? "reconnecting" : "connecting");
      setErrorMessage(null);

      const socket = new WebSocket(socketUrl(terminalId));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          terminal.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let message: ServerFrame;
        try {
          message = JSON.parse(event.data) as ServerFrame;
        } catch {
          return;
        }
        if (message.type === "ready") {
          failureCountRef.current = 0;
          modeRef.current = message.mode;
          fenceEpochRef.current = message.fenceEpoch;
          setMode(message.mode);
          setStatus("connected");
          setErrorMessage(null);
          sendResize();
          terminal.focus();
          return;
        }
        if (message.type === "writer-state") {
          modeRef.current = message.mode;
          fenceEpochRef.current = message.fenceEpoch;
          setMode(message.mode);
          return;
        }
        if (message.type === "error") {
          if (message.code === "writer-fenced" || message.code === "takeover-conflict") {
            if (typeof message.fenceEpoch === "number") fenceEpochRef.current = message.fenceEpoch;
          }
          setErrorMessage(message.error);
          return;
        }
        if (message.type === "exit") {
          setErrorMessage(
            `Terminal exited${message.exitCode == null ? "" : ` (${message.exitCode})`}; the tmux session is preserved.`,
          );
        }
      };
      socket.onerror = () => undefined;
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        modeRef.current = null;
        setMode(null);
        if (!disposedRef.current) scheduleReconnect();
      };
    };
    connectRef.current = connect;

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      fitAddon.fit();
      sendResize();
      const socket = socketRef.current;
      if ((!socket || socket.readyState >= WebSocket.CLOSING) && failureCountRef.current < MAX_SILENT_RETRIES) {
        connectRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(host);

    connect();

    return () => {
      disposedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      resizeObserver.disconnect();
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "pane closed");
      onData.dispose();
      onResize.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [terminalId, sendJson]);

  const manualRetry = useCallback(() => {
    failureCountRef.current = 0;
    connectRef.current();
  }, []);

  return (
    <div className="terminal-workspace-pane">
      <div className="terminal-workspace-pane-header">
        <span className="terminal-workspace-pane-title">{title}</span>
        {mode && (
          <span className={`terminal-workspace-mode-badge ${mode}`}>{mode === "writer" ? "Writer" : "Spectator"}</span>
        )}
        {mode === "spectator" && (
          <button type="button" className="terminal-workspace-takeover-btn" onClick={requestTakeover}>
            Take over
          </button>
        )}
        <span className={`terminal-workspace-conn-indicator ${status}`} title={status}>
          {status === "connected" ? <Wifi size={12} /> : <WifiOff size={12} />}
        </span>
      </div>
      <div className="terminal-workspace-pane-body">
        <div ref={hostRef} className="terminal-workspace-xterm" aria-label={`Terminal: ${title}`} />
        {status !== "connected" && (
          <div className="terminal-workspace-pane-banner" role="status">
            {status === "attach-failed" ? (
              <>
                <ShieldAlert size={14} />
                <span>{errorMessage || ATTACH_FAILED_MESSAGE}</span>
                <button type="button" onClick={manualRetry}>
                  <RefreshCw size={13} /> Reconnect
                </button>
              </>
            ) : (
              <span>{status === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
