import { Database } from 'bun:sqlite';

const db = new Database('data/workflows.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    model TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    latencyMs INTEGER,
    attempts INTEGER DEFAULT 0
  )
`);

type Workflow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  model: string;
  input: string;
  output?: string;
  error?: string;
  latencyMs?: number;
  attempts: number;
};

export function createWorkflow(input: { model: string; input: string }): Workflow {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO workflows (id, createdAt, updatedAt, status, model, input, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, now, now, 'pending', input.model, input.input, 0);
  return {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    model: input.model,
    input: input.input,
    attempts: 0,
  };
}

export function getWorkflow(id: string): Workflow | undefined {
  return db
    .prepare('SELECT * FROM workflows WHERE id = ?')
    .get(id) as Workflow | undefined;
}

export function listWorkflows(limit = 50, offset = 0): Workflow[] {
  return db
    .prepare('SELECT * FROM workflows ORDER BY createdAt DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as Workflow[];
}

export function updateWorkflow(id: string, updates: Partial<Workflow>) {
  const now = Date.now();
  const setClause = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  const values: any = [...Object.values(updates), now, id];
  db.prepare(`UPDATE workflows SET ${setClause}, updatedAt = ? WHERE id = ?`).run(values);
}

export function deleteWorkflow(id: string) {
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
}

// Ensure data dir exists
try {
  Bun.write('data', '');
} catch {}
