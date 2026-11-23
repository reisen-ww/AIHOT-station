// Wrappers are runtime entry points only. Restore the original routes' official annotations afterwards.
import { execFileSync } from "node:child_process";
import path from "node:path";

export function restoreRouteTypes(webDirectory: string) {
  execFileSync(process.execPath, [path.resolve(webDirectory, "../../node_modules/@react-router/dev/bin.cjs"), "typegen", ".",
    "--config", path.resolve(webDirectory, "../../scripts/typegen-vite.config.ts")], {
    cwd: webDirectory, stdio: "inherit", env: { ...process.env, AIHOT_STATIC_BUILD: "0" },
  });
}
