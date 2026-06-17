import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, readJob } from "../db/writer.ts";
import { runNewsBitesDeployContentHealthScan } from "./actions.ts";

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousArticlesPath: string | undefined;
let previousPublicPath: string | undefined;
let previousAllowedVerticals: string | undefined;
let previousDigestMinWords: string | undefined;

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "actions-api-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousArticlesPath = process.env.DASHBOARD_CONTENT_ARTICLES_PATH;
  previousPublicPath = process.env.DASHBOARD_CONTENT_PUBLIC_PATH;
  previousAllowedVerticals = process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS;
  previousDigestMinWords = process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS;
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
  rmSync(tempDir, { recursive: true, force: true });
});

function writeArticle(root: string, file: string, frontmatter: Record<string, string>, body = "Body text."): void {
  const fields = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join("\n");
  writeFileSync(join(root, file), `---\n${fields}\n---\n\n${body}\n`);
}

test("successful NewsBites deploy triggers a content health scan with job and audit evidence", async () => {
  const articlesRoot = join(tempDir, "articles");
  const publicRoot = join(tempDir, "public");
  mkdirSync(articlesRoot, { recursive: true });
  mkdirSync(publicRoot, { recursive: true });
  process.env.DASHBOARD_CONTENT_ARTICLES_PATH = articlesRoot;
  process.env.DASHBOARD_CONTENT_PUBLIC_PATH = publicRoot;
  process.env.DASHBOARD_CONTENT_ALLOWED_VERTICALS = "ai,finance";
  process.env.DASHBOARD_CONTENT_DIGEST_MIN_WORDS = "4";

  writeArticle(articlesRoot, "missing-cover.md", {
    title: "Missing Cover",
    slug: "missing-cover",
    status: "published",
    vertical: "ai",
    lead: "The lead has enough distinct words for scanning.",
    digest: "The digest has enough distinct words for scanning.",
    coverImage: "/images/articles/missing.jpg",
  });

  createJob({
    id: "deploy-job-1",
    kind: "newsbites-deploy",
    targetType: "deploy",
    targetId: "newsbites",
    command: "deploy",
    request: {},
  });

  let memoryOutput = "deploy complete\n";
  await runNewsBitesDeployContentHealthScan("deploy-job-1", memoryOutput, (output) => {
    memoryOutput = output;
  });

  const job = readJob("deploy-job-1");
  const event = getDashboardDb()!.query("SELECT kind, entity_id FROM events WHERE kind = ?")
    .get("article.missing_image") as { kind: string; entity_id: string } | null;
  const audit = getDashboardDb()!.query("SELECT action_kind, result_status, result FROM action_audit WHERE action_kind = ?")
    .get("content-health.post-deploy-scan") as { action_kind: string; result_status: string; result: string } | null;

  expect(memoryOutput).toContain("[content-health] post-deploy scan generated 1 finding");
  expect(job?.outputTail).toContain("[content-health] post-deploy scan generated 1 finding");
  expect(event).toEqual({ kind: "article.missing_image", entity_id: "missing-cover" });
  expect(audit).toEqual({
    action_kind: "content-health.post-deploy-scan",
    result_status: "success",
    result: "generated 1 finding",
  });
});
