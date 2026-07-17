/**
 * Loads backend/.env into process.env. Node entry point ONLY.
 *
 * Import this FIRST in src/main.ts, before anything that imports config.js:
 * config.ts computes its ENV constant at module-evaluation time, and ES imports
 * evaluate in source order, so this has to land first to be seen.
 *
 * Why a separate module rather than a runtime check inside config.ts: on
 * Workers, config must come from wrangler vars/secrets and a .env file must
 * never win. Feature-detecting the runtime does not work — `wrangler dev
 * --local` polyfills process.loadEnvFile AND has real filesystem access, so a
 * check for "is loadEnvFile available" happily read .env and quietly ran local
 * dev on the JSON store while the deployed Worker used D1. Sniffing for
 * Cloudflare globals was no better (navigator.userAgent was not what the docs
 * implied under wrangler dev).
 *
 * So: no detection. The Node entry opts in by importing this; the Worker entry
 * cannot, because it never imports it. The runtimes differ by construction, and
 * local can no longer silently diverge from production.
 *
 * §D.2 — uses Node's own loadEnvFile (≥20.12), no dependency. Real environment
 * variables always win: anything already set is restored afterwards, so the file
 * only fills gaps.
 */
function loadDotEnv(): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const loader = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loader !== 'function') return;
  try {
    const url = new URL('../.env', import.meta.url);
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env)) before[k] = process.env[k];
    loader(decodeURIComponent(url.pathname));
    for (const k of Object.keys(before)) {
      const prev = before[k];
      if (prev !== undefined) process.env[k] = prev;   // real env wins
    }
  } catch {
    // No .env (or unreadable) — the keyless mock default is intended here.
  }
}

loadDotEnv();
