export { buildAuthConfig, type AuthEnv } from "./config.js";
export {
  decideSignUp,
  type SignUpDecision,
  type BootstrapConfig,
} from "./bootstrap.js";
export {
  buildProviders,
  configuredProviderIds,
  type ProviderEnv,
} from "./providers.js";
export { makeAdapter } from "./drizzle-adapter.js";
export {
  resolvePermissions,
  type UserPermissions,
  type ActiveAssignment,
  type Role,
  type ScopeType,
  type Action,
  ROLE_RANK,
  expandScope,
  type ExpandedScope,
  can,
} from "./rbac/index.js";
