// Static GET routes declared in server/api/router.ts.  This deliberately
// operates on source text: the fresh-host probe must not import production
// handlers merely to discover what to probe.
export function extractGetRoutes(routerSource) {
  const routes = new Set();
  let offset = 0;
  while ((offset = routerSource.indexOf("if", offset)) !== -1) {
    const before = routerSource[offset - 1];
    const after = routerSource[offset + 2];
    if ((before && /[A-Za-z0-9_$]/.test(before)) || (after && /[A-Za-z0-9_$]/.test(after))) {
      offset += 2;
      continue;
    }
    let open = offset + 2;
    while (/\s/.test(routerSource[open] || "")) open += 1;
    if (routerSource[open] !== "(") {
      offset += 2;
      continue;
    }
    let depth = 0;
    let close = open;
    for (; close < routerSource.length; close += 1) {
      if (routerSource[close] === "(") depth += 1;
      else if (routerSource[close] === ")" && --depth === 0) break;
    }
    const condition = routerSource.slice(open + 1, close);
    offset = close + 1;
    if (!/method\s*===\s*["']GET["']/.test(condition)
      || /\.match\s*\(|\bRegExp\b/.test(condition)) continue;
    for (const match of condition.matchAll(/pathname\s*===\s*(["'])([^"']*)\1/g)) {
      const route = match[2];
      if (route && !route.includes("${")) routes.add(route);
    }
  }
  routes.delete("/api/stream");
  return [...routes].sort();
}
