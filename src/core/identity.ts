import forge from "node-forge";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths, ensureWeldHome } from "../util/paths.js";
import { readJson, writeJson } from "../util/store.js";

export interface Identity {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  nodeId: string;
}

const ADJ = ["iron", "copper", "cobalt", "titan", "neon", "onyx", "quartz", "zinc"];
const NOUN = ["falcon", "otter", "lynx", "heron", "ibex", "viper", "wolf", "crow"];

let cached: Identity | null = null;

export function fpOfCert(certPem: string): { fingerprint: string; nodeId: string } {
  const der = forge.pki.pemToDer(certPem);
  const hex = forge.md.sha256.create().update(der.bytes()).digest().toHex().toUpperCase();
  return {
    fingerprint: hex.match(/.{2}/g)!.join(":"),
    nodeId: hex.slice(0, 16),
  };
}

export function shortFp(fingerprint: string): string {
  const parts = fingerprint.split(":");
  return parts.slice(0, 4).join(":") + "…" + parts.slice(-4).join(":");
}

export function machineName(): string {
  const cfg = readJson<{ name?: string }>(paths.config, {});
  if (cfg.name) return cfg.name;
  const name = `${ADJ[randomBytes(1)[0] % ADJ.length]}-${NOUN[randomBytes(1)[0] % NOUN.length]}`;
  writeJson(paths.config, { ...cfg, name });
  return name;
}

export function getIdentity(): Identity {
  if (cached) return cached;
  ensureWeldHome();
  const certFile = join(paths.keys, "cert.pem");
  const keyFile = join(paths.keys, "key.pem");
  if (existsSync(certFile) && existsSync(keyFile)) {
    const certPem = readFileSync(certFile, "utf8");
    const keyPem = readFileSync(keyFile, "utf8");
    cached = { certPem, keyPem, ...fpOfCert(certPem) };
    return cached;
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(8).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  const attrs = [{ name: "commonName", value: "weld-node" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  writeFileSync(certFile, certPem);
  writeFileSync(keyFile, keyPem);
  cached = { certPem, keyPem, ...fpOfCert(certPem) };
  return cached;
}
