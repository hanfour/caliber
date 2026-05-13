// Node-only surface. Server runtime helpers backed by AsyncLocalStorage
// plus the global Zod errorMap installer. apps/web MUST NOT import from
// this subpath — its dependencies include `node:async_hooks` which
// webpack rejects in client bundles.

export { runWithLocale, currentLocale } from "./runtime.js";
export { setGlobalLocaleErrorMap } from "./setup.js";
