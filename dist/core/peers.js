import { readJson, writeJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { fpOfCert } from "./identity.js";
export function loadPeers() {
    return readJson(paths.peers, []);
}
export function savePeers(peers) {
    writeJson(paths.peers, peers);
}
export function addPeer(peer) {
    const peers = loadPeers().filter((p) => p.id !== peer.id);
    peers.push(peer);
    savePeers(peers);
    return peers;
}
export function removePeer(nameOrId) {
    const peers = loadPeers();
    const next = peers.filter((p) => p.id !== nameOrId && p.name !== nameOrId);
    if (next.length === peers.length)
        return false;
    savePeers(next);
    return true;
}
export function peerFingerprints() {
    return new Set(loadPeers().map((p) => p.fingerprint));
}
export function peerFromCert(certPem, name, host, controlPort, relayPort) {
    const { fingerprint, nodeId } = fpOfCert(certPem);
    return {
        id: nodeId,
        name,
        fingerprint,
        certPem,
        host: host.replace("::ffff:", ""),
        controlPort,
        relayPort,
        addedAt: new Date().toISOString(),
    };
}
