export const DEFAULT_TENANT_ID = "mimule";

export function DEFAULT_PROJECT_ID(): string {
  return "opencode-control-surface";
}

export type TenantContext = {
  tenantId: string;
  projectId?: string;
  actor?: string;
  source: "default" | "header" | "session" | "test";
};

export function getTenantContext(request?: Request): TenantContext {
  if (!request) {
    return {
      tenantId: DEFAULT_TENANT_ID,
      projectId: DEFAULT_PROJECT_ID(),
      source: "default",
    };
  }

  const headerTenant = request.headers.get("x-tenant-id");
  const headerProject = request.headers.get("x-project-id");
  const headerActor = request.headers.get("x-actor");

  if (headerTenant) {
    return {
      tenantId: assertTenantId(headerTenant),
      projectId: headerProject || undefined,
      actor: headerActor || undefined,
      source: "header",
    };
  }

  const url = new URL(request.url);
  const queryTenant = url.searchParams.get("tenant");
  const queryProject = url.searchParams.get("project");

  if (queryTenant) {
    return {
      tenantId: assertTenantId(queryTenant),
      projectId: queryProject || undefined,
      source: "header",
    };
  }

  return {
    tenantId: DEFAULT_TENANT_ID,
    projectId: queryProject || DEFAULT_PROJECT_ID(),
    source: "default",
  };
}

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertTenantId(value: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid tenant ID: expected string, got ${typeof value}`);
  }

  const trimmed = value.trim();
  if (!TENANT_ID_RE.test(trimmed)) {
    throw new Error(`Invalid tenant ID: "${value}" does not match pattern [a-z0-9][a-z0-9_-]{0,63}`);
  }

  return trimmed;
}

export function testTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: DEFAULT_TENANT_ID,
    projectId: DEFAULT_PROJECT_ID(),
    source: "test",
    ...overrides,
  };
}
