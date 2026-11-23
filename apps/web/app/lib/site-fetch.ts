// Interactive reads use the same public projection as route loaders, without patching global fetch.
import { STATIC_SITE, sitePath } from "./deployment.ts";

export async function siteFetch(path: string, init?: RequestInit): Promise<Response> {
  if (STATIC_SITE) return (await import("./static-api.ts")).staticFetch(path, init);
  return fetch(sitePath(path), init);
}
