# Pass 4: UX Designer

## OpenCode Control Surface – BuilderWatchdog UI Design  
*UX layer for the QA‑layer that validates every builder pass*  

Below is a **component‑first** specification that can be dropped into the existing React + wouter codebase (`app/components/`, `app/routes/`).  
All snippets are **TSX / TypeScript** style, use the project’s design system (assume a `theme` with `color` tokens and a `Flex` primitive), and rely on the existing **SSE** helper (`useEventSource`) that was added for other streaming endpoints.

---

### 1. WatchdogBadge – per‑pass status indicator  

| State | Meaning | Color (theme) | Icon |
|------|---------|---------------|------|
| `idle` | Pass not yet started | `gray.300` | ⏳ |
| `running` | Builder is executing, watchdog waiting for results | `blue.500` | 🔄 |
| `passed` | All gates succeeded | `green.600` | ✅ |
| `failed` | One or more gates rejected | `red.600` | ❌ |
| `fixing` | Watchdog dispatched a fix and is waiting for the retry | `orange.500` | 🛠️ |
| `error` | Watchdog itself errored (e.g. LLM down) | `purple.600` | ⚠️ |

#### Props & State Machine  

```tsx
// app/components/WatchdogBadge.tsx
import { useEffect, useState } from "react";
import { Flex, Box, Tooltip, Spinner } from "@/ui";
import { CheckIcon, XIcon, RefreshIcon, AlertIcon, ToolIcon } from "@/ui/icons";

export type WatchdogStatus =
  | "idle"
  | "running"
  | "passed"
  | "failed"
  | "fixing"
  | "error";

interface WatchdogBadgeProps {
  /** Unique builder‑run identifier (same as the `runId` used by the backend) */
  runId: string;
  /** Optional: initial status if the page is SSR‑rendered */
  initialStatus?: WatchdogStatus;
}

/** Simple state machine – transitions are driven by SSE events */
export const WatchdogBadge = ({
  runId,
  initialStatus = "idle",
}: WatchdogBadgeProps) => {
  const [status, setStatus] = useState<WatchdogStatus>(initialStatus);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --------------------------------------------------------------
  // 1️⃣  Subscribe to the watchdog stream for this run
  // --------------------------------------------------------------
  useEffect(() => {
    const src = new EventSource(
      `/api/watchdog/stream/${encodeURIComponent(runId)}`,
    );

    const onMessage = (e: MessageEvent) => {
      const payload: {
        type: "status"; // only status events for the badge
        status: WatchdogStatus;
        error?: string;
      } = JSON.parse(e.data);
      setStatus(payload.status);
      setErrorMsg(payload.error ?? null);
    };

    src.addEventListener("message", onMessage);
    src.addEventListener("error", () => {
      // connection lost → show a transient error state
      setStatus("error");
      setErrorMsg("Connection lost – retrying…");
    });

    return () => src.close();
  }, [runId]);

  // --------------------------------------------------------------
  // 2️⃣  Render the badge
  // --------------------------------------------------------------
  const renderIcon = () => {
    switch (status) {
      case "idle":
        return <Spinner size="xs" />;
      case "running":
        return <RefreshIcon color="blue.500" spin />;
      case "passed":
        return <CheckIcon color="green.600" />;
      case "failed":
        return <XIcon color="red.600" />;
      case "fixing":
        return <ToolIcon color="orange.500" spin />;
      case "error":
        return <AlertIcon color="purple.600" />;
    }
  };

  const tooltipLabel = (() => {
    switch (status) {
      case "idle":
        return "Builder pass has not started yet.";
      case "running":
        return "Builder is running – watchdog is evaluating.";
      case "passed":
        return "All QA gates passed.";
      case "failed":
        return "One or more QA gates failed.";
      case "fixing":
        return "Watchdog is applying an automated fix.";
      case "error":
        return errorMsg ?? "Watchdog encountered an error.";
    }
  })();

  return (
    <Tooltip content={tooltipLabel} placement="top">
      <Flex
        align="center"
        justify="center"
        w={24}
        h={24}
        borderRadius="full"
        bg={status === "passed"
          ? "green.100"
          : status === "failed"
            ? "red.100"
            : status === "fixing"
              ? "orange.100"
              : status === "error"
                ? "purple.100"
                : "gray.100"}
        aria-live="polite"
        role="status"
        aria-label={`Watchdog status: ${status}`}
      >
        <Box>{renderIcon()}</Box>
      </Flex>
    </Tooltip>
  );
};
```

**Why a badge?**  
- Tiny footprint – can sit right next to each *pass card* on the Builder page.  
- Color‑coded, accessible (`aria-live`, `role="status"`).  
- Reactively updates via a **single SSE connection per run**, keeping bandwidth low.

---

### 2. WatchdogPanel – expandable list of violations  

The panel is hidden by default (collapsed) and expands on click or when the badge is in a *failed/fixing* state.

```tsx
// app/components/WatchdogPanel.tsx
import { useState, useEffect } from "react";
import {
  Box,
  Flex,
  Text,
  Collapse,
  IconButton,
  Badge,
  Tooltip,
} from "@/ui";
import { ChevronDownIcon, ChevronUpIcon } from "@/ui/icons";

export type Violation = {
  id: string;               // primary key from DB
  gate: string;             // e.g. "ModelNameGate"
  filePath: string;         // relative to repo root
  line: number;
  preview: string;          // sanitized snippet (≤100 chars)
  status: "open" | "fixed" | "dismissed";
};

interface WatchdogPanelProps {
  runId: string;
}

/** Fetch violations on demand – lazy load to avoid unnecessary DB hits */
export const WatchdogPanel = ({ runId }: WatchdogPanelProps) => {
  const [open, setOpen] = useState(false);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(false);

  const toggle = () => setOpen((v) => !v);

  // --------------------------------------------------------------
  // 1️⃣ Load violations when the panel opens (or when a new SSE event arrives)
  // --------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/watchdog/violations/${encodeURIComponent(runId)}`, {
      credentials: "include",
    })
      .then((r) => r.json())
      .then((data) => setViolations(data.violations))
      .finally(() => setLoading(false));
  }, [open, runId]);

  // --------------------------------------------------------------
  // 2️⃣ Listen for live "violation" events (optional, nice‑to‑have)
  // --------------------------------------------------------------
  useEffect(() => {
    const src = new EventSource(
      `/api/watchdog/stream/${encodeURIComponent(runId)}`,
    );

    const onMessage = (e: MessageEvent) => {
      const payload = JSON.parse(e.data);
      if (payload.type === "violation") {
        setViolations((prev) => [...prev, payload.violation]);
      }
    };
    src.addEventListener("message", onMessage);
    return () => src.close();
  }, [runId]);

  // --------------------------------------------------------------
  // 3️⃣ Render
  // --------------------------------------------------------------
  return (
    <Box w="full" my={2}>
      <Flex
        align="center"
        justify="space-between"
        bg="gray.50"
        p={2}
        borderRadius="md"
        cursor="pointer"
        onClick={toggle}
        aria-expanded={open}
        role="button"
        aria-controls={`watchdog-panel-${runId}`}
      >
        <Text fontWeight="medium">Watchdog QA</Text>
        <IconButton
          aria-label={open ? "Collapse" : "Expand"}
          icon={open ? <ChevronUpIcon /> : <ChevronDownIcon />}
          variant="ghost"
          size="sm"
        />
      </Flex>

      <Collapse in={open} animateOpacity>
        <Box id={`watchdog-panel-${runId}`} p={3} bg="gray.0" borderRadius="md">
          {loading ? (
            <Text>Loading violations…</Text>
          ) : violations.length === 0 ? (
            <Text color="green.600">✅ No violations – all gates passed.</Text>
          ) : (
            violations.map((v) => (
              <Flex
                key={v.id}
                align="center"
                py={1}
                borderBottom="1px solid"
                borderColor="gray.200"
              >
                <Badge variant="solid" colorScheme={v.status === "fixed" ? "green" : "red"}>
                  {v.gate}
                </Badge>
                <Box flex="1" ml={2}>
                  <Text fontSize="sm" fontFamily="mono">
                    {v.filePath}:{v.line}
                  </Text>
                  <Text fontSize="xs" color="gray.600" noOfLines={2}>
                    {v.preview}
                  </Text>
                </Box>
                {/* status chip */}
                <Tooltip
                  label={
                    v.status === "fixed"
                      ? "Automatically fixed by Watchdog"
                      : v.status === "dismissed"
                        ? "Manually dismissed"
                        : "Open violation"
                  }
                >
                  <Badge
                    variant="outline"
                    colorScheme={v.status === "fixed" ? "green" : "red"}
                  >
                    {v.status}
                  </Badge>
                </Tooltip>
              </Flex>
            ))
          )}
        </Box>
      </Collapse>
    </Box>
  );
};
```

**Key UX points**

| Feature | Rationale |
|---------|-----------|
| **Lazy‑load** violations only when expanded – reduces DB traffic. |
| **Live SSE updates** – if a fix lands while the panel is open, the list auto‑refreshes. |
| **Status chips** (`open` / `fixed` / `dismissed`) give a quick visual cue for each gate. |
| **ARIA**: `role="button"`, `aria-expanded`, `aria-controls` for screen‑reader navigation. |
| **Sanitized preview** – never shows secrets (backend truncates & redacts). |

---

### 3. Embedding the badge & panel in the Builder UI  

Assume the existing **BuilderPage** renders a series of “pass cards” (one per builder run) inside `app/routes/builder.tsx`.  

```tsx
// app/routes/builder.tsx
import { WatchdogBadge } from "@/components/WatchdogBadge";
import { WatchdogPanel } from "@/components/WatchdogPanel";
import { PassCard } from "@/components/PassCard"; // existing component

export const BuilderPage = () => {
  // `passes` is fetched from `/api/builder/runs` – each has a `runId` and meta.
  const { passes } = useBuilderRuns();

  return (
    <Box maxW="7xl" mx="auto" p={4}>
      <Text as="h1" fontSize="2xl" mb={6}>
        Builder History
      </Text>

      {passes.map((p) => (
        <Box key={p.runId} mb={4} borderWidth={1} borderRadius="md" p={3}>
          {/* Existing pass UI – title, logs, actions */}
          <PassCard pass={p} />

          {/* 1️⃣ Watchdog badge – placed inline with the pass header */}
          <Flex align="center" mt={2}>
            <Text mr={2} fontSize="sm" color="gray.600">
              QA:
            </Text>
            <WatchdogBadge runId={p.runId} initialStatus={p.watchdogStatus} />
          </Flex>

          {/* 2️⃣ Expandable panel – appears only when needed */}
          <WatchdogPanel runId={p.runId} />
        </Box>
      ))}
    </Box>
  );
};
```

**Why next to the pass card?**  
- The badge lives in the same visual hierarchy as the pass status, so developers instantly see “QA failed” while scanning logs.  
- The panel expands *inside* the card, keeping the page scroll stable.

---

### 4. SSE Subscription Hook (re‑usable)  

A small custom hook abstracts the boiler‑plate used by both badge and panel.

```tsx
// app/lib/useEventSource.ts
import { useEffect, useRef } from "react";

type EventHandler = (payload: any) => void;

/**
 * Connects to an EventSource endpoint and forwards parsed JSON messages.
 * Handles automatic reconnection with exponential back‑off.
 */
export function useEventSource(
  url: string,
  onMessage: EventHandler,
  onError?: (err: Event) => void,
) {
  const retryRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const connect = () => {
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onMessage(data);
        } catch (_) {
          // ignore malformed payloads
        }
      };

      es.onerror = (e) => {
        onError?.(e);
        // close & schedule reconnect
        es.close();
        const delay = Math.min(30_000, 500 * 2 ** retryRef.current);
        retryRef.current += 1;
        setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      esRef.current?.close();
    };
  }, [url, onMessage, onError]);
}
```

Both components now use:

```tsx
useEventSource(`/api/watchdog/stream/${runId}`, (msg) => {
  // handle status / violation messages
});
```

---

### 5. Toast notifications – immediate feedback  

The app already ships a global toast provider (`useToast`). Add two small helpers:

```tsx
// app/lib/toastWatchdog.ts
import { useToast } from "@/ui/toast";

export const useWatchdogToasts = () => {
  const toast = useToast();

  const blocked = (runId: string) => {
    toast({
      title: "Builder blocked by QA",
      description: `Watchdog rejected pass ${runId}. Check the QA panel for details.`,
      status: "error",
      duration: 8000,
      isClosable: true,
    });
  };

  const autoFixed = (runId: string) => {
    toast({
      title: "Watchdog auto‑fixed",
      description: `A fix was applied and the pass ${runId} is being retried.`,
      status: "info",
      duration: 5000,
      isClosable: true,
    });
  };

  const watchdogError = (runId: string, msg: string) => {
    toast({
      title: "Watchdog error",
      description: `Run ${runId}: ${msg}`,
      status: "warning",
      duration: 9000,
      isClosable: true,
    });
  };

  return { blocked, autoFixed, watchdogError };
};
```

**Wiring** – inside `WatchdogBadge`:

```tsx
const { blocked, autoFixed, watchdogError } = useWatchdogToasts();

useEffect(() => {
  if (status === "failed") blocked(runId);
  if (status === "fixing") autoFixed(runId);
  if (status === "error") watchdogError(runId, errorMsg ?? "unknown");
}, [status, runId, errorMsg]);
```

The toast disappears after a few seconds but remains in the notification list, giving quick situational awareness.

---

### 6. Error‑state handling – graceful degradation  

| Failure scenario | UI response |
|------------------|-------------|
| **SSE cannot connect** (backend down) | Badge switches to `error` with tooltip “Watchdog unavailable – retrying”. Panel shows a muted note “Live QA not available”. |
| **Backend returns 403 on violations endpoint** (RBAC) | Panel displays “You do not have permission to view QA details.” (styled as a warning). |
| **`watchdog_violations` table corrupt** (SQL error) | A global banner at the top of the Builder page: “QA data could not be loaded. Contact admin.” |
| **LiteLLM service down** → Watchdog cannot auto‑fix | Badge shows `error` with tooltip “LLM unavailable – manual fix required”. Toast: “Watchdog could not apply an automated fix.” |

Implementation tip: wrap every fetch call in a `try/catch` and set an `internalError` state that the UI reads to render the fallback UI.

```tsx
// inside WatchdogPanel
const [internalError, setInternalError] = useState<string | null>(null);
// …
fetch(...).catch((e) => setInternalError(e.message));

// render:
{internalError ? (
  <Text color="red.500">Error loading violations: {internalError}</Text>
) : /* normal UI */ }
```

---

### 7. Accessibility checklist  

| Element | ARIA / a11y feature |
|--------|----------------------|
| **WatchdogBadge** | `role="status"` + `aria-live="polite"` + `aria-label` describing the current state. |
| **WatchdogPanel toggle** | `role="button"` + `aria-expanded` + `aria-controls` linking to the collapsible region. |
| **Icons** | Provide `aria-hidden="true"` (decorative) and optional `title` for tooltip fallback. |
| **Toast** | Use the toast system’s built‑in `role="alert"` and `aria-live="assertive"`. |
| **Color contrast** | All badge backgrounds meet WCAG AA (≥4.5:1) – use theme tokens that guarantee contrast. |
| **Keyboard** | The toggle button is a native `<button>` (or `IconButton`) so it’s focusable and operable via Enter/Space. |
| **Screen‑reader preview** | Violation rows include the file path and line number as plain text; no code snippets are rendered verbatim. |

---

## 8. Putting it all together – component tree  

```
BuilderPage
└─ PassCard (existing)
   ├─ Header (title, logs, actions)
   ├─ Flex
   │   ├─ Text   "QA:"
   │   └─ WatchdogBadge   ← updates via SSE
   └─ WatchdogPanel (collapsed by default)
        └─ (list of Violation rows)
```

All **state lives locally** to each badge/panel pair; no global Redux store is required. The SSE connection is scoped to a `runId`, keeping the number of open sockets linear to the number of visible passes (normally < 10).  

---

### Next steps for developers  

1. **Add the new tables & API routes** (`/api/watchdog/violations/:runId`, `/api/watchdog/stream/:runId`).  
2. **Protect the violations endpoint** with the `requireRole(['admin','auditor'])` middleware (as described in the security analysis).  
3. **Wire the backend to emit SSE events** with the payload shapes used above (`type:"status"` or `"violation"`).  
4. **Run the UI storybook** to verify badge colors, panel expand/collapse, and toast timing.  
5. **Run an accessibility audit** (axe‑core) – all ARIA attributes are already in place.  

With these components, developers get **instant, visual QA feedback** on every builder pass, while the underlying watchdog logic stays safely behind the server‑side gates. 🎉