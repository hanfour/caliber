// Shared anti-forgery constant for `evalAccountPin.ts` and `replayOfHeader.ts`.
//
// Both modules trust their respective internal header ONLY when the request
// authenticated with an eval key (this prefix). Eval keys' raw values exist
// only in gateway-internal Redis (minted by
// apps/api/src/services/llmEvalKeyProvisioning.ts, raw key
// `caliber-eval-<random>`), so an external client cannot hold one — making
// the prefix a sufficient anti-forgery gate for both guards.
//
// Extracted here to keep the constant single-sourced; each consumer keeps
// its own short, independently readable guard body.

export const EVAL_KEY_PREFIX = "caliber-eval";
