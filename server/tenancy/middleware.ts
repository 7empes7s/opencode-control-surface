import { AsyncLocalStorage } from "node:async_hooks";
import { getTenantContext, DEFAULT_TENANT_ID } from "./context.ts";
import type { TenantContext } from "./context.ts";

export const tenantStore = new AsyncLocalStorage<TenantContext>();

export function getCurrentTenantContext(): TenantContext {
  return tenantStore.getStore() ?? { tenantId: DEFAULT_TENANT_ID, source: "default" };
}

export function withTenantContext<A extends unknown[]>(
  handler: (req: Request, ...args: A) => Response | Promise<Response>
): (req: Request, ...args: A) => Promise<Response> {
  return async (req: Request, ...args: A): Promise<Response> => {
    const ctx = getTenantContext(req);
    return tenantStore.run(ctx, () => handler(req, ...args));
  };
}
