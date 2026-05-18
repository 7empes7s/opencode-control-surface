import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import type { TenantContext } from "../tenancy/context.ts";
import { DEFAULT_TENANT_ID } from "../tenancy/context.ts";

export function coalesceTenantId(value: string | null | undefined): string {
  return value ?? DEFAULT_TENANT_ID;
}

export function whereTenant(
  ctx?: TenantContext,
  alias?: string,
): { clause: string; params: string[] } {
  const tenantId = (ctx ?? getCurrentTenantContext()).tenantId;
  const prefix = alias ? `${alias}.` : "";
  // During transition, rows with NULL tenant_id are treated as DEFAULT_TENANT_ID
  if (tenantId === DEFAULT_TENANT_ID) {
    return {
      clause: ` AND (${prefix}tenant_id = ? OR ${prefix}tenant_id IS NULL)`,
      params: [tenantId],
    };
  }
  return { clause: ` AND ${prefix}tenant_id = ?`, params: [tenantId] };
}

export function tenantParams(
  ctx: TenantContext | undefined,
  ...rest: Array<string | number | null | undefined>
): Array<string | number | null> {
  const tenantId = (ctx ?? getCurrentTenantContext()).tenantId;
  return [tenantId, ...rest];
}

export function withTenantInsert<T extends Record<string, unknown>>(
  ctx: TenantContext | undefined,
  row: T,
): T & { tenant_id: string } {
  const tenantId = (ctx ?? getCurrentTenantContext()).tenantId;
  return { ...row, tenant_id: tenantId };
}
