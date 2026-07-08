/**
 * Persisted config (rpcUrl, address, finalizer, toggle defaults...) lives in
 * `electron-store`. Validated through the Zod schema on every load so a
 * hand-edited or schema-drifted file gets healed back to defaults.
 */
import Store from "electron-store";
import { ConfigSchema, type Config } from "@shared/contracts";

interface FileShape {
  config: unknown;
}

const store = new Store<FileShape>({
  name: "crosslink-sidecar",
  schema: {
    config: { type: "object" },
  },
});

export function loadConfig(): Config {
  const raw = store.get("config");
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Heal: keep the keys that pass, drop the rest.
  console.warn("config validation failed, falling back to defaults", parsed.error.flatten());
  return ConfigSchema.parse({});
}

export function saveConfig(cfg: Config): Config {
  const validated = ConfigSchema.parse(cfg);
  store.set("config", validated);
  return validated;
}
