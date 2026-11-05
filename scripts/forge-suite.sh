#!/usr/bin/env bash
# Cross-world validation: forge five substantially different worlds with the real local
# model, recording drafts, compiled specs and reports in data/forge-samples/.
set -u
cd "$(dirname "$0")/.."
run() { echo "=== $1"; node scripts/forge-world.mjs "data/forge-samples/$1" "$2" 2>&1 | grep -v Vulkan; }
run floating "Create a world where people live on floating continents above a vast ocean. Civilization is powered by crystals that manipulate gravity. There are competing trading republics, flying ships, unusual creatures, and powerful scientific institutions. I begin as a poor apprentice engineer."
run medieval "A medieval kingdom of feuding noble houses where magic is real but rare: hedge-witches brew remedies and court mages bend fire, at great personal cost. There are guilds, tournaments and monster-haunted forests. Also, magic does not exist and only charlatans claim it, yet wizards openly cast fireballs in the streets. I start as a squire with no lord."
run modern "Create a realistic modern world where I can build businesses, invest, pursue careers, develop relationships, and become wealthy or powerful. I start as a broke graduate in a mid-sized coastal city."
run interstellar "An interstellar society with competing planetary governments, advanced biotechnology, megacorporations, alien species and complex economic systems. I begin as an indebted freighter mechanic on an orbital station."
run postapoc "A post-apocalyptic survival world forty years after the collapse: no working governments, scavenger clans, water as currency, mutated wildlife, scraps of old technology. I start as a lone scavenger with a damaged water filter."
run original "An original universe: on the inside surface of a hollow world lit by a captive star, people can extract memories, store them in resonant crystals, and burn them as fuel for gravity manipulation. Forgetting is the price of power. Memory-brokers, archivist orders and the Forgotten (people who sold too much) shape society. I begin as a memory-courier who has sold one childhood summer."
