import { parseServerEnv, type ServerEnv } from "@caliber/config/env";

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (!cached) cached = parseServerEnv();
  return cached;
}
