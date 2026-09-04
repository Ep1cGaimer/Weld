import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, "utf-8"));
    }
    catch {
        return fallback;
    }
}
export function writeJson(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
}
