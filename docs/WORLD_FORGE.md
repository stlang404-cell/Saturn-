# World Forge — the universal living-world engine

SATURN does not ship a world. It ships an engine that builds a playable simulation from a
world the player describes, and keeps adapting that simulation as the player and NPCs change
it. *The Saltwind Reach* is now just the bundled sample world, written in the same format the
Forge produces.

## 1. Audit and migration (WF0)

Baseline before World Forge: 48/48 tests passing, packaged Linux desktop build verified
offline, Windows installer not yet built (no Windows environment; see `STATUS.md`).

Assumptions that prevented arbitrary worlds, and how each was removed:

| Assumption | Where | Now |
|---|---|---|
| Six fixed attributes, twenty fixed skills; LLM grammar enum of those skills | `rules.js`, `schema.js`, `resolve.js`, `game.js`, `actions.js` | Per-world **ruleset** (`buildRuleset(spec)`) — attributes, skills, keywords, learnability, currency. The LLM grammar is built per world from its skill ids. |
| Generic actions hard-wired to specific skills (stealing uses *sleight of hand*, …) | `actions.js` | 16 engine **roles** (steal, notice, haggle, fight, research, invent, …) mapped onto each world's skills (`skill_roles`); `game.skillFor()` translates. |
| NPC storylines coded by NPC id (mayor's hoard, price war, debt, thief, raids, arrests) | `sim.js` (71 refs) | Declarative **agendas** (`stockpile`, `undercut`, `debt`, `pilfer`, `adopt_innovations`) and **fact reactions** (`seize_store`, `arrest`, `publicize`) in `engine/agendas.js`, configured by world data. |
| Specific ids in actions (ferry operator, watch captain, evidence, observatory path, "marks", council fines) | `actions.js` | Route `operator`, NPC `guard` flag, fact `keepers`, evidence reactions, location `hidden_paths`, settlement `government`, `game.money()`. |
| Start location/facts/journal; two-town price columns; "marks"/"Great Ring" in prompts | `worldgen.js`, `service.js`, UI, `prompts.js` | `start` block; markets per settlement; per-world `worldBrief()` in every prompt. |

**Save compatibility.** Saves from before World Forge store the old world definition; when it
has no `skills`/`attributes`, the ruleset falls back to the legacy Saltwind definitions, so old
saves load and play unchanged. The database gained schema version 2 (`world_rules`,
`world_rule_revisions`, `capabilities`) through the existing migration mechanism.

## 2. Universal World Specification (WF1)

A World Specification (JSON, `spec_version: 2`) is fully declarative:

```
identity      id, name, tagline, premise, tone, intro, origin{kind, description}
laws          physics[], impossible[], common_knowledge[], magic{exists, summary}, technology{level, summary}
calendar      era, months[], weekdays[], start
characters    attributes[{id,label,info}], skills[{id,label,attr,group,desc,trained,keywords}], skill_roles{role→skill}
money         currency{name, plural, medium}
space         settlements[{id,name,population,wage,government}], locations[{id,name,settlement,kind,art,tags,description,x,y,data}], routes[[a,b,minutes,{mode,cost,operator}]]
things        item_types[{id,name,category,base_value,weight,commodity,tags(tool:<skill>, food),slot,data}], recipes[]
economy       markets{settlement:{item:[target_stock, daily_demand]}}, market_base, premises[], business_templates[]
society       factions[{id,name,description,treasury}], npcs[{id,name,role,location,schedule,attributes,skills,traits,persona,
              money,inventory,shop,production,job,teaches,lends,guard,healing,lodging,consumes_recipes,knows,goals,agendas,abilities,requests}]
knowledge     facts[{id,subject,content,truth,secrecy,tags,data{keepers,reactions,opportunity}}], hidden_stores[], secrets_at[]
rules         rules[] — world-specific abilities/technologies (see §4)
start         start{location, known_facts, journal, abilities}, backgrounds[]
```

Nothing in the engine refers to a particular world.

## 3. The Forge (WF2)

```
description ─► core ─► skills ─► roles ─► places ─► items ─► people ─► story ─► COMPILER ─► spec ─► validate/install
               (each stage: one grammar-constrained call; later stages use enums from earlier ones)
```

* **Stages** (`src/forge/stages.js`): identity & laws (including contradiction resolution),
  skills, role mapping, places & travel, items & production, factions & people, and
  secrets/agendas/requests/special rules/backgrounds. Grammar constraints make cross-references
  structurally valid where possible (an NPC's skills must be among the world's skills, its
  location among the generated places, its wares among the generated items).
* **Compiler** (`src/forge/compile.js`) derives what a model should not have to spell out —
  ids, a map layout, a guaranteed-connected route graph, markets and regional price differences,
  schedules, money, stock, producers for every traded good, mentors, lenders, hosts, premises
  and business types — and **repairs** anything inconsistent (dangling connections, unknown
  items in recipes, value-creating recipes, requests from nobody, impossible starting wealth).
  Every repair, approximation and warning is listed in the Forge preview.
* **Preview & revision**: the player sees laws, skills, places, people, goods, tensions, rules
  and the validation report; can rename, regenerate any stage (and everything after it) with
  feedback, save to the **World Library**, and start any number of independent games in it.

## 4. The adaptive rule engine (WF3)

World-specific abilities, techniques, technologies and processes are **declarative rules**
(`src/engine/worldrules.js`) built from a fixed vocabulary:

* **requires**: learned capability, minimum skill, tools, location tags, a target
* **costs**: items consumed, money, fatigue, health
* **resolution**: the world's skill vs a difficulty (optionally opposed), through the same
  dice and probability system as everything else
* **effects** per outcome (success / partial / failure): produce item, heal, harm target,
  harm self, fatigue, restore, learn fact, relationship, travel (speed factor), xp, note
* **limits**: uses per day; **learn**: hours and teachers

Validation (Ajv schema + semantic checks) maps unknown skills onto world roles, drops
references to non-existent items, bounds every number, and enforces **value conservation**:
an ability without inputs may yield at most ~20 currency of goods; with inputs, at most about
twice their value. Inventions are never trivial. No AI-generated code is ever executed — the
model can only fill in this data structure. Effects the vocabulary cannot express are
reported as *approximations* in the Forge preview rather than faked.

Players learn abilities from someone who has them (paid lessons) or by working them out alone
with enough skill; NPCs listed in the spec start with them.

## 5. Continuous adaptation (WF4)

* **Research and invention** are long projects resolved through repeated checks. Starting one
  needs a minimum rank for its novelty (incremental 1, significant 3, revolutionary 5);
  **foundation knowledge** matters — related facts of the world the character does not yet
  understand add +2 difficulty each (up to +6). Inventions consume materials every session.
* When a project completes, the **AI designer** (grammar constrained to the world's real items)
  proposes what it is: a device, a recipe to build more from real materials, and a usage rule.
  The engine validates and installs it: the device as an item type, the recipe into the world,
  the rule as a versioned `world_rules` row whose revision references the causing event, a
  discovery fact (secret until shared or demonstrated), and the inventor's capability.
  Without the AI, a clearly labelled generic design is installed instead.
* **NPC response**: news spreads through the normal gossip/witness system; NPCs with the
  `adopt_innovations` agenda who know of it and have the skill may adopt it (gaining the
  capability, recorded with reasons); adoption earns the inventor respect.
* History is never rewritten: rule changes create new revisions; nothing is deleted.

## 6. World-aware Game Master

Each world gets its own system prompts (`worldBrief()`): premise, physical rules, magic,
technology, what is impossible, common knowledge, currency and the special abilities that
exist — so "impossible" is judged against *this* world, and narration may not introduce
magic or technology the world does not allow. The interpreter's grammar restricts skills to
the world's skills. Prompts are cached per world and per rule version.

## 7. Acceptance (directive §16) — real model, offline

`scripts/acceptance-forge.mjs --forge "<description>"` runs inside a network namespace with
no network (it checks this first). It forges a world from the description with the bundled
Qwen3-4B on CPU, saves it to the library, creates a poor apprentice engineer, and plays through
`GameService` exactly as the UI does. Two runs are recorded. Run 1
(`docs/benchmarks/acceptance-forge-run1.log`) forged the world, which is kept as
`data/forge-samples/acceptance.*`. Run 2 (`acceptance-forge-run2.log`) replays play on that
world after the fixes listed below. Both passed:

* Forged "Aethelis" (floating continents, gravity crystals) in 1335 s: 16 world skills,
  5 factions, 9 NPCs, 20 compiler repairs listed in the report.
* Conversation, NPC memory and a purchase attempt in the world currency.
* A flying-machine invention attempt while unqualified is refused by the engine (rank 0 < 3).
* After qualification, research leads to a design by the local AI. The engine validates it and
  installs it as a device item, recipe and versioned rule (run 1: "Gravity-Responsive Sky
  Lift Pod"; run 2: "Gravity-Resonance Sky-Frame"; both with a travel effect), with its causing event recorded.
* NPCs hear of it; 30 days pass; ledger and inventory reconcile; the save closes and reloads
  identically.

**Disclosed shortcuts in the script:** it mints 300 currency (standing in for months of wages)
and grants 300 XP of recorded mentoring in the invention skill (standing in for months of
apprenticeship). Without them the same path takes many in-game months of play. The script also
seeds the rumour to one innovation-minded NPC. In the recorded runs no NPC adopted the device
within 30 days; adoption requires skill rank ≥ 3 and is probabilistic. The adoption mechanism
itself is verified in `test/forge.test.js`.

The runs found and fixed real bugs:
* The compact JSON grammar never stopped, so every LLM call padded to its token limit
  (interpretation 140 s → 35 s).
* `wait` ignored `days`.
* "Use <device>" wasn't routed to the device's ability.
* Studying with an absent named teacher silently became self-study.

## 8. Known limitations (World Forge)

* Generation on a 4-core CPU takes 22–35 minutes per world. The stages are genuinely
  token-bound (~7–8 tokens/s, 8–10k tokens per world). GPU speed has not been measured.
* The 4B model sometimes picks the research skill where the invention skill applies, or
  proposes `craft` for a new design; the engine refuses or reroutes, and a retry usually works.
* The rule vocabulary is finite: concepts like mind control, time travel or reshaping terrain
  are approximated (reported) rather than simulated.
* Settlement-scale institutions don't yet *create* new institutions or laws in response to
  innovations; adoption is individual.
* A single world spec has 2–3 settlements and 8–12 places at creation; procedural expansion
  of new regions during play is not implemented.
* Art is procedural and keyed to place kinds; exotic worlds reuse the closest scene types.
