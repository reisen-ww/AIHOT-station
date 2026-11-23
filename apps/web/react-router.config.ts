import type { Config } from "@react-router/dev/config";
import { staticBuildConfig } from "../../scripts/static-config.ts";
import { spawn } from "node:child_process";
import { restoreRouteTypes } from "../../scripts/static-types.ts";
import path from "node:path";

const snapshot = staticBuildConfig();

export default {
  ssr: !snapshot,
  basename: snapshot ? `${snapshot.base}/` : "/",
  appDirectory: "app",
  buildDirectory: snapshot ? "build-static" : "build",
  ...(snapshot ? { buildEnd: async ({ reactRouterConfig }) => {
    // The serial build entry owns finalization and type restoration after this process exits.
    if (process.env.AIHOT_STATIC_COMPILE_ONLY === "1") return;
    try {
      // Keep the bundler's retained context outside the post-build stage's heap budget.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--max-old-space-size=192", path.resolve(import.meta.dirname, "../../scripts/static-finish.ts"), path.join(reactRouterConfig.buildDirectory, "client")], { stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error("static web finalization failed (" + (signal ?? code) + ")")));
      });
    } finally {
      restoreRouteTypes(import.meta.dirname);
    }
  } } : {}),
  // The whole route manifest ships with the page: no /__manifest?paths=… requests, whose answers are
  // cacheable for a year while a CDN's page cache would not key them on paths or version.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
