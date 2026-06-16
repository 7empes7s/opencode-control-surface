import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { execSync } from "node:child_process";
import { writeActionAudit } from "../db/writer.ts";
import { requireMutation } from "../governance/rbac.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function audit(input: Parameters<typeof writeActionAudit>[0]): void {
  try { writeActionAudit(input); } catch {}
}

const ARTICLES_DIR = "/opt/newsbites/content/articles";
const IMAGES_DIR = "/opt/newsbites/public/images/articles";
const DOSSIERS_ROOT = "/opt/mimoun/openclaw-config/workspace/newsbites_editorial/dossiers";

// ─── helpers ────────────────────────────────────────────────────────────────

async function readArticle(slug: string): Promise<string | null> {
  try { return await fs.readFile(join(ARTICLES_DIR, `${slug}.md`), "utf-8"); }
  catch { return null; }
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*"?([^"]*)"?\s*$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

function patchFrontmatter(content: string, updates: Record<string, string>): string {
  let out = content;
  for (const [key, val] of Object.entries(updates)) {
    const escaped = val.replace(/"/g, '\\"');
    const re = new RegExp(`^${key}:.*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, `${key}: "${escaped}"`);
    } else {
      // Insert after first --- block
      out = out.replace(/^---\n/, `---\n${key}: "${escaped}"\n`);
    }
  }
  return out;
}

async function findDossierDate(slug: string): Promise<string | null> {
  try {
    const dirs = (await fs.readdir(DOSSIERS_ROOT)).sort().reverse();
    for (const dir of dirs) {
      try {
        await fs.access(join(DOSSIERS_ROOT, dir, slug));
        return dir;
      } catch {}
    }
  } catch {}
  return null;
}

function restartNewsBites() {
  execSync("systemctl restart newsbites.service", { timeout: 10_000 });
}

// ─── DELETE /api/newsbites/articles/:slug ────────────────────────────────────

export async function deleteArticleHandler(req: Request, slug: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const mdPath = join(ARTICLES_DIR, `${slug}.md`);
  let existed = false;
  try {
    await fs.access(mdPath);
    existed = true;
  } catch {
    return json({ error: "Article not found" }, 404);
  }

  try {
    await fs.unlink(mdPath);
    // Delete image (any extension)
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      const imgPath = join(IMAGES_DIR, `${slug}.${ext}`);
      try { await fs.unlink(imgPath); } catch {}
    }
    restartNewsBites();
    audit({
      actionKind: "newsbites.article.delete",
      targetType: "article",
      targetId: slug,
      risk: "high",
      reason: `Deleted article: ${slug}`,
      request: { slug },
      resultStatus: "success",
    });
    return json({ ok: true, message: `Article "${slug}" deleted` });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}

// ─── GET /api/newsbites/articles/:slug/dossier-path ──────────────────────────

export async function articleDossierPathHandler(_req: Request, slug: string): Promise<Response> {
  const date = await findDossierDate(slug);
  if (!date) return json({ date: null, slug });
  return json({ date, slug });
}

// ─── POST /api/newsbites/articles/:slug/refresh-image ────────────────────────

export async function refreshArticleImageHandler(req: Request, slug: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) return json({ error: "PEXELS_API_KEY not configured" }, 500);

  let body: { keywords?: string } = {};
  try { body = await req.json() as { keywords?: string }; } catch {}

  const content = await readArticle(slug);
  if (!content) return json({ error: "Article not found" }, 404);

  const fm = parseFrontmatter(content);
  const title = fm.title ?? slug;
  const vertical = fm.vertical ?? "";
  const tags = (fm.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  // Current photo ID to avoid
  let currentPhotoId: number | null = null;
  try {
    const src = JSON.parse(fm.imageSource ?? "{}");
    if (src.provider === "pexels" && src.sourceUrl) {
      const m = src.sourceUrl.match(/\/photo\/[^/]+-(\d+)\/?$/);
      if (m) currentPhotoId = Number(m[1]);
    }
  } catch {}

  // Build search query
  const query = body.keywords?.trim()
    || [vertical, ...title.split(/\s+/).filter((w) => w.length >= 5).slice(0, 4)].join(" ");

  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=20&orientation=landscape`;
    const res = await fetch(url, {
      headers: { Authorization: pexelsKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    const data = await res.json() as { photos: Array<{ id: number; src: Record<string, string>; photographer: string; photographer_url: string; url: string }> };
    const photos = data.photos ?? [];
    if (!photos.length) return json({ error: "No Pexels results for that query" }, 404);

    // Skip current photo
    const photo = photos.find((p) => p.id !== currentPhotoId) ?? photos[0];
    const imgUrl = photo.src?.landscape ?? photo.src?.large2x ?? photo.src?.large;
    if (!imgUrl) return json({ error: "No suitable image URL from Pexels" }, 500);

    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`Image download HTTP ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());

    const imgPath = join(IMAGES_DIR, `${slug}.jpg`);
    await fs.writeFile(imgPath, buf);

    const coverImage = `/images/articles/${slug}.jpg`;
    const imageSource = JSON.stringify({
      type: "stock",
      provider: "pexels",
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      sourceUrl: photo.url,
      photoId: photo.id,
    });

    const patched = patchFrontmatter(content, { coverImage, imageSource });
    await fs.writeFile(join(ARTICLES_DIR, `${slug}.md`), patched, "utf-8");

    audit({
      actionKind: "newsbites.article.refresh-image",
      targetType: "article",
      targetId: slug,
      risk: "low",
      reason: `Refreshed cover image for: ${slug} (query: ${query})`,
      request: { slug, query },
      resultStatus: "success",
    });

    return json({
      ok: true,
      coverImage,
      photographer: photo.photographer,
      photographerUrl: photo.photographer_url,
      sourceUrl: photo.url,
      query,
    });
  } catch (e) {
    return json({ error: errorMessage(e) }, 502);
  }
}

// ─── POST /api/newsbites/articles/:slug/upload-image ─────────────────────────

export async function uploadArticleImageHandler(req: Request, slug: string): Promise<Response> {
  const denied = requireMutation(req);
  if (denied) return denied;

  const content = await readArticle(slug);
  if (!content) return json({ error: "Article not found" }, 404);

  let formData: FormData;
  try { formData = await req.formData(); }
  catch (e) { return json({ error: `Failed to parse form data: ${errorMessage(e)}` }, 400); }

  const file = formData.get("image") as File | null;
  if (!file) return json({ error: "No image file provided" }, 400);

  const rawExt = extname(file.name).toLowerCase().replace(".", "") || "jpg";
  const ext = ["jpg", "jpeg", "png", "webp"].includes(rawExt) ? rawExt : "jpg";
  if (file.size > 10 * 1024 * 1024) return json({ error: "Image must be under 10MB" }, 400);

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    // Remove any old image files for this slug
    for (const oldExt of ["jpg", "jpeg", "png", "webp"]) {
      try { await fs.unlink(join(IMAGES_DIR, `${slug}.${oldExt}`)); } catch {}
    }
    const imgPath = join(IMAGES_DIR, `${slug}.${ext}`);
    await fs.writeFile(imgPath, buf);

    const coverImage = `/images/articles/${slug}.${ext}`;
    const imageSource = JSON.stringify({ type: "custom", uploadedAt: new Date().toISOString() });
    const patched = patchFrontmatter(content, { coverImage, imageSource });
    await fs.writeFile(join(ARTICLES_DIR, `${slug}.md`), patched, "utf-8");

    audit({
      actionKind: "newsbites.article.upload-image",
      targetType: "article",
      targetId: slug,
      risk: "low",
      reason: `Uploaded custom cover image for: ${slug}`,
      request: { slug, filename: file.name },
      resultStatus: "success",
    });

    return json({ ok: true, coverImage });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}
