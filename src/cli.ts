#!/usr/bin/env node
import { Command } from "commander";
import { cmdSetup } from "./cli/setup.js";
import { cmdPair } from "./cli/pair.js";
import { cmdNode } from "./cli/node.js";
import { cmdModels } from "./cli/modelscli.js";
import { cmdStatus } from "./cli/status.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdRun } from "./cli/run.js";
import { cmdPeers } from "./cli/peers.js";
import { c, fail, line, sym } from "./ui.js";

const VERSION = "0.1.0";

const program = new Command();
program
  .name("weld")
  .description("pool GPUs with friends — run models bigger than any single machine")
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: false })
  .addHelpText(
    "before",
    `
  ${c.bold(c.cyan("weld"))} ${c.gray("v" + VERSION)}  ${c.gray(sym.dot)} ${c.gray(
      "pool GPUs over llama.cpp rpc"
    )}
`
  )
  .addHelpText(
    "after",
    `
${c.gray("  quick start")}
    ${c.bold("weld setup")}                      ${c.gray("install pinned llama.cpp binaries")}
    ${c.bold("weld pair")}                       ${c.gray("show a code for your friend")}
    ${c.bold("weld pair <code> --host <ip>")}    ${c.gray("join their machine")}
    ${c.bold("weld node")}                       ${c.gray("donate this machine's gpu")}
    ${c.bold("weld models search qwen3")}        ${c.gray("find a gguf")}
    ${c.bold("weld run <model>")}                ${c.gray("serve it across the cluster")}
    ${c.bold("weld status")} ${c.gray(sym.dot)} ${c.bold("weld doctor")}      ${c.gray(
      "see the cluster / diagnose"
    )}
    ${c.bold("weld peers")}                      ${c.gray("who you are paired with")}

${c.gray("  env")}
    WELD_HOME        ${c.gray("state dir (default ~/.weld) — lets you run two nodes on one box")}
    WELD_API_PORT    ${c.gray("openai api port (default 8080)")}
    WELD_CONTROL_PORT / WELD_RELAY_PORT / WELD_RPC_PORT
    WELD_VERBOSE=1   ${c.gray("stream llama-server logs")}
`
  );

program.command("setup").description("install pinned llama.cpp binaries").action(run(cmdSetup));

program
  .command("pair")
  .description("pair with another machine")
  .argument("[code]", "pairing code shown by the other machine")
  .option("--host <host>", "ip of the machine showing the code")
  .option("--port <port>", "control port of that machine", "7100")
  .action(run(cmdPair));

program.command("node").description("donate this machine's gpu to paired heads").action(run(cmdNode));

const models = program.command("models").description("find, download and inspect models");
models.command("list").description("models on this machine").action(run(() => cmdModels("list")));
models
  .command("search <query>")
  .description("search huggingface for gguf repos")
  .action(run((q: string) => cmdModels("search", q)));
models
  .command("files <repo>")
  .description("list gguf files in a repo")
  .action(run((repo: string) => cmdModels("files", repo)));
models
  .command("download <repo> <file>")
  .description("download a gguf (resumable)")
  .action(run((repo: string, file: string) => cmdModels("download", repo, file)));
models
  .command("import <path>")
  .description("register a gguf you already have")
  .action(run((path: string) => cmdModels("import", path)));

program.command("status").description("cluster overview and pooled capacity").action(run(cmdStatus));
program.command("doctor").description("diagnose binaries, ports, peers").action(run(cmdDoctor));

const peers = program.command("peers").description("list or remove paired machines");
peers.command("list", { isDefault: true }).description("show paired machines").action(run(() => cmdPeers()));
peers
  .command("forget <name>")
  .description("remove a paired machine")
  .action(run((name: string) => cmdPeers("forget", name)));

program
  .command("run")
  .description("serve a model across the cluster")
  .argument("<model>", "model id (weld models list) or path to .gguf")
  .option("--ctx <n>", "context size", "8192")
  .option("--exclude <name>", "skip a peer (repeatable)", (v: string, a: string[]) => [...a, v], [] as string[])
  .action(run(cmdRun));

function run<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      line();
      fail(e instanceof Error ? e.message : String(e));
      if (process.env.WELD_VERBOSE === "1" && e instanceof Error && e.stack) {
        console.error(c.gray(e.stack));
      }
      line();
      process.exit(1);
    }
  };
}

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse();
}
