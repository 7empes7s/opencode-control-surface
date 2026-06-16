import { AsyncLocalStorage } from "node:async_hooks";

export const auditFlagStore: AsyncLocalStorage<{ written: boolean }> =
  new AsyncLocalStorage<{ written: boolean }>();

export function markAuditWritten(): void {
  const store = auditFlagStore.getStore();
  if (store) {
    store.written = true;
  }
}

export function isAuditWritten(): boolean {
  return auditFlagStore.getStore()?.written === true;
}
