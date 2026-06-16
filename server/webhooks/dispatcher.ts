import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { whereTenant } from "../db/tenantScope.ts";

const SIGNATURE_HEADER = "X-CS-Signature";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

export type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  status: "active" | "disabled";
  createdAt: number;
  lastDeliveryAt: number | null;
  lastStatus: string | null;
  tenantId: string | null;
};

export type CreatedWebhook = { webhook: Omit<WebhookRow, "secret">; secret: string };

type DbWebhookRow = {
  id: string;
  url: string;
  secret: string;
  events: string;
  status: "active" | "disabled";
  created_at: number;
  last_delivery_at: number | null;
  last_status: string | null;
  tenant_id: string | null;
};

type DbDeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload_json: string;
  status: string;
  attempts: number;
  ts: number;
  tenant_id: string | null;
};

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function computeWebhookSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function parseEvents(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function rowToWebhook(row: DbWebhookRow): WebhookRow {
  return {
    id: row.id,
    url: row.url,
    events: parseEvents(row.events),
    status: row.status,
    createdAt: row.created_at,
    lastDeliveryAt: row.last_delivery_at,
    lastStatus: row.last_status,
    tenantId: row.tenant_id,
  };
}

function maskSecret(plain: string): string {
  if (plain.length <= 8) return "****";
  return `${plain.slice(0, 7)}…${plain.slice(-4)}`;
}

export function listWebhooksForTenant(): Array<Omit<WebhookRow, "secret"> & { secretMasked: string }> {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT id, url, secret, events, status, created_at, last_delivery_at, last_status, tenant_id
    FROM webhooks WHERE 1=1 ${tenant.clause}
    ORDER BY created_at DESC
  `).all(...tenant.params) as DbWebhookRow[];
  return rows.map((row) => {
    const base = rowToWebhook(row);
    return { ...base, secretMasked: maskSecret(row.secret) };
  });
}

export function getWebhookSecretById(id: string): string | null {
  if (!isDashboardDbEnabled()) return null;
  const db = getDashboardDb();
  if (!db) return null;
  const tenant = whereTenant();
  const row = db.query(`
    SELECT secret FROM webhooks WHERE id = ? ${tenant.clause}
  `).get(id, ...tenant.params) as { secret: string } | null;
  return row?.secret ?? null;
}

export type CreateWebhookInput = {
  url: string;
  events: string[];
};

export function createWebhook(input: CreateWebhookInput): CreatedWebhook | null {
  if (!isDashboardDbEnabled()) return null;
  const db = getDashboardDb();
  if (!db) return null;
  if (!input || typeof input.url !== "string" || !/^https?:\/\//i.test(input.url)) {
    throw new Error("Webhook url must be a valid http(s) URL.");
  }
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error("Webhook must subscribe to at least one event.");
  }
  const cleanEvents = input.events.map((e) => String(e).trim()).filter(Boolean);
  if (cleanEvents.length === 0) throw new Error("Webhook must subscribe to at least one event.");

  const tenantId = getCurrentTenantContext().tenantId;
  const id = generateId("wh");
  const secret = generateSecret();
  const now = Date.now();

  try {
    db.query(`
      INSERT INTO webhooks (id, url, secret, events, status, created_at, tenant_id)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.url, secret, cleanEvents.join(","), now, tenantId);
  } catch (err) {
    console.error("[webhooks] createWebhook insert failed", err);
    return null;
  }

  const webhook: Omit<WebhookRow, "secret"> = {
    id,
    url: input.url,
    events: cleanEvents,
    status: "active",
    createdAt: now,
    lastDeliveryAt: null,
    lastStatus: null,
    tenantId,
  };
  return { webhook, secret };
}

export function disableWebhook(id: string): boolean {
  if (!isDashboardDbEnabled()) return false;
  const db = getDashboardDb();
  if (!db) return false;
  if (!id) return false;
  const tenant = whereTenant();
  const result = db.query(`
    UPDATE webhooks SET status = 'disabled'
    WHERE id = ? ${tenant.clause}
  `).run(id, ...tenant.params);
  return result.changes > 0;
}

function findActiveWebhooksForEvent(event: string): DbWebhookRow[] {
  if (!isDashboardDbEnabled()) return [];
  const db = getDashboardDb();
  if (!db) return [];
  const tenant = whereTenant();
  const rows = db.query(`
    SELECT id, url, secret, events, status, created_at, last_delivery_at, last_status, tenant_id
    FROM webhooks WHERE status = 'active' ${tenant.clause}
  `).all(...tenant.params) as DbWebhookRow[];
  return rows.filter((row) => parseEvents(row.events).includes(event));
}

function recordDelivery(
  webhook: DbWebhookRow,
  event: string,
  payload: unknown,
  status: string,
  attempts: number,
  ts: number,
): void {
  const db = getDashboardDb();
  if (!db) return;
  try {
    db.query(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event, payload_json, status, attempts, ts, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `wd_${randomUUID()}`,
      webhook.id,
      event,
      JSON.stringify(payload ?? null),
      status,
      attempts,
      ts,
      webhook.tenant_id,
    );
    db.query(`
      UPDATE webhooks SET last_delivery_at = ?, last_status = ? WHERE id = ?
    `).run(ts, status, webhook.id);
  } catch (err) {
    console.error("[webhooks] recordDelivery failed", err);
  }
}

export type DispatchOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function dispatchToWebhook(
  webhook: DbWebhookRow,
  event: string,
  payload: unknown,
  options: DispatchOptions = {},
): Promise<{ ok: boolean; status: string; attempts: number }> {
  const ts = Date.now();
  const body = JSON.stringify({ event, payload, ts });
  const signature = computeWebhookSignature(webhook.secret, body);
  const f = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastErr: string | null = null;
  let lastStatus = "error";
  let attempts = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    attempts = i + 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await f(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: signature,
          "X-CS-Event": event,
          "X-CS-Delivery-Id": `wd_${randomUUID()}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        lastStatus = `ok:${res.status}`;
        recordDelivery(webhook, event, payload, lastStatus, attempts, ts);
        return { ok: true, status: lastStatus, attempts };
      }
      lastStatus = `http:${res.status}`;
      lastErr = `non-2xx response ${res.status}`;
      // Only retry on 5xx
      if (res.status < 500) {
        recordDelivery(webhook, event, payload, lastStatus, attempts, ts);
        return { ok: false, status: lastStatus, attempts };
      }
    } catch (err) {
      lastStatus = "error";
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  const finalStatus = lastErr ? `${lastStatus}:${lastErr.slice(0, 80)}` : lastStatus;
  recordDelivery(webhook, event, payload, finalStatus, attempts, ts);
  return { ok: false, status: finalStatus, attempts };
}

export async function dispatchEvent(
  event: string,
  payload: unknown,
  options: DispatchOptions = {},
): Promise<{ dispatched: number; ok: number; failed: number }> {
  if (!isDashboardDbEnabled()) {
    return { dispatched: 0, ok: 0, failed: 0 };
  }
  let targets: DbWebhookRow[];
  try {
    targets = findActiveWebhooksForEvent(event);
  } catch (err) {
    console.error("[webhooks] dispatchEvent lookup failed", err);
    return { dispatched: 0, ok: 0, failed: 0 };
  }
  if (targets.length === 0) {
    return { dispatched: 0, ok: 0, failed: 0 };
  }
  let ok = 0;
  let failed = 0;
  for (const wh of targets) {
    try {
      const res = await dispatchToWebhook(wh, event, payload, options);
      if (res.ok) ok += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[webhooks] dispatch to ${wh.id} threw`, err);
    }
  }
  return { dispatched: targets.length, ok, failed };
}

export const __test_only = {
  SIGNATURE_HEADER,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  parseEvents,
  generateId,
  generateSecret,
};

export function dispatchEventFireAndForget(event: string, payload: unknown): void {
  try {
    void dispatchEvent(event, payload).catch((err) => {
      console.error(`[webhooks] fire-and-forget dispatchEvent(${event}) failed`, err);
    });
  } catch (err) {
    console.error(`[webhooks] fire-and-forget dispatchEvent(${event}) threw synchronously`, err);
  }
}
