import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ok } from "./types.ts";
import type { DossierSource, DossierClaim, AgentRun, DossierArtifacts } from "./types";

// Tests override this read-only root so they never inspect or write production dossiers.
const DEFAULT_DOSSIERS_ROOT = "/opt/mimoun/openclaw-config/workspace/newsbites_editorial/dossiers";

export function getDossiersRoot(): string {
  return process.env.DASHBOARD_DOSSIERS_ROOT || DEFAULT_DOSSIERS_ROOT;
}

export async function findNewestDossierForSlug(slug: string): Promise<string | null> {
  const root = getDossiersRoot();
  let dateEntries;
  try {
    dateEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const dates = dateEntries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  for (const date of dates) {
    const dossierPath = join(root, date, slug);
    try {
      if ((await fs.stat(dossierPath)).isDirectory()) return dossierPath;
    } catch {
      // Keep scanning older dossier dates.
    }
  }
  return null;
}

// Helper function to safely read a file
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    console.warn(`[dossier] Could not read file ${filePath}:`, error);
    return null;
  }
}

// Helper function to safely read a JSON file
async function readJsonFileSafe<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[dossier] Could not read JSON file ${filePath}:`, error);
    return null;
  }
}

// Helper function to parse markdown table
function parseMarkdownTable(markdown: string, headerRow: number): DossierClaim[] {
  const lines = markdown.split("\n");
  const claims: DossierClaim[] = [];
  
  // Find the header separator line
  let separatorLineIndex = -1;
  for (let i = headerRow; i < lines.length; i++) {
    if (lines[i].includes("|---|")) {
      separatorLineIndex = i;
      break;
    }
  }
  
  if (separatorLineIndex === -1) return claims;
  
  // Parse data rows
  for (let i = separatorLineIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith("|")) continue;
    
    // Remove leading and trailing pipes and split by pipe
    const cells = line.slice(1, -1).split("|").map(cell => cell.trim());
    if (cells.length >= 5) {
      claims.push({
        claim: cells[0],
        sources: cells[1],
        evidenceQuality: cells[2],
        confidence: cells[3],
        notes: cells[4]
      });
    }
  }
  
  return claims;
}

// Helper function to parse dossier header into sections
function parseDossierHeader(content: string): Record<string, Record<string, string>> {
  const lines = content.split("\n");
  const sections: Record<string, Record<string, string>> = {};
  let inSection = "";
  let lastKey = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      inSection = trimmed.substring(3).trim();
      sections[inSection] = {};
      lastKey = "";
    } else if (inSection && trimmed.startsWith("- ")) {
      const rest = trimmed.substring(2);
      const colonIdx = rest.indexOf(":");
      if (colonIdx !== -1) {
        const key = rest.substring(0, colonIdx).trim();
        const value = rest.substring(colonIdx + 1).trim();
        sections[inSection][key] = value;
        lastKey = key;
      } else if (lastKey) {
        // Sub-item value for the previous key (e.g. "- Status:\n  - researching")
        const existing = sections[inSection][lastKey];
        sections[inSection][lastKey] = existing ? `${existing} ${rest}` : rest;
      }
    }
  }

  return sections;
}

// GET /api/dossier/:date/:slug - Get dossier artifacts
export async function getDossierArtifacts(req: Request, date: string, slug: string): Promise<Response> {
  try {
    const dossierPath = join(getDossiersRoot(), date, slug);
    
    // Check if dossier exists
    try {
      await fs.access(dossierPath);
    } catch {
      return new Response(JSON.stringify({ error: "Dossier not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // Read all artifacts
    const [
      dossierContent,
      sourcesContent,
      draftContent,
      verifyContent,
      publishContent,
      notesContent
    ] = await Promise.all([
      readFileSafe(join(dossierPath, "DOSSIER.md")),
      readFileSafe(join(dossierPath, "sources.json")),
      readFileSafe(join(dossierPath, "draft.md")),
      readFileSafe(join(dossierPath, "verify.md")),
      readFileSafe(join(dossierPath, "publish.md")),
      readFileSafe(join(dossierPath, "notes.md"))
    ]);
    
    // Parse DOSSIER.md to extract structured data
    let header: any = {};
    let claims: DossierClaim[] = [];

    if (dossierContent) {
      const sections = parseDossierHeader(dossierContent);
      const id = sections["Story Identity"] ?? {};
      const why = sections["Why This Story Matters"] ?? {};
      const angle = sections["Core Angle"] ?? {};

      header = {
        slug: id["Slug"] ?? "",
        headline: id["Working headline"] ?? id["Headline"] ?? "",
        vertical: id["Vertical"] ?? "",
        owner: id["Story owner"] ?? id["Owner"] ?? "",
        created: id["Created"] ?? "",
        updated: id["Last updated"] ?? id["Last Updated"] ?? "",
        status: id["Status"] ?? "",
        "Public importance": why["Public importance"] ?? "",
        "News value": why["News value"] ?? "",
        "Why now": why["Why now"] ?? "",
        "Why NewsBites should cover it": why["Why NewsBites should cover it"] ?? "",
        "One-sentence framing": angle["One-sentence framing"] ?? "",
        "What the story is not": angle["What the story is not"] ?? "",
      };

      // Try to parse claims table
      const claimsTableIndex = dossierContent.indexOf("## Claim Table");
      if (claimsTableIndex !== -1) {
        claims = parseMarkdownTable(dossierContent, claimsTableIndex);
      }
    }
    
    // Parse sources.json
    let sources: DossierSource[] = [];
    if (sourcesContent) {
      try {
        sources = JSON.parse(sourcesContent);
      } catch (error) {
        console.warn("[dossier] Failed to parse sources.json:", error);
      }
    }
    
    // Read agent runs
    const agentRuns: AgentRun[] = [];
    try {
      const agentRunsPath = join(dossierPath, "agent_runs");
      await fs.access(agentRunsPath);
      
      const runDirs = await fs.readdir(agentRunsPath);
      for (const runDir of runDirs) {
        const runPath = join(agentRunsPath, runDir);
        const stat = await fs.stat(runPath);
        
        if (stat.isDirectory()) {
          const [
            metadataContent,
            responseContent
          ] = await Promise.all([
            readFileSafe(join(runPath, "metadata.json")),
            readFileSafe(join(runPath, "response.json"))
          ]);
          
          let metadata = {};
          let response = {};
          
          if (metadataContent) {
            try {
              metadata = JSON.parse(metadataContent);
            } catch (error) {
              console.warn(`[dossier] Failed to parse metadata for ${runDir}:`, error);
            }
          }
          
          if (responseContent) {
            try {
              response = JSON.parse(responseContent);
            } catch (error) {
              console.warn(`[dossier] Failed to parse response for ${runDir}:`, error);
            }
          }
          
          // Extract stage from directory name (e.g., 20260417T234512Z-research -> research)
          const stageMatch = runDir.match(/-(\w+)$/);
          const stage = stageMatch ? stageMatch[1] : runDir;
          
          agentRuns.push({
            id: runDir,
            stage,
            startedAt: (metadata as any).createdAt || "",
            durationMs: null, // Would need to calculate from timestamps
            metadata,
            response
          });
        }
      }
    } catch (error) {
      console.warn("[dossier] Failed to read agent runs:", error);
    }
    
    const artifacts: DossierArtifacts = {
      slug,
      date,
      header,
      sources,
      claims,
      draftContent: draftContent || "",
      verifyContent,
      publishContent: publishContent || "",
      notesContent: notesContent || "",
      agentRuns
    };
    
    return new Response(JSON.stringify(ok(artifacts, {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[dossier] getDossierArtifacts failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch dossier artifacts" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// POST /api/dossier/:date/:slug/inject - Inject notes and optionally re-queue stage
export async function injectDossierNotes(req: Request, date: string, slug: string): Promise<Response> {
  try {
    const body = await req.json();
    const { notes, stage, requeue } = body;
    
    if (!notes) {
      return new Response(JSON.stringify({ error: "Notes content is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const dossierPath = join(getDossiersRoot(), date, slug);
    const notesPath = join(dossierPath, "notes.md");

    try {
      const stat = await fs.stat(dossierPath);
      if (!stat.isDirectory()) {
        return new Response(JSON.stringify({ error: "Dossier not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Dossier not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // Append notes to existing content
    let existingContent = "";
    try {
      existingContent = await fs.readFile(notesPath, "utf-8");
    } catch {
      // File doesn't exist, which is fine
    }
    
    const timestamp = new Date().toISOString();
    const newContent = `${existingContent}\n\n---\n# Injected Notes (${timestamp})\n${notes}\n`;
    
    await fs.writeFile(notesPath, newContent, "utf-8");
    
    // If requeue is requested, call autopipeline API
    if (requeue && stage) {
      try {
        const autopipelineUrl = "http://127.0.0.1:3200/command";
        await fetch(autopipelineUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd: "inject",
            dossierDir: dossierPath,
            stage
          })
        });
      } catch (error) {
        console.warn("[dossier] Failed to requeue stage:", error);
        // Don't fail the whole request if requeue fails
      }
    }
    
    return new Response(JSON.stringify(ok({ success: true }, {})), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("[dossier] injectDossierNotes failed:", error);
    return new Response(JSON.stringify({ error: "Failed to inject notes" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
