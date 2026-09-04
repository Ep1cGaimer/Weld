import { readJson, writeJson } from "../util/store.js";
import { paths } from "../util/paths.js";
import { fpOfCert } from "./identity.js";

export interface PeerEntry {
  id: string;
  name: string;
  fingerprint: string;
  certPem: string;
  host: string;
  controlPort: number;
  relayPort: number;
  addedAt: string;
}

export function loadPeers(): PeerEntry[] {
  return readJson<PeerEntry[]>(paths.peers, []);
}

export function savePeers(peers: PeerEntry[]): void {
  writeJson(paths.peers, peers);
}

export function addPeer(peer: PeerEntry): PeerEntry[] {
  const peers = loadPeers().filter((p) => p.id !== peer.id);
  peers.push(peer);
  savePeers(peers);
  return peers;
}

export function removePeer(nameOrId: string): boolean {
  const peers = loadPeers();
  const next = peers.filter((p) => p.id !== nameOrId && p.name !== nameOrId);
  if (next.length === peers.length) return false;
  savePeers(next);
  return true;
}

export function peerFingerprints(): Set<string> {
  return new Set(loadPeers().map((p) => p.fingerprint));
}

export function peerFromCert(
  certPem: string,
  name: string,
  host: string,
  controlPort: number,
  relayPort: number
): PeerEntry {
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
