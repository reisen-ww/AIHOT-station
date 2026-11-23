import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStaticWeb } from "../../../scripts/build-static.ts";

test("compile exits before finalization starts and type restoration is last", async () => {
  const phases: string[] = [];
  await buildStaticWeb("/isolated/web", async (phase, _args, environment) => {
    phases.push(phase);
    if (phase === "compile") assert.equal(environment.AIHOT_STATIC_COMPILE_ONLY, "1");
    if (phase === "restore-types") assert.equal(environment.AIHOT_STATIC_BUILD, "0");
  });
  assert.deepEqual(phases, ["compile", "finalize", "restore-types"]);
});

for (const failed of ["compile", "finalize"]) test(failed + " failure cannot report success and still restores route types", async () => {
  const phases: string[] = [];
  await assert.rejects(buildStaticWeb("/isolated/web", async (phase) => {
    phases.push(phase);
    if (phase === failed) throw new Error("isolated " + failed + " failure");
  }), new RegExp("isolated " + failed + " failure"));
  assert.deepEqual(phases, failed === "compile" ? ["compile", "restore-types"] : ["compile", "finalize", "restore-types"]);
});
