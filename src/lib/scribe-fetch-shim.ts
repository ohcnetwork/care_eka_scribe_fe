/**
 * The med-scribe-alliance SDK hardcodes `credentials: "include"` on every
 * fetch. The CARE API (django-cors-headers) does not send
 * `Access-Control-Allow-Credentials: true`, so browsers block those
 * cross-origin requests outright ("Failed to fetch" on the discovery
 * document, session calls and chunk uploads). Authentication is a Bearer
 * JWT header — cookies are never needed — so we downgrade `include` to
 * `same-origin` for requests targeting the scribe backend.
 */

/** Patch window fetch for SDK requests aimed at the scribe backend origin. */
export function installFetchCredentialsShim(backendOrigin: string): void {
  if (typeof globalThis.fetch !== "function") return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.credentials === "include") {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith(backendOrigin)) {
        init = { ...init, credentials: "same-origin" };
      }
    }
    return original(input, init);
  }) as typeof fetch;
}

const WORKER_FETCH_SHIM = `(() => {
  const orig = self.fetch.bind(self);
  self.fetch = (input, init) => {
    if (init && init.credentials === "include") {
      init = Object.assign({}, init, { credentials: "same-origin" });
    }
    return orig(input, init);
  };
})();
`;

const WORKER_BUNDLE_URL =
  "https://cdn.jsdelivr.net/npm/med-scribe-alliance-ts-sdk/dist/worker.bundle.js";

/**
 * Same as the SDK's createWorkerBlobUrl, but prepends a fetch shim so chunk
 * uploads from inside the worker don't send credentials either.
 */
export async function createShimmedWorkerBlobUrl(): Promise<string> {
  const response = await fetch(WORKER_BUNDLE_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch worker script: ${response.status} ${response.statusText}`,
    );
  }
  const source = await response.text();
  const blob = new Blob([WORKER_FETCH_SHIM, source], {
    type: "application/javascript",
  });
  return URL.createObjectURL(blob);
}
