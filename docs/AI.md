# Local AI: runtime and model selection

## Runtime

**llama.cpp via node-llama-cpp 3.22** (bundled llama.cpp release v0.9.0 builds), chosen because it:
ships prebuilt Windows x64 CPU and Vulkan backends (no compiler, no separate install); supports
JSON-schema → GBNF grammar-constrained decoding (the model *cannot* emit malformed JSON);
reuses the KV cache of the constant system prompt; and loads every GGUF architecture we tested.
Rejected: Ollama (separate service and network port), Python llama-cpp server (extra runtime),
ONNX/DirectML (no grammar decoding, narrower model coverage). Inference runs in the game-server
process on a bundled standalone Node runtime (see `docs/PACKAGING.md` for why not in Electron).

## Candidates (all Apache-2.0, Q4_K_M GGUF)

Benchmark: `scripts/benchmark-models.js` — 12 real SATURN interpretation cases (asking around,
persuading a financier, three months of study, travel, a borrowed-money company, alloy research,
a nonexistent king, an investigation, a two-step purchase, flight, a prompt-injection attempt,
pickpocketing) plus one narration, run through the real Game Master against a real world state.
A case passes only if the model's validated output (not the fallback) has the right shape.
Hardware: 4 vCPU Xeon 2.1 GHz, no GPU. Raw results: `docs/benchmarks/*.json`.

| Model | Size | Score (original prompt) | Median latency | Notes |
|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507** | 2.5 GB | 9/12 → **11/12 after prompt revision** | 25.6 s → 30.0 s | Best instruction following; failures were over-caution ("impossible") fixed by prompt |
| granite-4.2-3b | 2.2 GB | 9/12 | 58.0 s | Accurate but slow and verbose plans; two cases took 4 min |
| Qwen3.5-2B | 1.3 GB | 8/12 | 40.5 s | Fastest to load (3.6 s); followed the prompt-injection into a `give` action (blocked by the engine, but a worse sign) |
| Ministral-3-3B-Instruct-2512 | 2.1 GB | 8/12 | 18.4 s | Fast because it often asks for clarification instead of acting; invented facts in narration |
| Qwen3.5-4B | 2.7 GB | 7/12 | 71.3 s | Slowest; hybrid architecture slower on CPU here |

Larger models (Qwen3.5-9B, Gemma 4 12B) were not benchmarked: on this 4-core CPU they would be
2–4× slower than an already-slow 4B, and they exceed the "8 GB RAM" target. They remain a
sensible "high" profile for GPU machines (selectable in Settings if a model file is installed;
**untested**).

## Decision

- **Standard (bundled default): Qwen3-4B-Instruct-2507 Q4_K_M** — highest accuracy, robust to the
  injection test, acceptable size (2.5 GB), non-thinking instruct model (no hidden reasoning
  tokens to wait for).
- **Light profile: Qwen3.5-2B Q4_K_M** — for 8 GB machines; weaker on complex plans.
- Thinking is disabled through the Qwen chat wrapper (`thoughts: 'discourage'`) because a
  zero thought budget swallowed the first JSON token (found and fixed during benchmarking).

## Reliability design

1. **Fast path** — short commands that the deterministic parser maps confidently never touch
   the model.
2. **Constrained decoding** — compact 12-field action schema (fewer tokens = faster) enforced by
   grammar; validated again by Ajv; unknown fields dropped, bad enums nulled.
3. **Repair** — one retry with the validation errors; then the deterministic parser; the UI
   labels which path produced the turn.
4. **Timeouts and cancellation** — every generation has a deadline and an abort signal (Esc).
5. **Untrusted input** — player text is sanitised (chat-template control tokens and role tags
   stripped) and wrapped as data; the model can only propose vocabulary actions, and the engine
   resolves names only against what the player can perceive.
6. **Grounded narration** — narration is generated after commit from an explicit outcome
   description (with authoritative WORKS/FAILS verdicts and only the facts an NPC disclosed),
   then checked: numbers must appear in the outcome; uninvolved NPCs may not appear; no game
   mechanics; no naming the player in the third person; no depicting failure for a success or
   vice versa. Violations trigger a retry and then the template narrator.

## Measured performance (CPU only)

| | Qwen3-4B (standard) |
|---|---|
| Interpretation, complex sentence | median 30.0 s (11–67 s) |
| Narration | ~20–24 s |
| Generation speed | ~4.9 tokens/s |
| Model load | 4–16 s warm, ~200 s from a cold disk |
| Process RSS with model loaded | ~3.5–5 GB |

## Known weaknesses

The 4B model still embellishes narration with small invented details or attitudes that do not
change state and are not mechanically detectable (e.g. an NPC claiming not to know the Great
Ring). It occasionally under-decomposes ambitious goals (alloy research became "study + ask
around" instead of a `research` project). The benchmark set should grow to ~100 cases before
further prompt tuning.
