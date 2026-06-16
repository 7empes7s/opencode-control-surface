# Pass 2: Backend Engineer

# **BuilderWatchdog Implementation Specification**

As the Backend Engineer, here is the complete implementation specification for the **BuilderWatchdog** system.

---

## 1. **TypeScript Interfaces**

```ts
// types/watchdog.ts

export type GateName =
  | 'ModelNameGate'
  | 'MaxTokensGate'
  | 'RouteRegistrationGate'
  | 'TypeScriptGate'
  | 'ImportResolutionGate';

export interface Violation {
  gate: GateName;
  file_path: string;
  line_number?: number;
  message: string;
  severity: 'error';
}

export interface GateResult {
  passed: boolean;
  violations: Violation[];
}

export interface WatchdogRun {
  id?: number;
  builder_run_id: number;
  pass_number: number;
  tenant_id: string;
  session_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'final-failed';
  attempt: 1 | 2 | 3;
  project_root: string;
  created_at?: string;
  updated_at?: string;
}
```

---

## 2. **Gate Implementations**

### ✅ `ModelNameGate`

```ts
// gates/ModelNameGate.ts
import { GateResult, Violation } from '../types/watchdog';

const FORBIDDEN_MODEL_PATTERNS = [
  /gemma4:/i,
  /qwen2/i,
  /qwen3:/i,
  /llama/i,
  /deepseek/i,
  /gpt-4/i,
  /claude-3/i,
  /mistral/i,
];

export function runModelNameGate(filePath: string, content: string): GateResult {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  FORBIDDEN_MODEL_PATTERNS.forEach(pattern => {
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        violations.push({
          gate: 'ModelNameGate',
          file_path: filePath,
          line_number: index + 1,
          message: `Forbidden model string detected: "${line.trim()}"`,
          severity: 'error',
        });
      }
    });
  });

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

---

### ✅ `MaxTokensGate`

```ts
// gates/MaxTokensGate.ts
import { GateResult, Violation } from '../types/watchdog';

const MAX_TOKENS_REGEX = /max_tokens\s*[:=]\s*(\d+)/g;

export function runMaxTokensGate(filePath: string, content: string): GateResult {
  const violations: Violation[] = [];
  let match;

  while ((match = MAX_TOKENS_REGEX.exec(content)) !== null) {
    const value = parseInt(match[1], 10);
    const line = content.substring(0, match.index).split('\n').length;

    if (value <= 1024) {
      violations.push({
        gate: 'MaxTokensGate',
        file_path: filePath,
        line_number: line,
        message: `max_tokens value ${value} <= 1024 is too low; must be > 1024`,
        severity: 'error',
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

---

### ✅ `RouteRegistrationGate`

```ts
// gates/RouteRegistrationGate.ts
import { GateResult, Violation } from '../types/watchdog';
import * as path from 'path';
import { existsSync, readFileSync } from 'fs';

export function runRouteRegistrationGate(
  writtenFiles: string[],
  projectRoot: string
): GateResult {
  const violations: Violation[] = [];
  const pageFiles = writtenFiles.filter(f => f.endsWith('Page.tsx'));

  if (pageFiles.length === 0) {
    return { passed: true, violations: [] };
  }

  const appTsxPath = path.join(projectRoot, 'app', 'App.tsx');
  const navRegistryPath = path.join(projectRoot, 'app', 'lib', 'navRegistry.ts');

  if (!existsSync(appTsxPath)) {
    violations.push({
      gate: 'RouteRegistrationGate',
      file_path: 'app/App.tsx',
      message: 'App.tsx not found in project',
      severity: 'error',
    });
    return { passed: false, violations };
  }

  if (!existsSync(navRegistryPath)) {
    violations.push({
      gate: 'RouteRegistrationGate',
      file_path: 'app/lib/navRegistry.ts',
      message: 'navRegistry.ts not found in project',
      severity: 'error',
    });
    return { passed: false, violations };
  }

  const appContent = readFileSync(appTsxPath, 'utf-8');
  const navContent = readFileSync(navRegistryPath, 'utf-8');

  pageFiles.forEach(pageFile) => {
    const fileName = path.basename(pageFile);
    const componentName = path.parse(fileName).name; // e.g., DashboardPage

    if (!appContent.includes(componentName)) {
      violations.push({
        gate: 'RouteRegistrationGate',
        file_path: pageFile,
        message: `Page component "${componentName}" not registered in App.tsx`,
        severity: 'error',
      });
    }

    if (!navContent.includes(componentName)) {
      violations.push({
        gate: 'RouteRegistrationGate',
        file_path: pageFile,
        message: `Page component "${componentName}" not registered in navRegistry.ts`,
        severity: 'error',
      });
    }
  };

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

---

### ✅ `TypeScriptGate`

```ts
// gates/TypeScriptGate.ts
import { GateResult, Violation } from '../types/watchdog';
import { spawnSync } from 'bun';

export function runTypeScriptGate(projectRoot: string): GateResult {
  const result = spawnSync({
    cmd: ['bun', 'tsc', '--noEmit'],
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const violations: Violation[] = [];
  const output = result.stdout?.toString() || result.stderr?.toString() || '';

  if (result.exitCode !== 0) {
    const lines = output.trim().split('\n');
    const errorRegex = /([^:]+):(\d+):\d+ - (.+)/;

    lines.forEach(line => {
      const match = line.match(errorRegex);
      if (match) {
        const [, file, lineNum, message] = match;
        violations.push({
          gate: 'TypeScriptGate',
          file_path: file,
          line_number: parseInt(lineNum, 10),
          message: message.trim(),
          severity: 'error',
        });
      } else if (line.includes('error TS')) {
        violations.push({
          gate: 'TypeScriptGate',
          file_path: 'unknown',
          message: line.trim(),
          severity: 'error',
        });
      }
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

---

### ✅ `ImportResolutionGate`

```ts
// gates/ImportResolutionGate.ts
import { GateResult, Violation } from '../types/watchdog';
import * as path from 'path';
import { existsSync, readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

export function runImportResolutionGate(
  filePaths: string[],
  projectRoot: string
): GateResult {
  const violations: Violation[] = [];

  for (const relativePath of filePaths) {
    const fullPath = path.join(projectRoot, relativePath);
    if (!existsSync(fullPath)) continue;

    const content = readFileSync(fullPath, 'utf-8');
    let ast;
    try {
      ast = parse(content, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
      });
    } catch (e) {
      violations.push({
        gate: 'ImportResolutionGate',
        file_path: relativePath,
        message: `Failed to parse file: ${e.message}`,
        severity: 'error',
      });
      continue;
    }

    const dir = path.dirname(fullPath);

    traverse(ast, {
      ImportDeclaration: (nodePath) => {
        const importPath = nodePath.node.source.value;
        if (!importPath.startsWith('./') && !importPath.startsWith('../')) return;

        const resolved = path.resolve(dir, importPath);
        const resolvedWithExt = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`]
          .find(existsSync);

        if (!resolvedWithExt) {
          violations.push({
            gate: 'ImportResolutionGate',
            file_path: relativePath,
            message: `Unresolved import: "${importPath}"`,
            severity: 'error',
          });
        }
      },
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
```

> 💡 **Install deps**:
> ```bash
> bun add @babel/parser @babel/traverse
> ```

---

## 3. **DB Migration SQL**

```sql
-- server/db/migrations/20240520120000_watchdog_schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS watchdog_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  builder_run_id INTEGER NOT NULL,
  pass_number INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'final-failed')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt IN (1, 2, 3)),
  project_root TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchdog_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  gate TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error' CHECK(severity IN ('error')),
  resolved BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES watchdog_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchdog_runs_builder ON watchdog_runs(builder_run_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_violations_run ON watchdog_violations(run_id);
CREATE INDEX IF NOT EXISTS idx_watchdog_runs_status ON watchdog_runs(status);
```

---

## 4. **`POST /api/watchdog/review` Handler**

```ts
// routes/watchdog.ts
import { Hono } from 'hono';
import { checkToken } from './actions';
import { getCurrentTenantContext } from '../tenancy/middleware';
import { getDashboardDb } from '../db/dashboard';
import type { WatchdogRun, Violation } from '../types/watchdog';
import {
  runModelNameGate,
  runMaxTokensGate,
  runRouteRegistrationGate,
  runTypeScriptGate,
  runImportResolutionGate,
} from '../gates';
import { broadcastWatchdogEvent } from '../events/watchdog-events';
import { dispatchOpenCodeFix, rollbackAndRequeue } from '../services/watchdog-service';

const app = new Hono();

interface WatchdogReviewBody {
  builder_run_id: number;
  pass_number: number;
  tenant_id: string;
  session_id: string;
  project_root: string;
  written_files: string[];
}

app.post('/review', checkToken, getCurrentTenantContext, async (c) => {
  const db = getDashboardDb();
  if (!db) return c.json({ error: 'DB not available' }, 500);

  const body = await c.req.json<WatchdogReviewBody>();
  const { builder_run_id, pass_number, tenant_id, session_id, project_root, written_files } = body;

  // Validate required fields
  if (!builder_run_id || !pass_number || !tenant_id || !session_id || !project_root || !written_files?.length) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  // Start watchdog run
  const run: WatchdogRun = {
    builder_run_id,
    pass_number,
    tenant_id,
    session_id,
    status: 'pending',
    attempt: 1,
    project_root,
  };

  const stmt = db.prepare(`
    INSERT INTO watchdog_runs
    (builder_run_id, pass_number, tenant_id, session_id, status, attempt, project_root)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    run.builder_run_id,
    run.pass_number,
    run.tenant_id,
    run.session_id,
    run.status,
    run.attempt,
    run.project_root
  );
  const runId = info.lastInsertRowid as number;

  broadcastWatchdogEvent(tenant_id, session_id, 'started', { runId });

  let allViolations: Violation[] = [];

  // Load files
  const fileContents = new Map<string, string>();
  for (const file of written_files) {
    const fullPath = path.join(project_root, file);
    if (existsSync(fullPath)) {
      fileContents.set(file, readFileSync(fullPath, 'utf-8'));
    }
  }

  // Run gates
  const gates = [
    () => {
      const results = Array.from(fileContents.entries())
        .filter(([f]) => f.endsWith('.ts') || f.endsWith('.tsx'))
        .map(([f, c]) => runModelNameGate(f, c));
      return results.flatMap(r => r.violations);
    },
    () => {
      const results = Array.from(fileContents.entries())
        .filter(([f]) => f.endsWith('.ts') || f.endsWith('.tsx'))
        .map(([f, c]) => runMaxTokensGate(f, c));
      return results.flatMap(r => r.violations);
    },
    () => runRouteRegistrationGate(written_files, project_root).violations,
    () => runTypeScriptGate(project_root).violations,
    () => runImportResolutionGate(written_files, project_root).violations,
  ];

  for (const gateFn of gates) {
    const violations = gateFn();
    allViolations.push(...violations);
  }

  // Save violations
  if (allViolations.length > 0) {
    const insertViolation = db.prepare(`
      INSERT INTO watchdog_violations
      (run_id, gate, file_path, line_number, message, severity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const v of allViolations) {
      insertViolation.run(runId, v.gate, v.file_path, v.line_number ?? null, v.message, v.severity);
    }

    const nextAttempt = 1;
    const shouldRetry = nextAttempt <= 3;

    db.prepare('UPDATE watchdog_runs SET status = ?, attempt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(shouldRetry ? 'rejected' : 'final-failed', nextAttempt, runId);

    broadcastWatchdogEvent(tenant_id, session_id, 'rejected', {
      runId,
      violations: allViolations,
      attempt: nextAttempt,
      autoRetry: shouldRetry,
    });

    if (shouldRetry) {
      await dispatchOpenCodeFix({
        tenant_id,
        session_id,
        builder_run_id,
        pass_number,
        project_root,
        violations: allViolations,
        attempt: nextAttempt,
      });
    } else {
      await rollbackAndRequeue({
        runId,
        builder_run_id,
        project_root,
        written_files,
        violations: allViolations,
        tenant_id,
        session_id,
      });
    }
  } else {
    db.prepare('UPDATE watchdog_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('approved', runId);

    broadcastWatchdogEvent(tenant_id, session_id, 'approved', { runId });
  }

  return c.json({ status: 'reviewed', runId, violations: allViolations.length });
});

export default app;
```

---

## 5. **`broadcastWatchdogEvent` Function**

```ts
// events/watchdog-events.ts
import type { Server } from 'bun';
import { getEventListeners, addEventListener, removeEventListener } from './event-bus';

const LISTENERS = new Map<string, Array<(event: string, data: any) => void>>();

export function broadcastWatchdogEvent(tenantId: string, sessionId: string, event: string, data: any) {
  const key = `${tenantId}:${sessionId}`;
  const listeners = LISTENERS.get(key) || [];
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  listeners.forEach((listener) => {
    try {
      listener('watchdog', message);
    } catch (err) {
      console.error(`Failed to broadcast watchdog event to ${key}`, err);
    }
  });
}

export function registerWatchdogListener(tenantId: string, sessionId: string, callback: (event: string, data: string) => void) {
  const key = `${tenantId}:${sessionId}`;
  if (!LISTENERS.has(key)) {
    LISTENERS.set(key, []);
  }
  LISTENERS.get(key)?.push(callback);
}

export function removeWatchdogListeners(tenantId: string, sessionId: string) {
  const key = `${tenantId}:${sessionId}`;
  LISTENERS.delete(key);
}
```

> 🔗 *Assumes shared `event-bus.ts` pattern from `brainstorm-stream.ts`.*

---

## 6. **OpenCode Dispatcher**

```ts
// services/watchdog-service.ts
import { spawn } from 'bun';

export async function dispatchOpenCodeFix(payload: {
  tenant_id: string;
  session_id: string;
  builder_run_id: number;
  pass_number: number;
  project_root: string;
  violations: any[];
  attempt: number;
}) {
  const { project_root, violations, attempt } = payload;

  const reason = `Fix these code quality violations (attempt ${attempt}/3):\n${violations
    .map((v, i) => `${i + 1}. [${v.gate}] ${v.file_path}:${v.line_number ?? '?'} — ${v.message}`)
    .join('\n')}`;

  const args = [
    'opencode',
    '--dir',
    project_root,
    '--dangerously-skip-permissions',
    'run',
    '--task',
    reason,
  ];

  console.log(`[Watchdog] Dispatching OpenCode fix: ${args.join(' ')}`);

  const proc = spawn({
    cmd: args,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  console.log(`[Watchdog] OpenCode stdout: ${stdout}`);
  if (stderr) console.error(`[Watchdog] OpenCode stderr: ${stderr}`);
}
```

---

## 7. **`rollbackAndRequeue` Function**

```ts
// services/watchdog-service.ts (continued)
import { getDashboardDb } from '../db/dashboard';

export function rollbackAndRequeue(payload: {
  runId: number;
  builder_run_id: number;
  project_root: string;
  written_files: string[];
  violations: any[];
  tenant_id: string;
  session_id: string;
}) {
  const { project_root, written_files, violations, tenant_id, session_id, runId, builder_run_id } = payload;
  const db = getDashboardDb();

  // Git stash specific files
  const relativeFiles = written_files.map(f => `app/${f}`).join(' ');
  const stashResult = spawnSync({
    cmd: ['git', 'stash', 'push', '--', relativeFiles],
    cwd: project_root,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (stashResult.exitCode !== 0) {
    console.error(`[Watchdog] Git stash failed: ${stashResult.stderr?.toString()}`);
  }

  // Update DB
  if (db) {
    db.prepare('UPDATE watchdog_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('final-failed', runId);
  }

  // Broadcast
  broadcastWatchdogEvent(tenant_id, session_id, 'final-failed', {
    runId,
    violations,
    message: 'Manual approval required after 3 failed attempts. Files stashed.',
  });

  console.log(`[Watchdog] Final failure. Run ${runId} requires manual approval.`);
}
```

---

## 8. **Integration in `runner.ts`**

Add **after** `builder pass completes` and before continuing next pass:

```ts
// runner.ts — snippet insertion point

// ... after: const result = opencode.spawn(...)
// ... and pass is marked complete in DB

// ➕ ADD: CALL WATCHDOG AFTER PASS
const watchdogPayload = {
  builder_run_id: builderRunId,
  pass_number: passNumber,
  tenant_id: tenantId,
  session_id: sessionId,
  project_root: projectRoot,
  written_files: Array.from(writtenFiles), // Set<string> → string[]
};

await fetch('http://127.0.0.1:3000/api/watchdog/review', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.CONTROL_SURFACE_TOKEN}`, // or use session token
  },
  body: JSON.stringify(watchdogPayload),
});

// Do NOT proceed to next pass until watchdog approves (handled via re-dispatch or manual)
```

> 🛠️ Ensure `CONTROL_SURFACE_TOKEN` is set and middleware `checkToken` validates it.

---

## ✅ Final Notes

- **Mount route**: Add `app.route('/api/watchdog', watchdogRouter)` in main `server/index.ts`
- **Frontend**: Subscribe via `EventSource('/api/events?tenant=...&session=...')` listening to `watchdog` events
- **Monitoring**: Add `/api/watchdog/runs` and `/api/watchdog/violations` read-only endpoints for audit UI
- **Security**: Sanitize all file paths and reject traversal attempts (`/../`)

**Ready to implement.**