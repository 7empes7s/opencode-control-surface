import { homeHandler } from "./home.ts";
import { autopipelineHandler } from "./autopipeline.ts";
import { doctorHandler } from "./doctor.ts";
import { modelsHandler } from "./models.ts";
import { newsBitesHandler } from "./newsbites.ts";
import { infraHandler } from "./infra.ts";
import { incidentsHandler } from "./incidents.ts";
import { streamHandler } from "./stream.ts";
import {
  autopipelineCommandHandler,
  modelsActionHandler,
  newsBitesDeployHandler,
  newsBitesDeployStatusHandler,
  infraServiceRestartHandler,
  infraRunTimerHandler,
} from "./actions.ts";

export async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // ── Config (token vend) ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config") {
    return new Response(
      JSON.stringify({ operatorToken: process.env.OPERATOR_TOKEN ?? "" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Read endpoints ─────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/stream") return streamHandler();
  if (method === "GET" && pathname === "/api/home") return homeHandler();
  if (method === "GET" && pathname === "/api/autopipeline") return autopipelineHandler();
  if (method === "GET" && pathname === "/api/doctor") return doctorHandler(url);
  if (method === "GET" && pathname === "/api/models") return modelsHandler();
  if (method === "GET" && pathname === "/api/newsbites") return newsBitesHandler();
  if (method === "GET" && pathname === "/api/infra") return infraHandler();
  if (method === "GET" && pathname === "/api/incidents") return incidentsHandler();

  // Deploy job status (GET with path param)
  const deployMatch = pathname.match(/^\/api\/newsbites\/deploy\/([^/]+)$/);
  if (method === "GET" && deployMatch) return newsBitesDeployStatusHandler(deployMatch[1]);

  // ── Mutating endpoints ─────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/autopipeline/command") return autopipelineCommandHandler(req);
  if (method === "POST" && pathname === "/api/models/action") return modelsActionHandler(req);
  if (method === "POST" && pathname === "/api/newsbites/deploy") return newsBitesDeployHandler(req);
  if (method === "POST" && pathname === "/api/infra/service-restart") return infraServiceRestartHandler(req);
  if (method === "POST" && pathname === "/api/infra/run-timer") return infraRunTimerHandler(req);

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}
