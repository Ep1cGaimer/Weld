import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const root = process.env.WELD_HOME || join(homedir(), ".weld");
export const paths = {
    root,
    keys: join(root, "keys"),
    peers: join(root, "peers.json"),
    config: join(root, "config.json"),
    models: join(root, "models"),
    catalog: join(root, "models", "catalog.json"),
    bin: join(root, "bin"),
    cache: join(root, "cache"),
    rpcCache: join(root, "rpc-cache"),
    logs: join(root, "logs"),
};
const dirs = [
    paths.root,
    paths.keys,
    paths.models,
    paths.bin,
    paths.cache,
    paths.rpcCache,
    paths.logs,
];
export function ensureWeldHome() {
    for (const d of dirs)
        mkdirSync(d, { recursive: true });
}
