import { useState, useCallback } from "react";

const TENANT_KEY = "activeTenantId";
const PROJECT_KEY = "activeProjectId";
const DEFAULT_TENANT = "mimule";
const DEFAULT_PROJECT = "opencode-control-surface";

export function getActiveTenantId(): string {
  return localStorage.getItem(TENANT_KEY) ?? DEFAULT_TENANT;
}

export function getActiveProjectId(): string {
  return localStorage.getItem(PROJECT_KEY) ?? DEFAULT_PROJECT;
}

export function setActiveTenantId(id: string): void {
  localStorage.setItem(TENANT_KEY, id);
  // Reset project when tenant changes
  localStorage.removeItem(PROJECT_KEY);
}

export function setActiveProjectId(id: string): void {
  localStorage.setItem(PROJECT_KEY, id);
}

export function useTenantContext() {
  const [tenantId, setTenantIdState] = useState<string>(getActiveTenantId);
  const [projectId, setProjectIdState] = useState<string>(getActiveProjectId);

  const setTenantId = useCallback((id: string) => {
    setActiveTenantId(id);
    setTenantIdState(id);
    const newProject = getActiveProjectId();
    setProjectIdState(newProject);
  }, []);

  const setProjectId = useCallback((id: string) => {
    setActiveProjectId(id);
    setProjectIdState(id);
  }, []);

  return { tenantId, projectId, setTenantId, setProjectId };
}
