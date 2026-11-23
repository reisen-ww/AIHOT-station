// Exercise the shipped modules with Vite's explicit constants, without starting Vite or reading .env.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const library = new URL("../../app/lib/", import.meta.url);
const environments = new Map<string, Record<string, string>>();
let nextId = 0;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL && new URL(context.parentURL);
    const id = parent && environments.has(parent.searchParams.get("static-test") ?? "") ? parent.searchParams.get("static-test") : null;
    if (id && specifier.startsWith(".")) {
      const target = new URL(specifier, parent!);
      if (target.href.startsWith(library.href)) {
        if (!target.pathname.endsWith(".ts")) target.pathname += ".ts";
        target.searchParams.set("static-test", id);
        return { url: target.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url);
    const env = environments.get(parsed.searchParams.get("static-test") ?? "");
    if (env && url.startsWith(library.href)) return {
      format: "module-typescript", shortCircuit: true,
      source: readFileSync(fileURLToPath(parsed), "utf8").replaceAll("import.meta.env", JSON.stringify(env)),
    };
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());

export function staticModules(station = "aihot") {
  const id = String(++nextId);
  environments.set(id, { VITE_STATION_STATIC: "1", VITE_STATIC_STATION: station,
    VITE_STATIC_BASE: `/hot-pages/${station}`, VITE_STATIC_SITE_URL: `https://reader.test/hot-pages/${station}` });
  const url = (name: string) => new URL(`${name}.ts?static-test=${id}`, library).href;
  return {
    api: () => import(url("static-api")) as Promise<typeof import("../../app/lib/static-api.ts")>,
    state: () => import(url("local-state")) as Promise<typeof import("../../app/lib/local-state.ts")>,
    cache: () => import(url("session-cache")) as Promise<typeof import("../../app/lib/session-cache.ts")>,
    restore: () => import(url("restore")) as Promise<typeof import("../../app/lib/restore.ts")>,
    deployment: () => import(url("deployment")) as Promise<typeof import("../../app/lib/deployment.ts")>,
    seo: () => import(url("seo")) as Promise<typeof import("../../app/lib/seo.ts")>,
    location: () => import(url("static-location")) as Promise<typeof import("../../app/lib/static-location.ts")>,
  };
}
