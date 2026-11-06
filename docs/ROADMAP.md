# Roadmap

Milestones from the directive, with where SATURN stands. See `docs/STATUS.md` for evidence.

| Milestone | State |
|---|---|
| M0 Foundations | Done: research, model benchmark, architecture, contracts, skeleton, build verified |
| M1 First playable world | Done: creation, locations, free text, checks, inventory, NPCs, events, persistence |
| M2 Local AI Game Master | Done for the core loop: real offline inference, structured interpretation, grounded narration, repair/fallback. Quality tuning continues |
| M3 Persistent intelligence | Largely done: memory, beliefs, relationships, autonomous agendas, world time, retrieval tests |
| M4 Living economy | Partly done: trade, businesses, production, loans, investment. Not yet: property purchase, auctions, banking, prediction markets |
| M5 Polished release | Partly done: UI, onboarding hints, Windows build pipeline. Pending: installer verified on real Windows hardware, broader balancing |

## World Forge milestones

| Milestone | State |
|---|---|
| WF0 Existing build audit | Done (baseline 48/48; assumptions catalogued in `WORLD_FORGE.md`) |
| WF1 Universal World Specification | Done (spec v2, rulesets, roles, declarative agendas/reactions, schema migration v2) |
| WF2 World Forge | Done (staged generation, compiler, preview, revise, library, UI) |
| WF3 Adaptive gameplay | Done for the core loop (world skills/currency/laws in engine and prompts, rule engine, use/learn abilities) |
| WF4 Continuous adaptation | Done for inventions → capabilities → NPC adoption; institutions reacting with new laws not yet |
| WF5 Release quality | In progress: cross-world tests, real-model acceptance; generation speed on CPU is the main gap |

## World Forge next steps

1. **Generation speed**: GPU (Vulkan) measurement; parallel stage generation where independent;
   a streaming preview so players watch the world appear; optional "quick world" with fewer places.
2. **Recipe stage with item enums** (separate grammar-constrained call) so recipes never name
   undefined materials (today the compiler creates them, transparently).
3. **Passive world laws as mechanics**: environmental modifiers (e.g. gravity tides changing
   difficulty of certain skills by location/time) as a declarative rule type.
4. **Institutional adaptation**: factions issuing licences, bans or monopolies in response to
   innovations (declarative reaction types), and NPC-originated research projects.
5. **Procedural expansion**: generate new regions/settlements on demand when the player travels
   beyond the map, grounded in the existing spec.
6. **Realism controls**: an optional "grounded/realistic" style instruction so realistic worlds
   use plain skill names (finance, programming) instead of stylised ones.
7. Art: more procedural scene families (sky islands, stations, wastelands, cities).

## Next (M5 completion), in priority order

1. **Run the Windows release workflow** on a real Windows runner and play-test the installed
   build on 2–3 hardware tiers (CPU-only laptop, Vulkan iGPU, discrete GPU). Record latency.
2. **Interpretation quality loop:** collect player inputs where the model fell back or chose a
   poor action (the turn log stores them), grow the benchmark set from 12 to ~100 cases, and tune
   prompts and few-shot examples against it.
3. **Streaming narration** to the UI (tokens as they arrive) to hide CPU latency.
4. **Combat depth:** stances, retreat, wounds that need treatment, weapons with more variety.
5. **NPC dialogue memory in narration:** surface promises and grudges more prominently in what
   NPCs say.
6. **Balancing pass** on wages, prices and progression with longer AI-driven play sessions.

## Later (M4 depth and beyond)

- Property ownership and purchase (premises, farmland), auctions.
- Banking, deposits, interest, bankruptcy of player businesses with creditor claims.
- Fictional-money speculation: commodity futures between Brindlemarch and Kestrel Point.
- Factions acting as agents (guild policy, council elections, watch crackdowns).
- More settlements generated from the data format; a second setting to prove the world format.
- Optional embeddings for semantic memory retrieval (interface already isolated).
- Accessibility: screen-reader pass, high-contrast theme, full keyboard map in-app.
