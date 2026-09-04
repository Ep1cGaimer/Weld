import { basename, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readJson, writeJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { parseGgufHeader } from "./gguf.js";
export function loadCatalog() {
    return readJson(paths.catalog, []).filter((e) => existsSync(e.path));
}
export function saveCatalog(entries) {
    writeJson(paths.catalog, entries);
}
export function describe(path) {
    const abs = resolve(path);
    const info = parseGgufHeader(abs);
    const arch = String(info.meta["general.architecture"] || "unknown");
    const sizeLabel = String(info.meta["general.size_label"] || "");
    return {
        id: basename(abs).replace(/\.gguf$/i, ""),
        file: basename(abs),
        path: abs,
        bytes: statSync(abs).size,
        arch,
        params: sizeLabel,
        addedAt: new Date().toISOString(),
    };
}
export function upsert(entry) {
    saveCatalog([...loadCatalog().filter((e) => e.id !== entry.id), entry]);
}
export function findModel(idOrPath) {
    const byId = loadCatalog().find((e) => e.id === idOrPath || e.file === idOrPath);
    if (byId)
        return byId;
    const abs = resolve(idOrPath);
    if (existsSync(abs) && abs.toLowerCase().endsWith(".gguf"))
        return describe(abs);
    return null;
}
