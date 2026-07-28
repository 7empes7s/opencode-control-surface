import { useEffect } from "react";
import { useStore } from "../lib/store";
import { OpenCodeView } from "../components/OpenCodeView";

export function OpenCodeRoute() {
  const { init, ready, error } = useStore();
  useEffect(() => { init().catch(() => {}); }, [init]);

  if (!ready) {
    return (
      <div className="oc-connecting" style={{ flexDirection: "column", gap: 14 }}>
        {error ? (
          <span className="oc-connecting-text" style={{ color: "var(--red)" }}>
            {`OpenCode unavailable: ${error}`}
          </span>
        ) : (
          <>
            <div className="v5-skeleton" style={{ width: 220, height: 14 }} />
            <span className="oc-connecting-text">Connecting to OpenCode…</span>
          </>
        )}
      </div>
    );
  }

  return <OpenCodeView />;
}
