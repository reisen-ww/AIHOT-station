// Build stages run in separate, non-overlapping Node processes; no API/worker/service lifecycle.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { staticBuildConfig } from "./static-config.ts";

type Runner = (phase: string, arguments_: string[], environment: NodeJS.ProcessEnv, cwd: string) => Promise<void>;
const runNode: Runner = async (phase, arguments_, env, cwd) => {
  console.log(JSON.stringify({ phase, state: "started" }));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=192", ...arguments_], { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error("static " + phase + " failed (" + (signal ?? code) + ")")));
  });
  console.log(JSON.stringify({ phase, state: "finished" }));
};

export async function buildStaticWeb(webDirectory: string, run: Runner = runNode) {
  const cli = path.resolve(webDirectory, "../../node_modules/@react-router/dev/bin.cjs");
  try {
    await run("compile", [cli, "build", "."], { ...process.env, AIHOT_STATIC_COMPILE_ONLY: "1" }, webDirectory);
    await run("finalize", [path.resolve(webDirectory, "../../scripts/static-finish.ts"), path.join(webDirectory, "build-static/client")], { ...process.env }, webDirectory);
  } finally {
    await run("restore-types", [cli, "typegen", ".", "--config", path.resolve(webDirectory, "../../scripts/typegen-vite.config.ts")], { ...process.env, AIHOT_STATIC_BUILD: "0", AIHOT_STATIC_COMPILE_ONLY: "0" }, webDirectory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!staticBuildConfig()) throw new Error("explicit static build environment required");
  await buildStaticWeb(path.resolve(import.meta.dirname, "../apps/web"));
}
