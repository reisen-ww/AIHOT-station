// One bounded offline share batch. Exiting releases all font/layout caches before the next stage.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderOg, type OgCard } from "../packages/backend/src/media/og.ts";

const client = path.resolve(process.argv[2]);
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const jobs = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<{ file: string; card: OgCard }>;
if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 100) throw new Error("invalid static share batch");
for (const { file, card } of jobs) {
  const destination = path.resolve(client, file);
  if (!file.startsWith("og/") || !destination.startsWith(client + path.sep)) throw new Error("invalid static share output");
  const { png } = await renderOg(card);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, png);
}
