import { readJson } from "./store.js";
import { paths } from "./paths.js";
function envInt(name, d) {
    const v = process.env[name];
    return v ? parseInt(v, 10) : d;
}
export function loadConfig() {
    const f = readJson(paths.config, {});
    return {
        controlPort: envInt("WELD_CONTROL_PORT", f.controlPort ?? 7100),
        relayPort: envInt("WELD_RELAY_PORT", f.relayPort ?? 7101),
        rpcPort: envInt("WELD_RPC_PORT", f.rpcPort ?? 50052),
        apiPort: envInt("WELD_API_PORT", f.apiPort ?? 8080),
    };
}
