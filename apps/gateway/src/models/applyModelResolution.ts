import { resolveModelAlias, type Platform } from "@caliber/gateway-core/models";
import type { ModelRegistry } from "./modelRegistry.js";

interface Input {
  requested: string;
  platform: Platform;
  baseUrl: string;
  enabled: boolean;
  registry: ModelRegistry;
  listCandidateTypes: () => Promise<Array<"api_key" | "oauth">>;
}

export interface Resolved {
  upstreamModel: string;
  wasAlias: boolean;
  family?: string;
}

export interface Output {
  requestedModel: string; // always the original alias
  cacheable: boolean; // false only for mixed-bucket
  upfront: Resolved | null; // present iff single-bucket: rewrite body now
  perAttempt: (credentialType: "api_key" | "oauth") => Resolved; // runtime path
}

export async function applyModelResolution(input: Input): Promise<Output> {
  const requestedModel = input.requested;

  const perAttempt = (credentialType: "api_key" | "oauth"): Resolved => {
    if (!input.enabled) {
      return { upstreamModel: requestedModel, wasAlias: false };
    }
    const cat = input.registry.get({
      platform: input.platform,
      baseUrl: input.baseUrl,
      credentialType,
    });
    const r = resolveModelAlias(requestedModel, input.platform, cat);
    return {
      upstreamModel: r.resolved,
      wasAlias: r.wasAlias,
      family: r.family,
    };
  };

  if (!input.enabled) {
    return { requestedModel, cacheable: true, upfront: null, perAttempt };
  }

  const types = [...new Set(await input.listCandidateTypes())];
  if (types.length === 1) {
    const upfront = perAttempt(types[0]!);
    return { requestedModel, cacheable: true, upfront, perAttempt };
  }

  // mixed-bucket (or zero candidates) → can't know served bucket up front
  return {
    requestedModel,
    cacheable: types.length === 0,
    upfront: null,
    perAttempt,
  };
}
