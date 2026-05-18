import { getDashboardDb } from "../db/dashboard.ts";
import { emitSignal } from "../orchestrator/signals.ts";
import { getLaneStatus } from "../orchestrator/lanes.ts";
import { listOrchestratorInstances, getInstanceWithHistory } from "../orchestrator/adapter.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";

type DbSignalRow = {
  id: string;
  instance_id: string;
  signal_name: string;
  payload_json: string;
  delivered: number;
  created_at: number;
};

export async function orchestratorSignalsListHandler(url: URL): Promise<Response> {
  const db = getDashboardDb();
  if (!db) {
    return Response.json({ signals: [] });
  }

  const tenantId = getCurrentTenantContext().tenantId;
  const instanceId = url.searchParams.get("instanceId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

  let rows: DbSignalRow[];
  if (instanceId) {
    rows = db
      .query(
        `SELECT * FROM orchestrator_signals WHERE instance_id = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(instanceId, tenantId, limit) as DbSignalRow[];
  } else {
    rows = db
      .query(`SELECT * FROM orchestrator_signals WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY created_at DESC LIMIT ?`)
      .all(tenantId, limit) as DbSignalRow[];
  }

  return Response.json({
    signals: rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      signalName: r.signal_name,
      payload: JSON.parse(r.payload_json),
      delivered: r.delivered === 1,
      createdAt: r.created_at,
    })),
  });
}

type DbLaneRow = {
  id: string;
  lane_name: string;
  max_concurrency: number;
  active_count: number;
  updated_at: number;
};

export async function orchestratorLanesHandler(): Promise<Response> {
  const db = getDashboardDb();
  if (!db) {
    return Response.json({ lanes: [] });
  }

  const tenantId = getCurrentTenantContext().tenantId;
  const rows = db
    .query(`SELECT * FROM orchestrator_lanes WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY lane_name ASC`)
    .all(tenantId) as DbLaneRow[];

  return Response.json({
    lanes: rows.map((r) => ({
      id: r.id,
      laneName: r.lane_name,
      maxConcurrency: r.max_concurrency,
      activeCount: r.active_count,
      updatedAt: r.updated_at,
    })),
  });
}

export async function orchestratorSignalEmitHandler(req: Request): Promise<Response> {
  let body: { instanceId: string; signalName: string; payload?: unknown };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.instanceId || !body.signalName) {
    return Response.json({ error: "instanceId and signalName are required" }, { status: 400 });
  }

  const db = getDashboardDb();
  if (!db) {
    return Response.json({ error: "Database not available" }, { status: 503 });
  }

  const tenantId = getCurrentTenantContext().tenantId;
  const id = emitSignal(body.instanceId, body.signalName, body.payload ?? null, tenantId);
  return Response.json({ id, ok: true });
}

export async function orchestratorInstancesListHandler(url: URL): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const instances = listOrchestratorInstances(limit);
  return Response.json({ instances });
}

export async function orchestratorInstanceDetailHandler(instanceId: string): Promise<Response> {
  const { instance, history } = getInstanceWithHistory(instanceId);
  if (!instance) {
    return Response.json({ error: "instance not found" }, { status: 404 });
  }
  return Response.json({ instance, history });
}
