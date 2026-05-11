import { useEffect } from "react";
import { useStore } from "../lib/store";
import { OpenCodeView } from "../components/OpenCodeView";

export function OpenCodeRoute() {
  const { init, ready, error } = useStore();
  useEffect(() => { init().catch(() => {}); }, [init]);

  if (!ready) {
    return (
      <div className="oc-connecting">
        <span className="oc-connecting-text">
          {error ? `OpenCode unavailable: ${error}` : "Connecting to OpenCode…"}
        </span>
      </div>
    );
  }

  return <OpenCodeView />;
}
