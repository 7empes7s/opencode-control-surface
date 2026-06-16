# Pass 3: Security Analyst

# 🔒 Security Audit: BuilderWatchdog Feature

Below is a comprehensive security analysis of the **BuilderWatchdog** feature based on the provided codebase context. The audit identifies **attack surfaces**, **injection risks**, **path traversal vectors**, **authentication gaps**, and provides **concrete, actionable mitigations**.

---

## 1. 🛑 Path Traversal Risks

### ✅ Risk
The `written_files` array in the watchdog payload contains relative file paths (e.g., `auth/LoginPage.tsx`) that are later:
- Used in `git stash push -- <files>`
- Joined into shell commands via `relativeFiles.join(' ')`
- Used in import resolution checks with `fs.existsSync(path.join(project_root, ...))`

An attacker could inject malicious file paths like:
```json
["../../../secrets.ts", "../../../../etc/passwd"]
```
This could lead to:
- Unauthorized reading/writing of files outside the project root
- Exposure of sensitive system files via logs or error messages
- Inadvertent stashing of critical configuration files

### 🛡️ Mitigation: Sanitize & Validate File Paths

Add strict path normalization and containment checks:

```ts
// utils/pathValidation.ts
import { resolve, relative } from 'path';

export function isValidProjectPath(baseDir: string, filePath: string): boolean {
  const resolved = resolve(baseDir, 'app', filePath);
  const relativePath = relative(baseDir, resolved);
  return !relativePath.startsWith('..') && !resolved.includes('/node_modules/');
}
```

Apply in `reviewPass` before processing:

```ts
// services/watchdog-service.ts
for (const file of written_files) {
  if (!isValidProjectPath(project_root, file)) {
    console.warn(`[Watchdog] Blocked path traversal attempt: ${file}`);
    return c.json({ error: 'Invalid file path' }, 400);
  }
}
```

> ✅ Ensures all paths are within `project_root/app/`

---

## 2. ⚔️ Command Injection via `spawnSync` (Git & OpenCode)

### ✅ Risk
The following commands use interpolated strings:

```ts
cmd: ['git', 'stash', 'push', '--', relativeFiles]
```
Where `relativeFiles` is `.join(' ')` of user-controlled paths. If a filename contains spaces or special characters (e.g., `"; rm -rf /"`), and if shell interpretation were enabled (even indirectly), it could enable command injection.

Even though `spawnSync` with array args prevents direct shell expansion, **malformed filenames** (e.g., `file;rm -rf .git`) may still cause unintended behavior in some environments (e.g., Windows shells, misconfigured PATH).

Additionally, `opencode --dir ${project_root}` uses dynamic paths — if project_root is manipulated, it could point elsewhere.

### 🛡️ Mitigation: Avoid String Joins; Use Arg Arrays + Sanitization

Fix the `git stash` command:

```ts
const args = ['stash', 'push', '--'];
for (const file of written_files) {
  if (isValidProjectPath(project_root, file)) {
    args.push(`app/${file}`);
  } else {
    throw new Error(`Invalid path: ${file}`);
  }
}
const stashResult = spawnSync({
  cmd: ['git', ...args],
  cwd: project_root,
  stdout: 'pipe',
  stderr: 'pipe',
});
```

Also validate `project_root` at entry point:

```ts
if (!project_root.startsWith('/valid/projects/') || !fs.existsSync(project_root)) {
  throw new Error('Invalid project root');
}
```

> ✅ Prevents injection through argument parsing quirks

---

## 3. 🔐 Auth on `POST /api/watchdog/review` — Internal Endpoint Exposed

### ✅ Risk
The endpoint:
```ts
await fetch('http://127.0.0.1:3000/api/watchdog/review', { ... })
```
Is called internally but protected only by:
```ts
'Authorization': `Bearer ${process.env.CONTROL_SURFACE_TOKEN}`
```
And presumably `checkToken(authToken)` middleware.

Risks:
- `CONTROL_SURFACE_TOKEN` might be logged, hardcoded, or leaked
- No verification that request comes from `localhost`
- External actors might guess/token-brute-force the endpoint
- Token reused elsewhere → privilege escalation

### 🛡️ Mitigation: Dual Protection — Localhost Binding + Token

#### A. Bind Watchdog Route to Loopback Only
In `server/index.ts`, ensure Hono listens only on `127.0.0.1`:

```ts
app.fire(() => {
  const server = Bun.serve({
    port: 3000,
    hostname: '127.0.0.1', // 🔒 Not 0.0.0.0
    fetch: app.fetch,
  });
});
```

#### B. Add IP Whitelist Middleware

```ts
const allowLocalhost = (c: Context, next: Function) => {
  const ip = c.req.header('x-forwarded-for') || c.req.header('origin');
  if (ip && !['::1', '127.0.0.1', 'localhost'].some(h => ip.includes(h))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
};
```

Apply to `/api/watchdog`:

```ts
watchdogRouter.use('*', allowLocalhost);
```

#### C. Rotate `CONTROL_SURFACE_TOKEN` Frequently
Use environment vaults (e.g., Hashicorp Vault, AWS Secrets Manager) and rotate regularly.

> ✅ Defense-in-depth: even if token leaks, only localhost can use it

---

## 4. 📡 SSE Information Leak — Tenant Isolation Failure

### ✅ Risk
SSE events broadcasted via:
```ts
broadcastWatchdogEvent(tenant_id, session_id, 'final-failed', { ... })
```
Are received by clients subscribing to:
```
/events?tenant=T&session=S
```

But:
- No validation that the **requesting user owns** the `(tenant_id, session_id)`
- Frontend could subscribe to any tenant/session combo
- Violation data may include **code snippets** (e.g., lines with `gpt-4`), which are sensitive

### 🛡️ Mitigation: Enforce Session Ownership in SSE Middleware

In SSE route (`/api/events`), validate session ownership:

```ts
// tenancy/sseAuth.ts
export function requireValidSession(c: Context) {
  const tenantId = c.req.query('tenant');
  const sessionId = c.req.query('session');
  const authToken = c.req.header('Authorization');

  if (!authToken || !tenantId || !sessionId) {
    return c.json({ error: 'Missing params' }, 401);
  }

  const userId = verifyToken(authToken); // from JWT or session store
  if (!userId) return c.json({ error: 'Invalid token' }, 401);

  const db = getDashboardDb();
  const row = db?.prepare(`
    SELECT 1 FROM builder_runs 
    WHERE tenant_id = ? AND id = ? AND created_by = ?
  `).get(tenantId, sessionId, userId);

  if (!row) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  return { tenantId, sessionId };
}
```

Use in EventSource handler:

```ts
app.get('/api/events', async (c) => {
  const auth = requireValidSession(c);
  if (typeof auth !== 'object') return auth;

  const { tenantId, sessionId } = auth;
  // proceed with stream registration
});
```

> ✅ Prevents cross-tenant event snooping

---

## 5. 🧨 Git Operations Security — Race Conditions & Shared Repo

### ✅ Risk
Multiple builder runs may execute concurrently:
- Two watchdogs calling `git stash push` simultaneously → race condition
- One stash overwrites or interferes with another
- Corrupted stash stack or working directory

Also:
- `git stash` operates globally — no namespace per run/session
- Stash messages don’t include `runId`, making recovery hard
- Potential for stash pollution in shared environment

### 🛡️ Mitigation: Serialize Access or Use Isolated Working Trees

#### Option A: File Locking (Simple)

Use a lockfile to prevent concurrent git operations:

```ts
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';

const GIT_LOCK_PATH = '/tmp/watchdog-git.lock';

function withGitLock<T>(fn: () => T): T {
  while (existsSync(GIT_LOCK_PATH)) {
    sleep(100); // wait 100ms
  }

  writeFileSync(GIT_LOCK_PATH, process.pid.toString());
  try {
    return fn();
  } finally {
    rmSync(GIT_LOCK_PATH, { force: true });
  }
}

// Wrap git operations
withGitLock(() => {
  const stashResult = spawnSync({ ... });
});
```

#### Option B: Use `git worktree` per Run (Advanced)
Create isolated branches/working dirs per builder run.

> ✅ Prevents interference between concurrent passes

---

## 6. 🚦 Rate Limiting — Flood Protection

### ✅ Risk
No rate limiting on:
```ts
POST /api/watchdog/review
```
An attacker could:
- Flood the endpoint → OOM, disk exhaustion, DB bloat
- Trigger excessive `bun tsc`, `git`, or `opencode` spawns → DoS
- Bypass auth using high-volume guessing if token partial leak

### 🛡️ Mitigation: Add Per-Tenant Rate Limiting

Use in-memory counter (or Redis for scale):

```ts
// utils/rateLimiter.ts
const requestCounts = new Map<string, { count: number; timestamp: number }>();
const WINDOW_MS = 60_000; // 1 min
const MAX_REQ_PER_WINDOW = 10;

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(key);

  if (!record || now - record.timestamp > WINDOW_MS) {
    requestCounts.set(key, { count: 1, timestamp: now });
    return false;
  }

  if (record.count >= MAX_REQ_PER_WINDOW) {
    return true;
  }

  record.count++;
  return false;
}
```

Apply in `/review` route:

```ts
const key = `watchdog:${tenant_id}:${ip}`; // include IP if available
if (isRateLimited(key)) {
  return c.json({ error: 'Too many requests' }, 429);
}
```

> ✅ Limits abuse while allowing normal builder flow

---

## 7. 📦 Violation Storage — Sensitive Data Exposure

### ✅ Risk
`watchdog_violations` table stores:
- Full file paths
- Possibly **code snippets** containing secrets, PII, or API keys
- Errors from `tsc` or `import-checker` may leak internal structure

This data is accessible via future audit UIs — potential leak surface.

Also:
- No encryption at rest
- No access control on read endpoints (`/api/watchdog/violations`)

### 🛡️ Mitigation: Sanitize + Access Control + Encryption

#### A. Strip Code Snippets in Violations Table

Store only:
```sql
INSERT INTO watchdog_violations (
  run_id, file_path, gate_type, line_number, context_preview
) VALUES (?, ?, ?, ?, ?)
```
Where `context_preview` is **truncated** and sanitized (e.g., max 100 chars, no full secrets).

Avoid storing raw `stderr`, `stdout`, or full AST.

#### B. Add RBAC to Violation Read Endpoints

```ts
// middleware/requireRole.ts
function requireRole(roles: string[]) {
  return (c: Context, next: Function) => {
    const user = getUserFromAuth(c);
    if (!roles.includes(user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  };
}

// Apply
app.get('/api/watchdog/violations', requireRole(['admin', 'auditor']), handler);
```

#### C. Optional: Encrypt Sensitive Fields
For compliance, consider using SQLite encryption extensions (e.g., SQLCipher) or application-level envelope encryption.

> ✅ Limits blast radius of DB compromise

---

## 8. ✅ Recommended Mitigations Summary

| Risk | Mitigation | Code Impact |
|------|----------|------------|
| **Path Traversal** | Validate paths with `resolve` + `relative` containment | High — must add to all file inputs |
| **Command Injection** | Use arg arrays; never string join; validate project root | Medium |
| **Auth Bypass** | Bind to 127.0.0.1 + IP check + rotate token | Medium |
| **SSE Leak** | Validate tenant/session ownership in EventSource | High — critical for multi-tenancy |
| **Git Races** | Use file lock or `worktree` per run | Medium |
| **Rate Flooding** | In-memory rate limiter per tenant/IP | Low |
| **Violation Exposure** | Sanitize stored data; add role checks on read | High — affects audit UI design |

---

## ✅ Final Recommendations

1. **Add a security pre-commit hook** to scan for forbidden model strings — catch errors earlier.
2. **Log minimal PII** — avoid logging full file contents or environment variables.
3. **Monitor `/api/watchdog/review`** — alert on spikes or failed auth attempts.
4. **Set up structured logging** with redaction for file paths and tokens.
5. **Periodically audit `watchdog_violations` table** for accidental leakage patterns.

---

✅ **Conclusion**: The BuilderWatchdog adds valuable QA automation, but introduces several **high-severity risks** if unmitigated — particularly around **path traversal**, **tenant isolation**, and **data exposure**.

With the above fixes, the implementation can be made **production-secure** and **compliance-ready**.