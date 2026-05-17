import { readdir, readFile } from "fs/promises";
import { join } from "path";

export interface TutorialMeta {
  slug: string;
  title: string;
  estimatedMinutes: number;
  description: string;
}

const TUTORIALS_DIR = join(process.cwd(), "docs/tutorials");

function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    fm[key] = value;
  }
  return fm;
}

export async function docsTutorialsHandler(): Promise<Response> {
  try {
    const files = await readdir(TUTORIALS_DIR);
    const mdFiles = files.filter(f => f.endsWith(".md") && f.match(/^\d+-/));

    const tutorials: TutorialMeta[] = [];
    for (const file of mdFiles) {
      const slug = file.replace(/\.md$/, "");
      const content = await readFile(join(TUTORIALS_DIR, file), "utf-8");
      const fm = parseFrontmatter(content);
      tutorials.push({
        slug,
        title: fm.title ?? slug,
        estimatedMinutes: parseInt(fm["estimated-time"]?.replace(/\D/g, "") ?? "10", 10),
        description: fm.description ?? "",
      });
    }

    tutorials.sort((a, b) => a.slug.localeCompare(b.slug));
    return Response.json({ tutorials });
  } catch {
    return Response.json({ tutorials: [] });
  }
}