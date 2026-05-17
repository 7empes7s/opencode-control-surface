# @tib-builder/sdk

Local skill authoring SDK for the TIB Control Surface marketplace.

## Example

```ts
// index.ts
import { defineSkill } from "@tib-builder/sdk";

defineSkill(
  {
    name: "my-echo",
    version: "1.0.0",
    kind: "workflow-skill",
    description: "Echoes the input back",
    entrypoint: "index.ts",
    inputs: { msg: { type: "string" } },
    outputs: { echo: { type: "string" } },
    permissions: [],
  },
  (input) => ({ echo: input.msg })
);
```

## Environment Variables

The loader injects these when running your skill:

| Variable | Description |
|---|---|
| `TIB_SKILL_ID` | Skill instance ID |
| `TIB_TENANT_ID` | Tenant ID |
| `TIB_INSTANCE_ID` | Run instance ID |
| `TIB_PERMISSIONS` | Comma-separated permission list |
| `TIB_INPUT` | JSON-encoded input |
| `OPERATOR_TOKEN` | Set if skill has `vault.read` permission |