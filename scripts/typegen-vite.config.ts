// The official type generator resolves Vite first; prohibit automatic .env loading there too.
import path from "node:path";
import original from "../apps/web/vite.config.ts";
export default { ...original, root: path.resolve(import.meta.dirname, "../apps/web"), envDir: false };
