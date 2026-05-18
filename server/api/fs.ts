import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";

// Safe root directories that can be browsed
const SAFE_ROOTS = [
  "/opt/",
  "/root/",
  "/etc/litellm/",
  "/var/lib/mimule/",
  "/root/.ssh/",
];

type FsEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: number;
};

type FsBrowseResponse = {
  path: string;
  parent: string | null;
  entries: FsEntry[];
};

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isPathSafe(requestedPath: string): boolean {
  const resolved = resolve(requestedPath);
  return SAFE_ROOTS.some(root => resolved.startsWith(resolve(root)));
}

function sanitizePath(input: string): string {
  // Remove null bytes and other dangerous characters
  return input.replace(/\0/g, "").replace(/[\x00-\x1f\x7f<>:"|?*]/g, "");
}

export function fsBrowseHandler(url: URL): Response {
  try {
    const params = url.searchParams;
    const rawPath = params.get("path") || "/";
    const filter = params.get("filter") || "";
    const type = params.get("type") || "";

    // Sanitize the path
    const cleanPath = sanitizePath(rawPath);
    
    // Resolve to absolute path
    const requestedPath = resolve(cleanPath === "/" ? "/opt/" : cleanPath);
    
    // Check if path is within safe roots
    if (!isPathSafe(requestedPath)) {
      return json(
        { error: "Access denied. Path is outside of allowed directories." },
        403
      );
    }

    // Check if path exists
    if (!existsSync(requestedPath)) {
      return json(
        { error: "Path not found." },
        404
      );
    }

    // Check if it's a directory
    const stat = statSync(requestedPath);
    if (!stat.isDirectory()) {
      return json(
        { error: "Path is not a directory." },
        400
      );
    }

    // Read directory contents
    const entries: FsEntry[] = [];
    const items = readdirSync(requestedPath, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = join(requestedPath, item.name);
      
      // Skip if not safe
      if (!isPathSafe(fullPath)) continue;
      
      // Apply filter if provided
      if (filter && !item.name.toLowerCase().includes(filter.toLowerCase())) continue;
      
      // Apply type filter if provided
      if (type === "file" && !item.isFile()) continue;
      if (type === "directory" && !item.isDirectory()) continue;
      
      try {
        const itemStat = statSync(fullPath);
        entries.push({
          name: item.name,
          path: fullPath,
          type: item.isFile() ? "file" : "directory",
          size: item.isFile() ? itemStat.size : undefined,
          modified: itemStat.mtime.getTime(),
        });
      } catch (e) {
        // Skip items we can't stat
        continue;
      }
    }

    // Sort entries: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const parent = requestedPath !== "/" ? dirname(requestedPath) : null;

    const response: FsBrowseResponse = {
      path: requestedPath,
      parent,
      entries,
    };

    return json(response);
  } catch (e) {
    console.error("[fs-browse] error:", e);
    return json(
      { error: e instanceof Error ? e.message : "Internal server error" },
      500
    );
  }
}