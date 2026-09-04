import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureWeldHome, paths } from "../util/paths.js";
import { baseAsset, binDir, binariesReady, cudaAssets, downloadFile, extract, hasNvidia, listDevices, llamaVersion, PINNED_BUILD, writeManifest, } from "../core/binaries.js";
import { banner, bullet, fail, info, kv, line, ok, Progress, rule, step, warn } from "../ui.js";
export async function cmdSetup() {
    ensureWeldHome();
    const dir = binDir();
    mkdirSync(dir, { recursive: true });
    banner("0.1.0", `setup ${sym()}  llama.cpp ${PINNED_BUILD}`);
    rule("runtime");
    const base = baseAsset();
    await fetchAsset(base.url, join(paths.cache, base.file), base.label);
    extract(join(paths.cache, base.file), dir);
    ok(`${base.label} installed`);
    const skipCuda = process.env.WELD_SKIP_CUDA === "1";
    if (process.platform === "win32") {
        if (hasNvidia() && !skipCuda) {
            line();
            rule("cuda");
            info("nvidia gpu detected — pulling cuda backend + runtime (~610MB, resumable)");
            for (const asset of cudaAssets()) {
                await fetchAsset(asset.url, join(paths.cache, asset.file), asset.label);
                extract(join(paths.cache, asset.file), dir);
                ok(`${asset.label} installed`);
            }
        }
        else if (hasNvidia()) {
            warn("WELD_SKIP_CUDA=1 — cpu only for now, rerun without it to add gpu support");
        }
        else {
            warn("no nvidia gpu found — running cpu-only (vulkan support lands in v1.5)");
        }
    }
    writeManifest({ cuda: process.platform === "win32" ? hasNvidia() && !skipCuda : false });
    line();
    rule("devices");
    const devices = listDevices();
    if (devices.length === 0)
        bullet("none reported (cpu only)");
    for (const d of devices)
        bullet(d);
    line();
    rule("summary");
    kv("build", PINNED_BUILD);
    kv("version", llamaVersion() ?? "unknown");
    kv("binaries", binariesReady() ? "ready" : "MISSING");
    kv("location", dir);
    if (!binariesReady())
        fail("llama-server or rpc-server missing — rerun weld setup");
    if (process.platform === "win32") {
        line();
        info("if peers cannot reach you, allow weld through the firewall (admin shell):");
        bullet(`netsh advfirewall firewall add rule name="weld" dir=in action=allow protocol=TCP localport=7100,7101`);
    }
    line();
    step("next: weld pair");
    line();
}
function sym() {
    return "\u2022";
}
async function fetchAsset(url, dest, label) {
    const p = new Progress(label);
    await downloadFile(url, dest, (got, total) => p.update(got, total));
    p.done(`${label} downloaded`);
}
