import { ensureWeldHome } from "../util/paths.js";
import { loadPeers, removePeer } from "../core/peers.js";
import { getIdentity, machineName, shortFp } from "../core/identity.js";
import { banner, bullet, c, fail, info, kv, line, ok, rule, table } from "../ui.js";
export async function cmdPeers(cmd, who) {
    ensureWeldHome();
    if (cmd === "forget" && who)
        return forget(who);
    if (cmd === "forget") {
        banner("0.1.0", "peers");
        fail("usage: weld peers forget <name-or-id>");
        line();
        process.exitCode = 1;
        return;
    }
    list();
}
function list() {
    const id = getIdentity();
    banner("0.1.0", "paired machines");
    rule("this machine");
    kv("name", c.bold(machineName()));
    kv("node id", id.nodeId);
    kv("fingerprint", c.yellow(shortFp(id.fingerprint)));
    line();
    const peers = loadPeers();
    rule(`peers (${peers.length})`);
    if (peers.length === 0) {
        info("none yet — run: weld pair");
        line();
        return;
    }
    table(peers.map((p) => [
        c.bold(p.name),
        c.gray(`${p.host}:${p.controlPort}`),
        c.yellow(shortFp(p.fingerprint)),
        c.gray(p.addedAt.slice(0, 10)),
    ]), ["NAME", "ADDRESS", "FINGERPRINT", "PAIRED"]);
    line();
    bullet(c.gray("remove one with: weld peers forget <name>"));
    line();
}
function forget(who) {
    banner("0.1.0", "peers");
    if (removePeer(who)) {
        ok(`forgot ${c.bold(who)} — they can no longer connect to this machine`);
        bullet(c.gray("re-pair with: weld pair"));
    }
    else {
        fail(`no peer named "${who}"`);
        bullet("weld peers");
    }
    line();
}
