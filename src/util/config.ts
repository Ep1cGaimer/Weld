import { readJson } from "./store.js";
import { paths } from "./paths.js";

export interface WeldConfig{
  controlPort: number;
  relayPort: number;
  rpcPort: number;
  apiPort: number;
}

function envInt(name: string, d: number): number{
  const v = process.env[name];
  return v ? parseInt(v, 10) : d;
}

export function loadConfig(): WeldConfig{
  const f = readJson<Partial<WeldConfig>>(paths.config, {});
  return {
    controlPort: envInt("WELD_CONTROL_PORT", f.controlPort ?? 7100),
    relayPort: envInt("WELD_RELAY_PORT", f.relayPort ?? 7101),
    rpcPort: envInt("WELD_RPC_PORT", f.rpcPort ?? 50052),
    apiPort: envInt("WELD_API_PORT", f.apiPort ?? 8080),
  }
}
