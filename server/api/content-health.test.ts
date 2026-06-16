import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { writeEvent } from "../db/writer.ts";
import { getCurrentTenantContext } from "../tenancy/middleware.ts";
import { contentHealthHandler, contentHealthRunHandler } from "./content-health.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousArticlesPath: string | undefined;
let previousPublicPath: string | undefined;
let previousAllowedVerticals: string | undefined;
let previousDigestMinWords: string | undefined;
let previousExternalLinkLimit: string | undefined;
let previousExternalLinkTimeoutMs: string | undefined;
let previousAllowPrivateLinkProbes: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "content-health-api-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousArticlesPath = process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
  previousPublicPath = process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
  previousAllowedVerticals = process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS;
  previousDigestMinWords = process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS;
  previousExternalLinkLimit = process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_LIMIT;
  previousExternalLinkTimeoutMs = process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_TIMEOUT_MS;
  previousAllowPrivateLinkProbes = process.env.DASHBOARD_CONTENT_ALLOW_PRIVATE_LINK_PROBES;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
});

afterEach(() => {
  closeDashboardDb();
  if (previousDashboardDb === undefined) delete process.env.DASHBOARD_DB;
  else process.env.DASHBOARD_DB = previousDashboardDb;
  if (previousDashboardDbPath === undefined) delete process.env.DASHBOARD_DB_PATH;
  else process.env.DASHBOARD_DB_PATH = previousDashboardDbPath;
  if (previousArticlesPath === undefined) delete process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
  else process.env.DASHBOARD_CONTENT_ARTICLES_PATH = previousArticlesPath;
  if (previousPublicPath === undefined) delete process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
  else process.env.DASHBOARD_CONTENT_PUBLIC_PATH = previousPublicPath;
  if (previousAllowedVerticals === undefined) delete process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS;
  else process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = previousAllowedVerticals;
  if (previousDigestMinWords === undefined) delete process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS;
  else process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = previousDigestMinWords;
  if (previousExternalLinkLimit === undefined) delete process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_LIMIT;
  else process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_LIMIT = previousExternalLinkLimit;
  if (previousExternalLinkTimeoutMs === undefined) delete process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_TIMEOUT_MS;
  else process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_TIMEOUT_MS = previousExternalLinkTimeoutMs;
  if (previousAllowPrivateLinkProbes === undefined) delete process.env.DASHBOARD_CONTENT_ALLOW_PRIVATE_LINK_PROBES;
  else process.env.DASHBOARD_CONTENT_ALLOW_PRIVATE_LINK_PROBES = previousAllowPrivateLinkProbes;
  rmSync(tempDir, { recursive: true, force: true });
});

async function readJson(response: Response): Promise<any> {
  return response.json();
}

function writeArticle(root: string, file: string, frontmatter: Record<string, string>, body = "Body text."): void {
  const fields = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n");
  writeFileSync(join(root, file), `---\n${fields}\n---\n\n${body}\n`);
}

test("content health API summarizes persisted findings and detector events", async () => {
  getDashboardDb()!.query(`
    INSERT INTO content_health_findings (ts, slug, finding, severity, payload_json, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    100,
    "missing-cover",
    "article.missing_image",
    "warn",
    JSON.stringify({
      title: "Missing Cover",
      vertical: "ai",
      detail: "cover image not found",
      path: "/opt/newsbites/content/articles/missing-cover.md",
    }),
    getCurrentTenantContext().tenantId,
  );

  writeEvent({
    kind: "article.thin_digest",
    severity: "warn",
    entityType: "article",
    entityId: "thin-digest",
    summary: "Thin Digest: digest has 4 words",
    payload: {
      slug: "thin-digest",
      title: "Thin Digest",
      vertical: "startups",
      detail: "digest has 4 words",
      path: "/opt/newsbites/content/articles/thin-digest.md",
    },
  });

  const json = await readJson(await contentHealthHandler(new URL("http://localhost/api/content-health?limit=20")));

  expect(json.data.degraded).toBe(false);
  expect(json.data.summary.total).toBe(2);
  expect(json.data.summary.bySeverity.warn).toBe(2);
  expect(json.data.summary.affectedArticles).toBe(2);
  expect(json.data.summary.byKind["article.missing_image"]).toBe(1);
  expect(json.data.findings.map((row: { slug: string }) => row.slug)).toContain("thin-digest");
  expect(json.data.findings.map((row: { title: string }) => row.title)).toContain("Missing Cover");
});

test("content health API degrades cleanly when SQLite is disabled", async () => {
  closeDashboardDb();
  process.env.DASHBOARD_DB = "0";

  const json = await readJson(await contentHealthHandler(new URL("http://localhost/api/content-health")));

  expect(json.data.degraded).toBe(true);
  expect(json.data.findings).toEqual([]);
  expect(json.data.summary.total).toBe(0);
});

test("content health run endpoint executes detector and returns read model", async () => {
  const articlesRoot = join(tempDir, "articles");
  const publicRoot = join(tempDir, "public");
  mkdirSync(articlesRoot, { recursive: true });
  mkdirSync(publicRoot, { recursive: true });
  process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
  process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
  process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance";
  process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";

  writeArticle(articlesRoot, "bad.md", {
    title: "Bad Article",
    slug: "bad",
    status: "published",
    vertical: "unknown",
    lead: "short digest",
    digest: "short digest",
    coverImage: "/images/articles/missing.jpg",
  });

  const json = await readJson(await contentHealthRunHandler(new URL("http://localhost/api/content-health/run?limit=20")));

  expect(json.data.degraded).toBe(false);
  expect(json.data.scan.generatedFindings).toBe(3);
  expect(json.data.summary.total).toBe(3);
  expect(json.data.summary.byKind["article.missing_image"]).toBe(1);
  expect(json.data.findings.map((row: { slug: string }) => row.slug)).toEqual(["bad", "bad", "bad"]);
});

test("content health run endpoint probes external markdown links", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      return new Response(url.pathname === "/ok" ? "ok" : "missing", { status: url.pathname === "/ok" ? 200 : 404 });
    },
  });

  try {
    const articlesRoot = join(tempDir, "articles");
    const publicRoot = join(tempDir, "public");
    const imageDir = join(publicRoot, "images", "articles");
    mkdirSync(articlesRoot, { recursive: true });
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "ok.jpg"), "image");
    process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
    process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
    process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance";
    process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";
    process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_LIMIT = "5";
    process.env.DASHBOARD_CONTENT_EXTERNAL_LINK_TIMEOUT_MS = "1000";
    process.env.DASHBOARD_CONTENT_ALLOW_PRIVATE_LINK_PROBES = "1";

    writeArticle(articlesRoot, "links.md", {
      title: "Link Article",
      slug: "links",
      status: "published",
      vertical: "ai",
      lead: "The lead is intentionally different from the digest.",
      digest: "This digest has enough distinct words for the content health detector.",
      coverImage: "/images/articles/ok.jpg",
    }, `See [working](${server.url}ok) and [broken](${server.url}missing).`);

    const json = await readJson(await contentHealthRunHandler(new URL("http://localhost/api/content-health/run?limit=20")));
    const broken = json.data.findings.find((row: { kind: string }) => row.kind === "article.broken_link");

    expect(json.data.degraded).toBe(false);
    expect(json.data.scan.generatedFindings).toBe(1);
    expect(broken.severity).toBe("error");
    expect(broken.slug).toBe("links");
    expect(broken.payload.brokenLinks).toEqual([]);
    expect(broken.payload.brokenExternalLinks).toEqual([
      { target: `${server.url}missing`, status: 404, error: null },
    ]);
  } finally {
    server.stop(true);
  }
});
