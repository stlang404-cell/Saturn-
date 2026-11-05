# SATURN architecture

## The core contract

```
 player text ──► Game Master (local LLM) ──► typed action proposals ──► Engine ──► committed outcomes ──► Narrator (LLM) ──► prose
                    │  grammar-constrained JSON      │ schema-validated         │ rules, dice,            │ grounding check
                    │  + context from engine         │ (Ajv)                    │ ledger, inventory,      │ (numbers, names,
                    │  + retrieved memories          │                          │ memory, world sim       │  mechanics)
                    └─ fallback: deterministic parser └─ unknown/invalid → refused └─ one SQLite transaction └─ fallback: templates
```

**The model proposes; the engine disposes.** The language model can only emit a JSON object
matching `src/ai/schema.js` (enforced at decode time by a JSON-schema grammar, and again by Ajv).
That object names one of 33 action types with plain parameters. It cannot express "set balance",
"create item" or "edit memory" — those operations do not exist in the vocabulary. The engine
resolves names against what the player can actually perceive, validates feasibility, rolls dice,
and commits changes. Narration happens after commit and cannot change state.

## Components

| Path | Responsibility |
|---|---|
| `src/engine/db.js` | SQLite schema, versioned migrations, constraints, prepared-statement cache, online backup |
| `src/engine/game.js` | `Game`: atomic `transact()`, calendar, checks with explainable modifiers, XP, witnessed events, time advance |
| `src/engine/dice.js`, `rng.js`, `rules.js` | Resolution system, exact probability distributions, counter-based auditable RNG, progression math |
| `src/engine/ledger.js` | Double-entry currency ledger; explicit mint/sink; idempotency keys; reconciliation |
| `src/engine/inventory.js` | Items with legal owner vs. physical holder; create/destroy only for legitimate reasons; conservation check |
| `src/engine/actions.js` | The action catalog: validation, checks and consequences for each action type |
| `src/engine/turn.js` | Turn executor: one transaction per turn, one savepoint per action, plan confirmation |
| `src/engine/memory.js`, `knowledge.js`, `relationships.js` | Episodic/summary memory with ranked retrieval; facts vs. beliefs; social dimensions |
| `src/engine/sim.js`, `economy.js`, `business.js` | Hourly/daily world simulation: schedules, gossip, NPC agendas, markets, production, businesses, contracts |
| `src/ai/*` | Local LLM wrapper, prompts, context builder, interpreter with repair, narrator with grounding, fallback parser |
| `src/service/*` | `GameService` (saves, autosave rotation, export/import, AI lifecycle, views); local dev HTTP server |
| `src/app/*` | Electron shell: sandboxed renderer, IPC whitelist, network blocking; spawns the game server |
| `src/service/server-entry.js` | Game server process (bundled Node runtime), loopback + token |
| `src/ui/*` | Text-first UI; procedural original artwork |
| `data/worlds/saltwind/world.json` | The setting, entirely data-driven |

## Decision records

### ADR-1: Electron + Node.js for the desktop shell
*Chosen:* Electron 38 (Node 22 inside). *Rejected:* Tauri (smaller binaries, but the game
engine would need a Rust rewrite or a bundled Node sidecar — two runtimes to ship and debug);
a Python stack (packaging native inference + Python on Windows is more fragile); a browser-only
game (cannot bundle a native model runtime). Electron gives one language for engine, AI layer
and UI and mature Windows packaging.

*Amendment (verified during packaging):* node-llama-cpp's prebuilt llama.cpp addon crashes
inside Electron 38's embedded runtime ("Illegal instruction") but works under standard Node 22.
The game therefore runs as a **separate process on a bundled standalone Node runtime**; Electron
is only the window. Renderer → whitelisted IPC → main process → HTTP on 127.0.0.1 with a
per-launch secret token → game server. Benefits beyond the fix: a model crash cannot take down
the UI, and native modules use one ABI (Node) in development, tests and production.

### ADR-2: llama.cpp via node-llama-cpp for inference
*Chosen:* node-llama-cpp 3.22 (bundles prebuilt llama.cpp for Windows x64 CPU and Vulkan; no
compiler or separate install). Its JSON-schema → GBNF grammar support makes malformed output
structurally impossible. *Rejected:* Ollama (separate service/install, network port);
an ONNX/DirectML stack (weaker model coverage, no grammar-constrained decoding); a Python
llama-cpp server (extra runtime). Vulkan covers NVIDIA, AMD and Intel GPUs with one backend;
CUDA builds are omitted to keep the installer smaller.

### ADR-3: SQLite as the single authoritative store, one transaction per turn
*Chosen:* better-sqlite3 with WAL and `synchronous=FULL`; CHECK constraints for invariants
(no negative balances, quantities > 0, relationship ranges); versioned migrations via
`user_version`. Every player turn is one transaction; each action is a savepoint. A crash at any
point leaves the world exactly as it was before the turn (tested). The save file *is* the
database; snapshots use SQLite's online backup API.
*Rejected:* JSON save files (no atomicity, no constraints); an event-sourced log replayed on load
(slower loads, harder migrations). We keep an append-only `events` table, `rolls` table with RNG
counters, `ledger_entries` and `item_log` for audit and replay of the parts that matter, while
current state lives in normal tables.

### ADR-4: Counter-based RNG
Every random draw is `hash(worldSeed, counter)`. The counter is persisted with each turn and
recorded on every roll, so any roll can be recomputed later and tests are reproducible.

### ADR-5: A fixed action vocabulary plus a bounded catch-all
Rather than letting the model invent mechanics, SATURN offers a broad typed vocabulary (talk,
tell, trade, steal, study, research, found a business, borrow, investigate, …) and an `attempt`
action for genuinely novel ideas. `attempt` is resolved with a real check, but its effects are
limited to time, experience, fatigue and small relationship changes — it can never create money,
items, or facts. New mechanics are added as new action types, not by trusting free-form output.

### ADR-6: Hybrid interpretation
Short unambiguous commands ("buy 2 bread", "go to the docks") are parsed deterministically
(fast path, instant). Everything else goes to the model. If the model fails validation twice,
times out, or is unavailable, the deterministic parser is used and the UI says so.

### ADR-7: Procedural original art
All imagery is generated in SVG by `src/ui/art.js` (time-of-day skies, the Great Ring, layered
location silhouettes, portrait medallions). This guarantees redistribution rights and costs
almost nothing in installer size.

## Data flow of one turn

1. UI → `GameService.act(text)`.
2. `GameMaster.interpret`: sanitize text; fast path or model with context built from the
   authoritative state the player can perceive plus retrieved player memories.
3. Validation (`normalizeInterpretation`). Consequential multi-step or long plans → stored as
   a pending plan and previewed; nothing changes until the player confirms.
4. `executeTurn`: open transaction; for each action, savepoint → handler → checks, ledger and
   inventory operations, events, memories, relationship changes, time advance (which runs the
   hourly/daily world simulation) → commit.
5. `GameMaster.narrate`: the committed outcome (facts, disclosed knowledge, NPC persona,
   retrieved NPC memories) → model → grounding check → retry or template fallback.
6. Narration stored with the turn; the UI re-renders from authoritative state.
