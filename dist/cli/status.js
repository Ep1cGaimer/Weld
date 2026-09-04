import { ensureWeldHome } from "../util/paths.js";
import { closeCluster, gatherCluster } from "../core/cluster.js";
import { poolOf } from "../core/plan.js";
import { PINNED_BUILD } from "../core/binaries.js";
import { loadCatalog } from "../core/catalog.js";
import { banner, bullet, c, fmtBytes, fmtMB, info, line, rule, Spinner, step, sym, table, } from "../ui.js";
function deviceLabel(t) {
    if (t.gpus.length === 0)
        return c.gray("cpu only");
    return t.gpus.map((g) => `${g.name} ${c.cyan(fmtMB(g.vramFreeMB))}`).join(", ");
}
export async function cmdStatus() {
    ensureWeldHome();
    banner("0.1.0", "cluster status");
    const s = new Spinner("probing paired peers");
    const cluster = await gatherCluster();
    s.stop();
    const rows = [];
    rows.push([
        c.green(sym.node),
        c.bold(cluster.head.name) + c.gray(" (head)"),
        "this machine",
        deviceLabel(cluster.head),
        fmtMB(cluster.head.ramFreeMB),
        cluster.head.build === PINNED_BUILD ? c.green(cluster.head.build) : c.red(cluster.head.build),
        "",
    ]);
    for (const l of cluster.live) {
        rows.push([
            c.green(sym.node),
            c.bold(l.telemetry.name),
            c.gray(l.peer.host),
            deviceLabel(l.telemetry),
            fmtMB(l.telemetry.ramFreeMB),
            l.telemetry.build === PINNED_BUILD ? c.green(l.telemetry.build) : c.red(l.telemetry.build),
            c.gray(`${l.rttMs}ms`),
        ]);
    }
    for (const d of cluster.dead) {
        rows.push([
            c.red(sym.fail),
            c.gray(d.peer.name),
            c.gray(d.peer.host),
            c.gray("offline"),
            "",
            "",
            c.gray(d.reason.slice(0, 28)),
        ]);
    }
    rule("nodes");
    table(rows, ["", "NAME", "ADDRESS", "DEVICES (free)", "RAM", "BUILD", "RTT"]);
    line();
    const pool = poolOf(cluster.head) + cluster.live.reduce((acc, l) => acc + poolOf(l.telemetry), 0);
    rule("capacity");
    bullet(`${c.bold(c.cyan(fmtMB(pool)))} pooled across ${c.bold(String(1 + cluster.live.length))} node(s)`);
    const fits = loadCatalog()
        .filter((m) => m.bytes / 1e6 < pool * 0.9)
        .sort((a, b) => b.bytes - a.bytes);
    if (fits.length) {
        bullet(`largest local model that fits: ${c.bold(fits[0].id)} ${c.gray(fmtBytes(fits[0].bytes))}`);
    }
    const mismatch = [cluster.head, ...cluster.live.map((l) => l.telemetry)].filter((t) => t.build !== PINNED_BUILD);
    if (mismatch.length) {
        line();
        info(`build mismatch on: ${mismatch.map((m) => m.name).join(", ")} — everyone run weld setup`);
    }
    line();
    if (cluster.live.length === 0) {
        step("no donors online — ask them to run: weld node");
    }
    else {
        step(`ready — weld run <model>`);
    }
    line();
    closeCluster(cluster);
}
