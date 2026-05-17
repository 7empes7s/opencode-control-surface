export interface CloudTierStatus {
  supported: boolean;
  provisionedAt: string | null;
  instanceUrl: string | null;
}

/**
 * Returns cloud-tier provisioning status.
 * In a real deployment this could read from a state file or env.
 */
export function cloudTierStatusHandler(): Response {
  const provisionedAt = process.env.CLOUD_TIER_PROVISIONED_AT ?? null;
  const instanceUrl = process.env.PUBLIC_HOSTNAME
    ? `https://${process.env.PUBLIC_HOSTNAME}`
    : null;

  const status: CloudTierStatus = {
    supported: true,
    provisionedAt,
    instanceUrl,
  };

  return new Response(JSON.stringify(status), {
    headers: { "Content-Type": "application/json" },
  });
}
