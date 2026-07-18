import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractGetRoutes } from "./routeInventory.mjs";

test("extractGetRoutes includes literal, alternation, and one-line static GET routes", () => {
  const source = [
    'if (method === "GET" && pathname === "/api/health") { return ok(); }',
    'if (method === "GET" && (pathname === "/api/content-health" || pathname === "/api/content-health/findings")) return ok();',
    'if (method === "GET" && pathname === "/api/auth/status") return ok();',
    'if (method === "GET" && pathname === "/api/stream") return stream();',
    'if (method === "GET" && pathname === `/api/items/${id}`) return item();',
    'if (method === "GET" && pathname.match(/^\\/api\\/items\\//)) return item();',
  ].join("\n");
  expect(extractGetRoutes(source)).toEqual([
    "/api/auth/status", "/api/content-health", "/api/content-health/findings", "/api/health",
  ]);
});

test("live router static GET inventory is complete and excludes SSE and dynamic paths", () => {
  const source = readFileSync(join(import.meta.dir, "../../server/api/router.ts"), "utf8");
  const inventory = extractGetRoutes(source);
  expect(inventory).not.toContain("/api/stream");
  expect(inventory.some((route) => route.includes("${"))).toBeFalse();
  expect(inventory).toContain("/api/content-health/findings");

  // Independent source parse: walk each GET conditional and collect literal
  // pathname alternatives.  The assertion deliberately does not call the
  // extractor, so router syntax changes cannot make both sides drift alike.
  const independent = new Set<string>();
  for (const statement of source.matchAll(/if\s*\(([\s\S]{0,900}?)\)\s*(?:\{|return)/g)) {
    const condition = statement[1]!;
    if (!/method\s*===\s*["']GET["']/.test(condition) || /\.match\s*\(|\bRegExp\b/.test(condition)) continue;
    for (const route of condition.matchAll(/pathname\s*===\s*(["'])([^"']*)\1/g)) {
      if (route[2] && !route[2]!.includes("${") && route[2] !== "/api/stream") independent.add(route[2]!);
    }
  }
  expect(inventory).toEqual([...independent].sort());
});
