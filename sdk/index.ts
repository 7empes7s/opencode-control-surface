export interface SkillHandler {
  (input: unknown): unknown;
}

export function defineSkill(
  manifest: Record<string, unknown>,
  handler: SkillHandler,
): void {
  const skillId = process.env.TIB_SKILL_ID;
  const tenantId = process.env.TIB_TENANT_ID;
  const instanceId = process.env.TIB_INSTANCE_ID;
  const inputRaw = process.env.TIB_INPUT;

  if (!skillId || !tenantId || !instanceId) {
    console.error("[tib-sdk] Missing required env vars: TIB_SKILL_ID, TIB_TENANT_ID, TIB_INSTANCE_ID");
    process.exit(1);
  }

  const input = inputRaw ? JSON.parse(inputRaw) : {};

  try {
    const output = handler(input);
    process.stdout.write(JSON.stringify(output));
  } catch (err) {
    console.error("[tib-sdk] Handler error:", err);
    process.exit(1);
  }
}