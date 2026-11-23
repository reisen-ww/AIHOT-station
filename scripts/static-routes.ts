// Tiny build-time wrappers keep the original page components and loaders; no generated application fork.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import type { RouteConfigEntry } from "@react-router/dev/routes";

const ROUTE_EXPORTS = new Set(["default", "handle", "meta", "links", "ErrorBoundary", "shouldRevalidate"]);

export function staticRouteSource(source: string, importPath: string, deploymentPath: string): string {
  const file = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const names = new Set<string>();
  for (const node of file.program.body) {
    if (node.type === "ExportDefaultDeclaration") names.add("default");
    if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type") continue;
    for (const specifier of node.specifiers) names.add(specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value);
    const declaration = node.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) names.add(declaration.id.name);
    if (declaration?.type === "VariableDeclaration") for (const d of declaration.declarations) if (d.id.type === "Identifier") names.add(d.id.name);
  }
  for (const name of ["action", "clientAction", "middleware", "clientMiddleware"]) {
    if (names.has(name)) throw new Error(`Static public route has unsupported write/middleware export: ${name}`);
  }
  const exports = [...names].filter((n) => ROUTE_EXPORTS.has(n));
  const lines = [`// Generated from the existing public route. Do not edit.`, `export { ${exports.join(", ")} } from ${JSON.stringify(importPath)};`];
  if (names.has("loader")) {
    lines.push(`import { loader as read${names.has("clientLoader") ? ", clientLoader as preview" : ""} } from ${JSON.stringify(importPath)};`,
      `import { localLoaderRequest } from ${JSON.stringify(deploymentPath)};`,
      `export async function clientLoader(args: Parameters<typeof read>[0]) {`,
      `  const request = localLoaderRequest(args.request);`,
      `  const serverLoader = () => read({ ...args, request });`,
      names.has("clientLoader") ? `  return preview({ ...args, request, serverLoader });` : `  return serverLoader();`, `}`);
  } else if (names.has("clientLoader")) throw new Error("Static route has a client loader without a known public read");
  return `${lines.join("\n")}\n`;
}

export function wrapStaticRoutes(routes: RouteConfigEntry[], webDirectory: string): RouteConfigEntry[] {
  const app = path.join(webDirectory, "app");
  const generated = path.join(webDirectory, ".react-router/static-routes");
  const specifier = (from: string, to: string) => {
    const relative = path.relative(path.dirname(from), to).replaceAll("\\", "/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  return routes.filter((route) => !route.file.replaceAll("\\", "/").startsWith("routes/admin") && route.path !== "feedback").map((route) => {
    const original = path.resolve(app, route.file);
    const name = (route.id ?? route.file.replace(/\.[^.]+$/, "")).replace(/[^a-zA-Z0-9_-]/g, "-");
    const output = path.join(generated, `${name}.tsx`);
    mkdirSync(generated, { recursive: true });
    writeFileSync(output, staticRouteSource(readFileSync(original, "utf8"), specifier(output, original), specifier(output, path.join(app, "lib/deployment.ts"))));
    return { ...route, id: route.id ?? route.file.replace(/\.[^.]+$/, ""), file: path.relative(app, output).replaceAll("\\", "/"),
      ...(route.children ? { children: wrapStaticRoutes(route.children, webDirectory) } : {}) };
  });
}
