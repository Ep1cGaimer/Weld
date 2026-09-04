import { spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { getIdentity, machineName } from "./identity.js";
import { installedBuild } from "./binaries.js";
import { GpuInfo, Telemetry } from "./proto.js";

export function localGpus(): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  if (process.platform === "win32" || process.platform === "linux") {
    const r = spawnSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf8" }
    );
    if (!r.error && r.stdout && r.stdout.trim()) {
      for (const line of r.stdout.trim().split("\n")) {
        const [name, total, free] = line.split(",").map((s) => s.trim());
        if (!name) continue;
        gpus.push({ name, vramTotalMB: Number(total), vramFreeMB: Number(free) });
      }
    }
  } else if (process.platform === "darwin" && process.arch === "arm64") {
    const r = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" });
    const chip = (r.stdout || "").trim() || "Apple Silicon";
    gpus.push({
      name: `${chip} (unified)`,
      vramTotalMB: Math.round(totalmem() / 1e6),
      vramFreeMB: Math.round((freemem() / 1e6) * 0.8),
    });
  }
  return gpus;
}

export function collectLocal(rpcUp = false): Telemetry {
  const id = getIdentity();
  return {
    nodeId: id.nodeId,
    name: machineName(),
    gpus: localGpus(),
    ramFreeMB: Math.round(freemem() / 1e6),
    ramTotalMB: Math.round(totalmem() / 1e6),
    build: installedBuild() ?? "none",
    rpcUp,
    platform: `${process.platform}-${process.arch}`,
  };
}
