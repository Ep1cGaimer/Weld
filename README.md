# weld

**Pool GPUs with friends. Run models bigger than any single machine.**

Weld turns two or more computers into one inference cluster using llama.cpp's RPC backend, and gives you a single OpenAI-compatible endpoint on `localhost`. Windows + CUDA, macOS + Metal, and CPU nodes can all join the same cluster.

```
npm i -g https://github.com/Ep1cGaimer/Weld/releases/download/v0.1.0/weld-llm-0.1.0.tgz
weld setup
```

That's the whole install — no compilers, no Python, no Docker, no git. Weld downloads pinned llama.cpp binaries for your platform on first setup.

<details>
<summary>Other install options</summary>

```bash
npm i -g github:Ep1cGaimer/Weld       # from source (needs git installed)
git clone https://github.com/Ep1cGaimer/Weld && cd Weld && npm i && npm link
```
</details>

---

## Quick start (you + a friend)

**You (the head — holds the model, serves the API):**

```bash
weld setup                    # one time: downloads llama.cpp + cuda/metal backend
weld pair                     # prints a 6-digit code + your LAN ip
```

**Your friend (the donor — lends their GPU):**

```bash
npm i -g https://github.com/Ep1cGaimer/Weld/releases/download/v0.1.0/weld-llm-0.1.0.tgz
weld setup
weld pair 482913 --host 192.168.1.42    # code + your ip
weld node                                # leave this running
```

Both of you confirm the fingerprint shown on screen matches — that's the trust step.

**Back on your machine:**

```bash
weld status                                                # see the pooled capacity
weld models search qwen3                                   # find a gguf
weld models download ggml-org/Qwen3-0.6B-GGUF Qwen3-0.6B-Q4_0.gguf
weld run Qwen3-0.6B-Q4_0                                   # serve it across the cluster
```

```
  ╭─ cluster online ───────────╮
  │ endpoint  http://127.0.0.1:8080/v1 │
  │ model     Qwen3-0.6B-Q4_0          │
  │ nodes     2 (head + 1 donor)       │
  ╰────────────────────────────╯
```

Point any OpenAI client at `http://127.0.0.1:8080/v1`:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

Only the head needs the model file. Donors receive their slice of the weights over the network and cache it for next time.

---

## How it works

```
YOUR MACHINE (head)                         FRIEND'S MACHINE (donor)
────────────────────                        ────────────────────────
weld run
 ├── llama-server ──► localhost:8080 (OpenAI API)
 │     uses your GPU directly
 │     --rpc 127.0.0.1:53096
 │
 ├── tunnel :53096 ═══ mTLS ═══════════════► relay :7101 ──► rpc-server :50052
 │                                             (spawned on demand, caches its slice)
 └── control ════════ mTLS ═══════════════► control :7100
                                              (telemetry, join/leave)
```

Four things worth knowing:

- **Memory pools, compute pipelines.** llama.cpp splits the model's weights and KV cache across every device — your GPU plus each donor's — proportional to free memory. A model fits when the *sum* of everyone's free VRAM/RAM covers it.
- **The head owns the file.** Weights stream from the head to donors at load time. Donors keep a local tensor cache, so the second run of the same model skips the transfer.
- **Everything binds to localhost.** llama.cpp's RPC protocol has no authentication of its own, so Weld never exposes it. `rpc-server` listens only on `127.0.0.1`; the sole route in is a mutually-authenticated TLS tunnel between machines that have explicitly paired and confirmed each other's certificate fingerprints.
- **The head dials out.** Donors run a small daemon and wait; heads initiate. No port forwarding assumptions beyond the donor's two LAN ports.

---

## Speed — what to actually expect

Every generated token requires a round trip between the head and each donor, so **network latency matters more than bandwidth**. Measured on Qwen3-0.6B-Q4_0, two nodes on one machine (worst case: both nodes share a CPU, so this isolates pure coordination overhead):

| Setup | tok/s |
|---|---|
| Head only (1 node) | 69.8 |
| Head + 1 donor (2 nodes) | 50.6 |

Rules of thumb:

- **Distribution is not a speedup.** Splitting a model that already fits on one machine makes it *slower*. The win is running models that otherwise wouldn't load at all.
- **Wired Ethernet ≫ Wi-Fi.** Sub-millisecond LAN latency is the difference between usable and painful. Check yours with `weld doctor` — it reports per-peer round-trip time.
- **First load is slow, later loads aren't.** Weights cross the network once (≈2.5 min for a 17GB model on 2.5GbE), then donors serve from cache.
- **The slowest node sets the pace.** Drop a weak one with `weld run <model> --exclude <name>`.

---

## Commands

| Command | What it does |
|---|---|
| `weld setup` | Download pinned llama.cpp binaries; detect CUDA/Metal |
| `weld pair` | Show a pairing code and wait |
| `weld pair <code> --host <ip>` | Join the machine showing that code |
| `weld node` | Donate this machine's GPU (leave running) |
| `weld status` | Node table, latency, pooled capacity |
| `weld run <model>` | Fit check, join donors, serve the API |
| `weld models search/files/download/import/list` | Find and manage GGUFs |
| `weld peers` / `weld peers forget <name>` | See or revoke paired machines |
| `weld doctor` | Diagnose binaries, ports, peers, latency |

Useful flags and env vars:

```bash
weld run mymodel --ctx 32768              # bigger context (costs KV cache memory)
weld run mymodel --exclude slow-laptop    # skip a node
WELD_VERBOSE=1 weld run mymodel           # stream llama-server logs
WELD_API_PORT=9000 weld run mymodel       # move the api port
WELD_HOME=~/.weld-b weld node             # run a second node on one machine (testing)
```

---

## Requirements

- Node.js 20+
- Windows x64 (CUDA auto-detected) or macOS arm64 (Metal) — Linux x64 works CPU-only
- All machines on a network they can reach each other on, and on the **same pinned llama.cpp build** (`weld status` enforces this)
- Windows: allow inbound TCP 7100–7101 if peers can't reach you — `weld setup` prints the exact `netsh` command

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Peer shows `offline` in `weld status` | Is `weld node` running there? Then check the firewall on their machine |
| `certificate mismatch` | They re-paired with new keys — `weld peers forget <name>` and pair again |
| `build mismatch` | Someone is on a different llama.cpp build — run `weld setup` on every machine |
| `short by X GB` | Add a node, lower `--ctx`, or use a smaller quant |
| Model won't load | `WELD_VERBOSE=1 weld run <model>` to see llama-server's own logs |

---

## Limitations (v1)

CUDA + Metal + CPU only (Vulkan/ROCm not wired yet) · pairing needs a manual IP, no auto-discovery · one model per session · the model file must exist on the head. Distributed model *storage* — where no single machine holds the whole file — depends on upstream llama.cpp work in progress.

Built on [llama.cpp](https://github.com/ggml-org/llama.cpp). MIT licensed.
