import { Command } from "commander";
import { cmdSetup } from "./cli/setup.js";
import { cmdPair } from "./cli/pair.js";
import { cmdNode } from "./cli/node.js";
import { cmdModels } from "./cli/modelscli.js";
import { cmdStatus } from "./cli/status.js";
import { cmdDoctor } from "./cli/doctor.js";
import { cmdRun } from "./cli/run.js";

const program = new Command();
program.name("weld").description("pool GPUs with friends over llama.cpp rpc").version("0.1.0");

program.command("setup").description("install pinned llama.cpp binaries").action(cmdSetup);

program
  .command("pair")
  .description("pair with another machine")
  .argument("[code]", "pairing code shown by the other machine")
  .option("--host <host>", "ip of the machine showing the code")
  .option("--port <port>", "control port of that machine", "7100")
  .action(cmdPair);

program.command("node").description("run as gpu donor").action(cmdNode);

const models = program.command("models").description("model management");
models.command("list").action(() => cmdModels("list"));
models.command("search <q>").action((q: string) => cmdModels("search", q));
models.command("files <repo>").action((repo: string) => cmdModels("files", repo));
models
  .command("download <repo> <file>")
  .action((repo: string, file: string) => cmdModels("download", repo, file));
models.command("import <path>").action((path: string) => cmdModels("import", path));

program.command("status").description("cluster overview").action(cmdStatus);
program.command("doctor").description("diagnostics").action(cmdDoctor);

program
  .command("run")
  .description("run a model across the cluster")
  .argument("<model>", "model id or gguf path")
  .option("--ctx <n>", "context size", "8192")
  .option("--exclude <name>", "exclude peer by name/id", (v: string, a: string[]) => [...a, v], [] as string[])
  .action(cmdRun);

program.parse();
