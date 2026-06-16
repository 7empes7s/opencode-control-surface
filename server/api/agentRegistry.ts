import { requireInsightPermission } from "./insights.ts";
import { getAgentPassport, listAgents, seedDefaultAgents } from "../agents/registry.ts";
import { ok } from "./types.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function plainError(message: string, status: number): Response {
  return json({ error: message }, status);
}

export async function agentRegistryListHandler(req: Request): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  seedDefaultAgents();
  const agents = listAgents();
  const counts = {
    total: agents.length,
    active: agents.filter((a) => a.status === "active").length,
    paused: agents.filter((a) => a.status === "paused").length,
    retired: agents.filter((a) => a.status === "retired").length,
  };
  return json(ok({ agents, counts }));
}

export async function agentPassportHandler(req: Request, id: string): Promise<Response> {
  const roleErr = requireInsightPermission(req, "insights.view");
  if (roleErr) return roleErr;

  seedDefaultAgents();
  const passport = getAgentPassport(id);
  if (!passport) {
    return plainError(`No agent is registered with id "${id}".`, 404);
  }
  return json(ok(passport));
}
