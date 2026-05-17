# Skill Bundle Format & Manifest Schema

**Version**: 1.0.0

---

## Overview

A skill bundle is a signed, versioned package of instructions, templates, and assets that extends Builder's capabilities. Skills are installed via the Marketplace (`POST /api/marketplace/skills/install`) and loaded at runtime for specific passes.

---

## Bundle Structure

A skill bundle is a `.builder-skill` file (tar+gzip archive):

```
echo-skill.builder-skill
├── manifest.json       # Skill metadata
├── skill.md            # Main instruction file (consumed by the agent)
├── templates/          # Optional file templates
│   ├── report.md
│   └── alert.json
├── assets/             # Optional static assets
│   └── icon.svg
└── tests/              # Optional validation tests
    └── test.sh
```

---

## manifest.json Schema

```json
{
  "schemaVersion": "1.0",
  "name": "health-report",
  "version": "1.2.0",
  "description": "Generates structured health reports from diagnostic data",
  "author": "platform@tib.com",
  "tags": ["reporting", "health", "diagnostics"],
  "license": "MIT",
  "minBuilderVersion": "1.0.0",
  "runtime": "opencode" | "codex" | "claude",
  "permissions": ["filesystem:read", "network:none"],
  "envVars": [],
  "tests": ["tests/test.sh"],
  "checksum": "sha256:...",
  "signature": "base64:..."
}
```

### Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `schemaVersion` | string | Yes | Must be "1.0" |
| `name` | string | Yes | Unique skill name (lowercase, hyphens allowed) |
| `version` | string | Yes | Semver (e.g., "1.2.0") |
| `description` | string | Yes | One-paragraph description |
| `author` | string | No | Contact email |
| `tags` | string[] | No | Categories for search |
| `license` | string | No | SPDX license identifier |
| `minBuilderVersion` | string | No | Minimum builder version required |
| `runtime` | enum | Yes | Which agent type can use this skill |
| `permissions` | string[] | No | Sandbox permissions (filesystem, network) |
| `envVars` | EnvVar[] | No | Required environment variables |
| `tests` | string[] | No | Paths to test scripts |
| `checksum` | string | Yes | SHA256 of full bundle contents |
| `signature` | string | Yes | Base64-encoded Ed25519 signature of manifest |

---

## skill.md

The main instruction file. This is prepended to the pass prompt when the skill is loaded.

```markdown
# Health Report Skill

## Purpose
This skill generates a structured health report from raw diagnostic output.

## Input Format
The agent receives diagnostic data in JSON format:
```json
{
  "services": [...],
  "gpu": {...},
  "errors": [...]
}
```

## Output Format
The report must be written to `REPORT.md` in the artifact directory.

## Sections
1. **Summary** — one-paragraph overview of system health
2. **Service Status** — table of services and their status
3. **Issues Found** — list of issues with severity
4. **Recommended Actions** — prioritized list of fixes

## Validation
After writing REPORT.md, run `test -f REPORT.md && wc -l REPORT.md | awk '$1 > 10'` to confirm the report has sufficient content.
```

---

## $ref Resolution

Skills can reference other files within the bundle using `$ref`:

```markdown
## Template
Use the report template:
$ref: templates/report.md
```

The `$ref` is resolved to the file contents at load time. `$ref` can also point to external URLs (must be HTTPS and same origin as the bundle, or pre-registered in the marketplace config).

---

## Signing

Every skill bundle must be signed. The signature proves the bundle was created by the stated author and has not been tampered with.

### Signing Process

1. Create `manifest.json` with all fields except `signature`
2. Compute `checksum` — SHA256 of the full bundle tar (in deterministic order)
3. Sign the `checksum` with the author's Ed25519 private key
4. Add `"signature": "base64:<base64-encoded-signature>"` to manifest
5. Re-tar the bundle

### Verification

```bash
# Extract public key from author (stored in marketplace config)
# Verify signature:
openssl dgst -sha256 -verify pubkey.pem -signature manifest.sig manifest.json
```

### Unsigned Bundles

The marketplace allows unsigned bundles with a warning:
```
[marketplace] Bundle 'echo-skill' is unsigned — allowing with warning
```

For production deployments, configure marketplace to reject unsigned bundles:
```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -d '{ "requireSignedBundles": true }' \
  https://control.techinsiderbytes.com/api/marketplace/config
```

---

## Installation

```bash
# Via CLI
builder skill install health-report

# Via API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{ "name": "health-report", "version": "1.2.0" }' \
  https://control.techinsiderbytes.com/api/marketplace/skills/install
```

After installation, use in a workflow:
```yaml
- id: report
  agent: opencode
  skillBundle: "health-report"
  prompt: |
    Generate a health report from the diagnostic data
    in /tmp/diagnostics.json.
```

---

## Marketplace API

### GET /api/marketplace/skills
List available skills.

**Response**: `{ data: SkillBundleSummary[] }`

### POST /api/marketplace/skills/install
Install a skill.

**Request**: `{ "name": string, "version"?: string }`

**Response**: `{ ok: true, installed: SkillBundle }`

### DELETE /api/marketplace/skills/:name
Uninstall a skill.

**Response**: `{ ok: true }`

### POST /api/marketplace/skills/:name/enable
Enable a skill (auto-loaded for matching passes).

**Response**: `{ ok: true }`

### POST /api/marketplace/skills/:name/disable
Disable a skill.

**Response**: `{ ok: true }`

### POST /api/marketplace/skills/:name/run
Run a skill's built-in test.

**Response**: `{ ok: true, output: string, exitCode: number }`

### GET /api/marketplace/skills/:name/runs
List recent runs of this skill.

**Response**: `{ data: SkillRun[] }`