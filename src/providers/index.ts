import { ark } from "./ark.js";
import { glm } from "./glm.js";
import { kimi } from "./kimi.js";
import type { ProviderDef } from "./types.js";

export type { ProviderDef, ParsedUsages } from "./types.js";

/** 已注册的上游 provider。新增 provider 在此登记即可。 */
export const PROVIDERS: Record<string, ProviderDef> = {
  [kimi.id]: kimi,
  [glm.id]: glm,
  [ark.id]: ark,
};

/** 默认 provider:不带 provider 字段的 account 归入此项(向后兼容旧 config)。 */
export const DEFAULT_PROVIDER_ID = kimi.id;

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS[id];
}

export function isProviderId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}
