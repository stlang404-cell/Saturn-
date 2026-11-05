# Simulation design

## SATURN Resolution System (SRS)

**Check:** `2d10 + attribute (1–5) + skill rank (0–10) + modifiers` vs. a **target number**.

| Difficulty | TN | Untrained average person (bonus 3) | Apprentice (bonus 7) | Expert (bonus 11) |
|---|---|---|---|---|
| trivial | 8 | 94% | automatic | automatic |
| easy | 11 | 79% | 97% | automatic |
| moderate | 14 | 55% | 85% | 99% |
| hard | 17 | 28% | 64% | 90% |
| very hard | 20 | 10% | 36% | 72% |
| extreme | 24 | 1% | 10% | 36% |
| legendary | 28 | impossible | 1% | 10% |

(Success = margin ≥ 0. Exact values come from enumerating all 100 outcomes; see `test/dice.test.js`.)

**Degrees by margin:** ≥ +8 critical · +4..+7 strong · 0..+3 success · −1..−3 partial (success
at a cost) · −4..−7 failure with a complication · ≤ −8 severe failure. Natural double 10 raises
the degree one step; double 1 lowers it. Not every failure is a catastrophe.

**Classification before rolling:** if even a roll of 2 succeeds the action is *automatic* (no
roll); if even 20 cannot reach a partial success it is *impossible under current conditions*
and the player is told what would have to change.

**Opposed checks** (stealing vs. perception, haggling vs. negotiation, deceiving vs. perception,
melee vs. melee) compare two rolls; ties favour the defender.

**Modifiers** are always itemised: attribute, skill, untrained penalty for specialist skills
(−3 for medicine, herbalism, engineering, alchemy, smithing), tools carried (`tool:<skill>`
items: +1/+2), weapons, armour, relationship (−3..+3 for social checks), fatigue, injury,
hunger, darkness, crowd cover, bulky hauls, preparation.

## Progression

XP to reach rank r is `8r² + 12r` (20, 56, 108, 176, 260, 360, 476, 608, 756, 920).

| Method | Rate (xp/hour, intellect 3) | Limit | Cost |
|---|---|---|---|
| Self-study | 0.42 | rank 1 | time |
| Book / archive reading room | 1.08 | the book's depth (3–4) | buy the book, or 1 mark/day at the archive |
| Mentor | 1.92 | one below the mentor | 2–4 marks per 4-hour lesson |
| Drills (physical skills) | ~0.9 | rank 4 | time, fatigue; needs a forge for smithing |
| Experimentation (trade/mental skills) | 0.72 | rank 6 | tools, materials |
| Real use in checks | 1–4.5 per check | none | only if the task challenges you |

Real use grants XP only when the task is not trivial for your current ability (TN must be
within 5 of your average result), failures teach slightly more than easy successes, and a daily
diminishing factor `1/(1 + xp_today/10)` applies to every method. Within a single study
session, hours 5–8 give 60% and beyond 8 give 25%; exhaustion reduces learning further.
Multi-day study runs as real days: lessons are paid, meals are bought, lodging is paid; the
routine stops when money runs out, the teacher is unavailable, the method's cap is reached or
a major world event happens.

## Economy

- **Ledger:** double-entry; every transaction sums to zero; balances cached and reconciled.
  Money enters only through `system:mint` (wages of the unsimulated wider economy, world
  creation) and leaves only through `system:sink` (household costs, savings leaving the
  region, fares, research materials). `moneySupply == minted − sunk` is tested.
- **Items:** created only by `init`, `produce` (recipes, fields, fleets) or `gather`;
  destroyed only by `consume` (eaten, used as inputs, bought by townsfolk) or `destroy`
  (spoilage, lost cargo). Ownership is separate from possession: stolen and consigned goods
  keep their legal owner.
- **Prices** are computed daily from merchants' real stock vs. each market's target stock:
  `price = base × clamp((target/stock)^0.6, 0.5, 3)`. Merchants sell at a markup and buy below
  market; relationships move prices by up to ±20%; haggling can move them further.
- **Daily cycle:** primary production (fields, fleets, saltpans) → mills and kitchens convert
  inputs (buying them from local producers) → standing supply deals → merchants restock along
  the river (cheapest supplier first) → townsfolk earn wages, pay taxes and buy goods from the
  cheapest seller → household upkeep → stipends → spoilage → resources regrow → prices update.
- **Businesses:** rent, wages, weekly management check (owner's Commerce) setting efficiency,
  inputs bought from real merchants, production through recipes, sales to townsfolk and
  merchants, investor profit shares, eviction after three days without rent. Trading companies
  run a loading → outbound → selling → returning cycle on the riverboat with freight costs and
  a small risk of losing cargo.
- **Loans:** lender must have the money; approval is a negotiation check against a TN set by
  amount, your cash and your guild standing; default damages trust and guild reputation and
  bars further credit.

## NPCs and the living world

- **Schedules:** each important NPC has a location per time block (dawn, morning, afternoon,
  evening, night). Location is a single column, so nobody is ever in two places.
- **Agendas** (rule-driven, logged in `npc_decisions` with reasons): the mayor quietly buys grain
  and flour into a chained granary to drive up prices before winter, then sells after harvest;
  Sabine Kroll cuts her prices to ruin Odile Varne; Odile repays a crushing guild debt in
  instalments and is ruined at Harvestide unless something changes; Jory's crew picks pockets
  while the watch's suspicion grows; merchants restock; workshops produce.
- **Knowledge:** facts have objective truth; characters hold beliefs (`known`, `suspected`,
  `rumor`) with confidence and source. Evening gossip spreads facts with decaying confidence;
  secrets (secrecy 2) only pass between people who trust each other deeply, and never from
  the person they concern. NPCs react to facts they come to believe (the watch captain raids the
  granary when she believes the hoard is real; arrests the fence).
- **Witnesses and hearsay:** events give memories only to characters present (stealth checks
  can reduce who notices). Witnesses retell notable deeds; listeners remember them as hearsay
  and adjust their view of the player.
- **Fidelity tiers:** NPCs present in a scene are simulated in detail (dialogue, checks,
  memories); offscreen important NPCs run hourly schedules and daily agendas; townsfolk are
  simulated in aggregate as a population with income and demand. The language model is never
  called for offscreen NPCs.
