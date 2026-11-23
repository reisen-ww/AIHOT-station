// Finish one compiled SPA in a fresh heap. The caller keeps the original build failure semantics.
import path from "node:path";
import { staticBuildConfig } from "./static-config.ts";
import { finishStaticWeb } from "./static-output.ts";

const snapshot = staticBuildConfig();
if (!snapshot || process.argv.length !== 3) throw new Error("static finalization requires explicit static build environment and client directory");
console.log(JSON.stringify(await finishStaticWeb(path.resolve(process.argv[2]), snapshot.dataDirectory, snapshot.station, snapshot.base, snapshot.siteUrl)));
