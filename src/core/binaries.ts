import { existsSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { paths, ensureWeldHome } from "../util/paths.js";
import { readJson, writeJson } from "../util/store.js";

export const PINNED_BUILD = process.env.WELD_BUILD || "b10621";

const EXE = process.platform === "win32" ? ".exe" : "";

function releaseBase(): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${PINNED_BUILD}`;
}

export function binDir(): string {
  return join(paths.bin, PINNED_BUILD);
}

export function llamaServerPath(): string {
  return join(binDir(), "llama-server" + EXE);
}

export function rpcServerPath(): string {
  for (const n of ["rpc-server", "ggml-rpc-server"]) {
    const p = join(binDir(), n + EXE);
    if (existsSync(p)) return p;
  }
  return join(binDir(), "rpc-server" + EXE);
}

export function installedBuild(): string | null {
  const m = readJson<{ build?: string }>(join(binDir(), "manifest.json"), {});
  return m.build ?? null;
}

export function binariesReady(): boolean {
  return existsSync(llamaServerPath()) && existsSync(rpcServerPath());
}

export interface Asset {
  url: string;
  file: string;
  label: string;
}

export function baseAsset(): Asset {
  if (process.platform === "win32") {
    return {
      url: `${releaseBase()}/llama-${PINNED_BUILD}-bin-win-cpu-x64.zip`,
      file: "base.zip",
      label: "cpu runtime",
    };
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return {
      url: `${releaseBase()}/llama-${PINNED_BUILD}-bin-macos-${arch}.tar.gz`,
      file: "base.tar.gz",
      label: arch === "arm64" ? "metal runtime" : "cpu runtime",
    };
  }
  return {
    url: `${releaseBase()}/llama-${PINNED_BUILD}-bin-ubuntu-x64.tar.gz`,
    file: "base.tar.gz",
    label: "cpu runtime",
  };
}

export function cudaAssets(): Asset[] {
  return [
    {
      url: `${releaseBase()}/llama-${PINNED_BUILD}-bin-win-cuda-12.4-x64.zip`,
      file: "cuda.zip",
      label: "cuda backend",
    },
    {
      url: `${releaseBase()}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
      file: "cudart.zip",
      label: "cuda runtime",
    },
  ];
}

export function hasNvidia(): boolean {
  const r = spawnSync("nvidia-smi", ["-L"], { encoding: "utf8" });
  return !r.error && (r.stdout || "").toLowerCase().includes("gpu");
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (got: number, total: number) => void
): Promise<void> {
  const existing = existsSync(dest) ? statSync(dest).size : 0;
  const headers: Record<string, string> = {};
  if (existing > 0) headers.range = `bytes=${existing}-`;
  const res = await fetch(url, { headers });
  if (res.status === 416) {
    onProgress?.(existing, existing);
    return;
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`download failed (${res.status}) ${url}`);
  }
  const append = res.status === 206;
  const total = (append ? existing : 0) + Number(res.headers.get("content-length") || 0);
  if (append && total > 0 && existing >= total) {
    onProgress?.(existing, total);
    return;
  }
  const fd = openSync(dest, append ? "a" : "w");
  let got = append ? existing : 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writeSync(fd, value);
      got += value.length;
      onProgress?.(got, total);
    }
  } finally {
    closeSync(fd);
  }
}

export function extract(file: string, dir: string): void {
  const r = spawnSync("tar", ["-xf", file, "-C", dir], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`extract failed for ${file}: ${(r.stderr || "").trim() || "tar unavailable"}`);
  }
}

export function listDevices(): string[] {
  if (!existsSync(llamaServerPath())) return [];
  const r = spawnSync(llamaServerPath(), ["--list-devices"], { encoding: "utf8", timeout: 20000 });
  const out = (r.stdout || "") + (r.stderr || "");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(CUDA|Metal|Vulkan|CPU|ROCm|SYCL)\d*:/i.test(l));
}

export function llamaVersion(): string | null {
  if (!existsSync(llamaServerPath())) return null;
  const r = spawnSync(llamaServerPath(), ["--version"], { encoding: "utf8", timeout: 20000 });
  const out = ((r.stdout || "") + (r.stderr || "")).split("\n").map((l) => l.trim());
  return out.find((l) => l.length > 0) ?? null;
}

export function writeManifest(extras: Record<string, unknown> = {}): void {
  ensureWeldHome();
  writeJson(join(binDir(), "manifest.json"), {
    build: PINNED_BUILD,
    platform: `${process.platform}-${process.arch}`,
    at: new Date().toISOString(),
    ...extras,
  });
}
