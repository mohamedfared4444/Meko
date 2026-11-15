import type { ProviderId } from "../types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";
import type { ProviderAdapter } from "./types-adapter";

/** سجل المزودات — يربط معرّف المزود بمرجع محوّله */
const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}
