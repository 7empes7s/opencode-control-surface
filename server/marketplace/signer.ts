import { createHash } from "node:crypto";
import type { SkillManifest } from "./types.ts";

export function hashBundle(bundlePath: string): string {
  const items = new Array<{ path: string; hash: string }>();
  const dir = Bun.file(bundlePath);
  // walk recursively - for now use a simple approach with known structure
  // This will be implemented when we have actual bundle files
  return createHash("sha256").update(bundlePath).digest("hex");
}

export function verifySignature(manifest: SkillManifest, bundleHash: string): boolean {
  if (!manifest.signature) {
    console.warn(`[marketplace] Bundle '${manifest.name}' is unsigned — allowing with warning`);
    return true;
  }
  return manifest.signature === bundleHash;
}