import { ensureWeldHome } from "../util/paths.js";
import { loadConfig } from "../util/config.js";
import { findModel } from "../core/catalog.js";
import { parseGgufHeader } from "../core/gguf.js";
import { closeCluster, gatherCluster, LivePeer } from "../core/cluster.js";
import { fit, poolOf } from "../core/plan.js";
import { openRelay, RelayMap } from "../core/tunnel/client.js";
import { binariesReady, llamaServerPath, PINNED_BUILD } from "../core/binaries.js";
import { portFree, Proc, spawnProc } from "../proc/supervisor.js";
import { Telemetry } from "../core/proto.js";
import {
  banner,
  bar,
  box,
  bullet,
  c,
  confirm,
  fail,
  fmtBytes,
  fmtMB,
  info,
  kv,
  line,
  ok,
  rule,
  sleep,
  Spinner,
  sym,
  table,
  warn,
} from "../ui.js";

function classify(code: number | null, stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("rpc") && (s.includes("connect") || s.includes("closed") || s.includes("failed")))
    return "a donor's rpc-server dropped (network cut or process died)";
  if (s.includes("out of memory") || s.includes("cudamalloc") || s.includes("insufficient"))
    return "out of memory — lower --ctx or use a smaller quant";
  if (s.includes("failed to load model") || s.includes("invalid magic"))
    return "model failed to load — re-download the gguf";
  if (s.includes("error while handling argument") || s.includes("unknown argument"))
    return "llama-server rejected an argument (pinned build changed flags)";
  return `llama-server exited with code ${code}`;
}

export async function cmdRun(
  model: string,
  opts: { ctx: string; exclude: string[] }
): Promise<void> {
  ensureWeldHome();
  const cfg = loadConfig();
  const ctx = parseInt(opts.ctx, 10) || 8192;
  const exclude = opts.exclude ?? [];
  banner("0.1.0", "run");

  if (!binariesReady()) {
    fail("llama.cpp binaries missing — run: weld setup");
    line();
    process.exitCode = 1;
    return;
  }

  const entry = findModel(model);
  if (!entry) {
    fail(`model not found: ${model}`);
    bullet("weld models list");
    bullet("weld models search <query>");
    line();
    process.exitCode = 1;
    return;
  }
  const info0 = parseGgufHeader(entry.path);

  const probing = new Spinner("probing cluster");
  const cluster = await gatherCluster(exclude);
  probing.stop();

  const nodes: Telemetry[] = [cluster.head, ...cluster.live.map((l) => l.telemetry)];

  rule("cluster");
  table(
    [
      [
        c.green(sym.node),
        c.bold(cluster.head.name) + c.gray(" (head)"),
        cluster.head.gpus.length
          ? cluster.head.gpus.map((g) => `${g.name} ${fmtMB(g.vramFreeMB)}`).join(", ")
          : c.gray("cpu only"),
        c.cyan(fmtMB(poolOf(cluster.head))),
      ],
      ...cluster.live.map((l) => [
        c.green(sym.node),
        c.bold(l.telemetry.name),
        l.telemetry.gpus.length
          ? l.telemetry.gpus.map((g) => `${g.name} ${fmtMB(g.vramFreeMB)}`).join(", ")
          : c.gray("cpu only"),
        c.cyan(fmtMB(poolOf(l.telemetry))),
      ]),
    ],
    ["", "NODE", "DEVICES (free)", "CONTRIBUTES"]
  );
  for (const d of cluster.dead) warn(`${d.peer.name} offline — skipping ${c.gray(`(${d.reason})`)}`);

  const mismatch = nodes.filter((n) => n.build !== PINNED_BUILD);
  if (mismatch.length) {
    line();
    fail(`build mismatch: ${mismatch.map((m) => `${m.name}=${m.build}`).join(", ")}`);
    bullet(`every machine must be on ${PINNED_BUILD} — run weld setup there`);
    line();
    closeCluster(cluster);
    process.exitCode = 1;
    return;
  }

  line();
  rule("fit");
  const f = fit(info0, ctx, nodes);
  kv("model", c.bold(entry.id));
  kv("weights", fmtBytes(info0.weightsBytes));
  kv("kv cache", `${fmtMB(f.kvMB)} ${c.gray(`@ ctx ${ctx}`)}`);
  kv("required", c.bold(fmtMB(f.needMB)));
  kv("pooled", c.bold(c.cyan(fmtMB(f.poolMB))));
  line();
  console.log("  " + bar(Math.min(1, f.needMB / Math.max(f.poolMB, 1))) + c.gray("  of pool used"));
  line();
  if (!f.fits) {
    fail(f.advice);
    line();
    closeCluster(cluster);
    process.exitCode = 1;
    return;
  }
  ok(f.advice);

  if (!(await portFree(cfg.apiPort))) {
    line();
    fail(`api port ${cfg.apiPort} is in use — stop the other server or set WELD_API_PORT`);
    line();
    closeCluster(cluster);
    process.exitCode = 1;
    return;
  }

  const sessionId = `s-${Date.now().toString(36)}`;
  const joined: LivePeer[] = [];
  const maps: RelayMap[] = [];
  line();
  rule("session");
  for (const l of cluster.live) {
    const s = new Spinner(`${l.telemetry.name}: starting rpc-server`);
    try {
      const resp = await l.conn.request(
        { t: "join", sessionId, build: PINNED_BUILD },
        (m) => m.t === "joined",
        30000
      );
      if (resp.t !== "joined" || !resp.ok) {
        s.failed(
          `${l.telemetry.name}: refused — ${resp.t === "joined" && !resp.ok ? resp.error : "unknown"}`
        );
        continue;
      }
      const map = await openRelay(l.peer);
      maps.push(map);
      joined.push(l);
      s.succeed(
        `${c.bold(l.telemetry.name)} joined ${c.gray(`(tunnel 127.0.0.1:${map.port} ${sym.arrow} ${l.peer.host})`)}`
      );
    } catch (e) {
      s.failed(`${l.telemetry.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (joined.length === 0 && cluster.live.length > 0) {
    warn("no donors joined — running on this machine only");
  }

  const args = [
    "-m",
    entry.path,
    "--host",
    "127.0.0.1",
    "--port",
    String(cfg.apiPort),
    "-c",
    String(ctx),
    "-ngl",
    "999",
  ];
  if (maps.length) args.push("--rpc", maps.map((m) => `127.0.0.1:${m.port}`).join(","));

  const verbose = process.env.WELD_VERBOSE === "1";
  const llama: Proc = spawnProc(llamaServerPath(), args, {
    onErr: (s) => {
      if (verbose) process.stderr.write(c.gray(s));
    },
  });

  const loading = new Spinner(
    maps.length
      ? `loading model — streaming weights to ${maps.length} donor(s), first run is slow`
      : "loading model"
  );
  const deadline = Date.now() + 15 * 60 * 1000;
  let ready = false;
  let died = false;
  void llama.exited.then(() => {
    died = true;
  });
  while (Date.now() < deadline && !died) {
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.apiPort}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  if (!ready) {
    loading.failed("model did not load");
    const code = await llama.exited;
    fail(classify(code, llama.stderr));
    const tail = llama.stderr.trim().split("\n").slice(-6);
    if (tail.length) {
      line();
      rule("llama-server output");
      for (const t of tail) bullet(c.gray(t.slice(0, 120)));
      if (!verbose) info("rerun with WELD_VERBOSE=1 for full logs");
    }
    line();
    await teardown(llama, maps, joined, sessionId);
    closeCluster(cluster);
    process.exitCode = 1;
    return;
  }
  loading.succeed("model loaded");

  line();
  box(
    [
      `${c.gray("endpoint")}  ${c.bold(c.cyan(`http://127.0.0.1:${cfg.apiPort}/v1`))}`,
      `${c.gray("model")}     ${entry.id}`,
      `${c.gray("nodes")}     ${1 + joined.length} ${c.gray(
        `(head + ${joined.length} donor${joined.length === 1 ? "" : "s"})`
      )}`,
      `${c.gray("chat ui")}   ${c.gray(`http://127.0.0.1:${cfg.apiPort}`)}`,
    ],
    "cluster online"
  );
  line();
  info("ctrl+c to stop the cluster");
  line();

  const failure = Promise.race<{ kind: "llama"; code: number | null } | { kind: "peer"; name: string }>([
    llama.exited.then((code) => ({ kind: "llama" as const, code })),
    ...joined.map((l) => l.conn.closed.then(() => ({ kind: "peer" as const, name: l.telemetry.name }))),
  ]);
  const interrupt = new Promise<"stop">((res) => {
    process.once("SIGINT", () => res("stop"));
    process.once("SIGTERM", () => res("stop"));
  });

  const outcome = await Promise.race([failure, interrupt]);

  if (outcome === "stop") {
    line();
    const s = new Spinner("stopping cluster");
    await teardown(llama, maps, joined, sessionId);
    closeCluster(cluster);
    s.succeed("cluster stopped");
    line();
    process.exit(0);
  }

  line();
  if (outcome.kind === "peer") {
    fail(`donor ${c.bold(outcome.name)} dropped mid-session`);
    await teardown(llama, maps, joined, sessionId);
    closeCluster(cluster);
    line();
    const again = await confirm(`restart without ${outcome.name}?`);
    if (again) {
      line();
      return cmdRun(model, { ctx: opts.ctx, exclude: [...exclude, outcome.name] });
    }
    process.exitCode = 1;
    return;
  }

  fail(classify(outcome.code, llama.stderr));
  const tail = llama.stderr.trim().split("\n").slice(-4);
  for (const t of tail) bullet(c.gray(t.slice(0, 120)));
  await teardown(llama, maps, joined, sessionId);
  closeCluster(cluster);
  line();
  process.exitCode = 1;
}

async function teardown(
  llama: Proc,
  maps: RelayMap[],
  joined: LivePeer[],
  sessionId: string
): Promise<void> {
  for (const l of joined) {
    try {
      l.conn.send({ t: "leave", sessionId });
    } catch {
      /* peer already gone */
    }
  }
  await llama.stop();
  for (const m of maps) m.close();
  await sleep(150);
}
