import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensureWeldHome, paths } from "../util/paths.js";
import { downloadFile } from "../core/binaries.js";
import { hfFiles, hfSearch, hfUrl } from "../core/models.js";
import { describe, loadCatalog, upsert } from "../core/catalog.js";
import { parseGgufHeader } from "../core/gguf.js";
import {
  banner,
  bullet,
  c,
  fmtBytes,
  fmtMB,
  info,
  kv,
  line,
  ok,
  Progress,
  rule,
  Spinner,
  step,
  table,
} from "../ui.js";

export async function cmdModels(cmd: string, a?: string, b?: string): Promise<void> {
  ensureWeldHome();
  if (cmd === "list") return list();
  if (cmd === "search" && a) return search(a);
  if (cmd === "files" && a) return files(a);
  if (cmd === "download" && a && b) return download(a, b);
  if (cmd === "import" && a) return importLocal(a);
  banner("0.1.0", "models");
  bullet("weld models list");
  bullet("weld models search <query>");
  bullet("weld models files <repo>");
  bullet("weld models download <repo> <file>");
  bullet("weld models import <path-to.gguf>");
  line();
}

function list(): void {
  banner("0.1.0", "local models");
  const cat = loadCatalog();
  if (cat.length === 0) {
    info("no models yet — try: weld models search qwen3");
    line();
    return;
  }
  table(
    cat.map((e) => [
      c.bold(e.id),
      c.cyan(fmtBytes(e.bytes)),
      c.gray(e.arch + (e.params ? ` ${e.params}` : "")),
    ]),
    ["MODEL", "SIZE", "ARCH"]
  );
  line();
}

async function search(q: string): Promise<void> {
  banner("0.1.0", `searching huggingface for "${q}"`);
  const s = new Spinner("querying huggingface");
  try {
    const models = await hfSearch(q);
    s.stop();
    if (models.length === 0) {
      info("no gguf repos matched");
      line();
      return;
    }
    table(
      models.slice(0, 15).map((m) => [c.bold(m.id), c.gray(m.downloads.toLocaleString() + " dl")]),
      ["REPO", "DOWNLOADS"]
    );
    line();
    step(`next: weld models files ${models[0].id}`);
    line();
  } catch (e) {
    s.failed(e instanceof Error ? e.message : String(e));
  }
}

async function files(repo: string): Promise<void> {
  banner("0.1.0", repo);
  const s = new Spinner("listing gguf files");
  try {
    const list = await hfFiles(repo);
    s.stop();
    if (list.length === 0) {
      info("no .gguf files in that repo");
      line();
      return;
    }
    table(
      list.map((f) => [c.bold(f.name), c.cyan(f.size ? fmtBytes(f.size) : "?")]),
      ["FILE", "SIZE"]
    );
    line();
    step(`next: weld models download ${repo} ${list[0].name}`);
    line();
  } catch (e) {
    s.failed(e instanceof Error ? e.message : String(e));
  }
}

async function download(repo: string, file: string): Promise<void> {
  banner("0.1.0", `downloading ${file}`);
  const dest = join(paths.models, file.split("/").pop()!);
  const p = new Progress(file.split("/").pop()!);
  await downloadFile(hfUrl(repo, file), dest, (got, total) => p.update(got, total));
  p.done("download complete");
  if (!existsSync(dest)) throw new Error("download produced no file");
  const entry = describe(dest);
  upsert(entry);
  rule("added");
  kv("model", entry.id);
  kv("size", fmtBytes(entry.bytes));
  kv("arch", entry.arch + (entry.params ? ` ${entry.params}` : ""));
  const info2 = parseGgufHeader(dest);
  kv("tensors", String(info2.tensorCount));
  kv("weights", fmtMB(info2.weightsBytes / 1e6));
  line();
  step(`next: weld run ${entry.id}`);
  line();
}

function importLocal(path: string): void {
  banner("0.1.0", "import model");
  const entry = describe(path);
  upsert(entry);
  const info2 = parseGgufHeader(entry.path);
  ok(`imported ${c.bold(entry.id)}`);
  kv("size", fmtBytes(entry.bytes));
  kv("arch", entry.arch + (entry.params ? ` ${entry.params}` : ""));
  kv("tensors", String(info2.tensorCount));
  kv("weights", fmtMB(info2.weightsBytes / 1e6));
  line();
  step(`next: weld run ${entry.id}`);
  line();
}
