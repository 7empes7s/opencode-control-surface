import { auditFlagStore, isAuditWritten } from "./auditFlag.ts";
import { writeActionAudit } from "../db/writer.ts";
import { getAuthenticatedUser } from "../auth/session.ts";
import { checkToken } from "./actions.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UNAUDITED_EXCLUSIONS = new Set<string>([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
]);

function isInternalApiPath(pathname: string): boolean {
  return pathname === "/api/internal" || pathname.startsWith("/api/internal/");
}

export function isMutatingApiRequest(method: string, pathname: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (UNAUDITED_EXCLUSIONS.has(pathname)) return false;
  if (isInternalApiPath(pathname)) return false;
  return true;
}

function resolveActor(req: Request): string {
  const user = getAuthenticatedUser(req);
  if (user?.userId) return user.userId;
  if (checkToken(req)) return "operator";
  return "anonymous";
}

export async function withAuditBoundary(
  req: Request,
  pathname: string,
  actor: string,
  run: () => Promise<Response>,
): Promise<Response> {
  return auditFlagStore.run({ written: false }, async () => {
    const response = await run();
    try {
      if (
        response.ok
        && isMutatingApiRequest(req.method, pathname)
        && !isAuditWritten()
      ) {
        writeActionAudit({
          actor,
          actorSource: "audit-boundary",
          actionKind: "api.unaudited-mutation",
          targetType: "endpoint",
          targetId: pathname,
          risk: "low",
          resultStatus: "success",
          result: "Mutation completed without a first-class audit record — recorded at the boundary.",
          request: { method: req.method },
        });
      }
    } catch (error) {
      console.error("[audit-boundary] failed to write fallback audit row", error);
    }
    return response;
  });
}

export { resolveActor as resolveActorForAudit };
