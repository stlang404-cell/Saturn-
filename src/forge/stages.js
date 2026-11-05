// World Forge generation stages. Each stage is one grammar-constrained call to the local
// model with a compact schema; later stages are constrained by enums built from earlier
// stages (e.g. an NPC's skills must be among the world's generated skills, an NPC's
// location among the generated places). The deterministic compiler then completes and
// validates the result.
import { EFFECT_TYPES } from '../engine/worldrules.js';
import { DIFFICULTY_NAMES } from '../engine/dice.js';

const str = (max) => ({ type: 'string', maxLength: max });
const arr = (items, min, max) => ({ type: 'array', items, minItems: min, maxItems: max });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const en = (values) => ({ type: 'string', enum: values });

export const LOCATION_TAGS = ['market', 'lodging', 'food', 'work', 'library', 'healing', 'craft', 'government', 'crime', 'wild', 'gather', 'ruin', 'port', 'public', 'quiet', 'industry', 'religious', 'military'];
export const ITEM_CATEGORIES = ['commodity', 'material', 'food', 'tool', 'weapon', 'armor', 'clothing', 'book', 'medicine', 'treasure', 'vehicle', 'device'];
export const AGENDA_KINDS = ['stockpile', 'undercut', 'debt', 'pilfer', 'none'];

const SYSTEM = `You are the World Forge of SATURN, an offline engine that turns a player's description into a playable living-world simulation.
You design ONE part of the world at a time as JSON. Stay faithful to the player's description: invent original names and details, but never add genres, magic, technology or creatures that contradict it. If the description says nothing about something, choose what fits its tone. Prefer concrete, playable, interconnected details (who sells what, who needs what, who wants what) over lore.`;

export const STAGES = [
  {
    id: 'core', label: 'World identity, laws of nature and society',
    schema: () => obj({
      name: str(40), tagline: str(100), premise: str(400), tone: str(60),
      intro: str(700),
      contradictions_resolved: arr(str(160), 0, 3),
      physics: arr(str(160), 1, 5), impossible: arr(str(80), 0, 5), common_knowledge: arr(str(160), 0, 3),
      magic: obj({ exists: { type: 'boolean' }, summary: str(240) }),
      technology: obj({ level: str(40), summary: str(240) }),
      currency: obj({ name: str(24), plural: str(26), medium: str(100) }),
      attributes: arr(obj({ id: { type: 'string', pattern: '^[a-z]{3,12}$' }, label: str(20), info: str(80) }), 6, 6),
      calendar: obj({ era: str(30), months: arr(str(16), 4, 12), weekdays: arr(str(14), 4, 8) }),
      settlements: arr(obj({ name: str(40), kind: str(30), description: str(200), population: { type: 'integer', minimum: 50, maximum: 2000000 } }), 2, 3),
      player: obj({ background: str(40), description: str(200), wealth: en(['destitute', 'poor', 'modest', 'comfortable', 'rich']) }),
    }),
    prompt: (d) => `PLAYER'S DESCRIPTION:\n${d.description}\n\nDesign the world's identity: name, a one-line tagline, premise, tone, an evocative 2nd-person opening paragraph (intro) that places the player at the start, the laws of nature (physics) including anything unusual, what is impossible, what everyone knows, whether magic exists, technology level, the currency or medium of exchange, six character attributes suited to this world (lowercase ids), a calendar, 2-3 starting settlements (or habitats/stations/camps), and the player's starting background from the description. If the description contradicts itself, resolve it sensibly and note how in contradictions_resolved.`,
  },
  {
    id: 'skills', label: 'Skills and progression',
    schema: (d) => obj({
      skills: arr(obj({ id: { type: 'string', pattern: '^[a-z][a-z_]{2,24}$' }, label: str(30), attr: en(d.core.attributes.map((a) => a.id)), group: en(['physical', 'mental', 'social', 'trade', 'special']), desc: str(100), trained: { type: 'boolean' }, keywords: arr(str(20), 1, 4) }), 12, 18),
    }),
    prompt: (d) => `WORLD: ${brief(d)}\nATTRIBUTES: ${d.core.attributes.map((a) => a.id).join(', ')}\n\nDesign 12-18 skills that matter in THIS world (its trades, sciences, ${d.core.magic.exists ? 'magic, ' : ''}combat, social life, survival). They must also cover these universal needs, under names fitting the world: persuading, lying, threatening, bargaining, noticing, searching/investigating, stealing/infiltration, sneaking, fighting, physical labour, surviving outdoors, healing, running a business, research/scholarship, invention/engineering, crafting. "trained": true means useless without training. keywords: words a player might use for the skill.`,
  },
  {
    id: 'roles', label: 'Mapping universal actions to world skills',
    schema: (d) => {
      const ids = d.skills.skills.map((s) => s.id);
      return obj(Object.fromEntries(['social', 'lie', 'threaten', 'haggle', 'notice', 'search', 'steal', 'sneak', 'fight', 'labor', 'wilds', 'heal', 'manage', 'research', 'invent', 'craft'].map((r) => [r, en(ids)])));
    },
    prompt: (d) => `SKILLS: ${d.skills.skills.map((s) => `${s.id} (${s.desc})`).join('; ')}\n\nFor each universal action, choose the skill of this world that governs it: social=persuading, lie=deceiving, threaten=intimidating, haggle=bargaining, notice=perceiving, search=investigating, steal=stealing/hacking/infiltration, sneak=stealth, fight=combat, labor=physical work, wilds=survival outdoors, heal=medicine, manage=running a business, research=scholarship, invent=engineering/invention, craft=making things.`,
  },
  {
    id: 'places', label: 'Places and travel',
    schema: (d) => obj({
      locations: arr(obj({
        name: str(40), settlement: en([...d.core.settlements.map((s) => s.name), 'wilds']),
        kind: str(24), tags: arr(en(LOCATION_TAGS), 1, 4), description: str(260),
        connections: arr(obj({ to: str(40), minutes: { type: 'integer', minimum: 2, maximum: 2880 }, mode: str(20) }), 1, 3),
      }), 8, 12),
      start: str(40),
    }),
    prompt: (d) => `WORLD: ${brief(d)}\nSETTLEMENTS: ${d.core.settlements.map((s) => `${s.name} (${s.kind}): ${s.description}`).join(' | ')}\n\nDesign 8-12 places where play happens: in each settlement at least a market or trading place, somewhere to sleep and eat (tag lodging+food), places of work, learning (library), healing, government/law, and a seedy place; plus 1-3 places in the wilds. connections link places by exact name with travel minutes and a mode of travel suitable for this world (walk, ship, lift, shuttle, airship, cart...). Settlements must be connected to each other. start = the place where the player begins.`,
  },
  {
    id: 'items', label: 'Items, resources and production',
    schema: (d) => {
      const skills = d.skills.skills.map((s) => s.id);
      return obj({
        items: arr(obj({
          id: { type: 'string', pattern: '^[a-z][a-z_]{2,30}$' }, name: str(40), category: en(ITEM_CATEGORIES),
          value: { type: 'integer', minimum: 1, maximum: 5000 }, weight: { type: 'number', minimum: 0, maximum: 500 },
          traded_commodity: { type: 'boolean' }, food: { type: 'boolean' }, tool_for: { type: ['string', 'null'], enum: [...skills, null] }, description: str(120),
        }), 14, 20),
        recipes: arr(obj({ name: str(40), skill: en(skills), inputs: arr(obj({ item: str(31), qty: { type: 'integer', minimum: 1, maximum: 10 } }), 1, 3), outputs: arr(obj({ item: str(31), qty: { type: 'integer', minimum: 1, maximum: 12 } }), 1, 2), minutes: { type: 'integer', minimum: 15, maximum: 960 } }), 3, 6),
      });
    },
    prompt: (d) => `WORLD: ${brief(d)}\nCURRENCY: ${d.core.currency.name} (${d.core.currency.medium})\nSKILLS: ${d.skills.skills.map((s) => s.id).join(', ')}\n\nDesign 14-20 item types with prices in ${d.core.currency.plural}: everyday food (food=true), raw materials and goods traded between settlements (traded_commodity=true, at least 6), tools that help specific skills (tool_for), a weapon, protective gear, and 1-2 rare valuables. Include this world's distinctive resources (e.g. what powers its civilisation). Then 3-6 production recipes turning materials (by item id) into goods.`,
  },
  {
    id: 'people', label: 'Factions and people',
    schema: (d) => {
      const skills = d.skills.skills.map((s) => s.id);
      const places = d.places.locations.map((l) => l.name);
      const items = d.items.items.map((i) => i.id);
      return obj({
        factions: arr(obj({ name: str(50), description: str(200), governs: { type: ['string', 'null'], enum: [...d.core.settlements.map((s) => s.name), null] } }), 3, 5),
        npcs: arr(obj({
          name: str(40), role: str(50), location: en(places), faction: str(50), traits: arr(str(20), 2, 3), persona: str(200), goal: str(120),
          skills: arr(obj({ skill: en(skills), rank: { type: 'integer', minimum: 1, maximum: 9 } }), 2, 4),
          sells: arr(en(items), 0, 6), buys: arr(en(items), 0, 6), produces: arr(en(items), 0, 2),
          employs: { type: 'boolean' }, teaches: { type: 'boolean' }, lends: { type: 'boolean' }, guard: { type: 'boolean' }, healer: { type: 'boolean' }, host: { type: 'boolean' },
        }), 8, 12),
      });
    },
    prompt: (d) => `WORLD: ${brief(d)}\nPLACES: ${d.places.locations.map((l) => `${l.name} [${l.tags.join(',')}]`).join('; ')}\nITEMS: ${d.items.items.map((i) => i.id).join(', ')}\n\nDesign 3-5 factions (institutions, guilds, governments, gangs; "governs" names a settlement it rules, if any) and 8-12 important people spread across the places: merchants who sell and buy items, producers (farmers, miners, crafters) who produce items, at least 3 who employ, 2 who teach their skills, one who lends money, one guard/law officer, one healer, one host who runs lodging. Each has a role, faction (by name or "none"), traits, a voice/persona, and a personal goal.`,
  },
  {
    id: 'story', label: 'Secrets, tensions, special rules and starting options',
    schema: (d) => {
      const names = d.people.npcs.map((n) => n.name);
      const items = d.items.items.map((i) => i.id);
      const skills = d.skills.skills.map((s) => s.id);
      const effect = obj({ type: en(EFFECT_TYPES.filter((t) => t !== 'learn_fact')), item: { type: ['string', 'null'], enum: [...items, null] }, amount: { type: ['integer', 'null'], minimum: 1, maximum: 40 }, text: str(160) });
      return obj({
        facts: arr(obj({ subject: str(50), content: str(240), secret_level: { type: 'integer', minimum: 0, maximum: 2 }, true_fact: { type: 'boolean' }, known_by: arr(en(names), 1, 4), keepers: arr(en(names), 0, 2), tags: arr(str(20), 2, 6) }), 4, 8),
        agendas: arr(obj({ who: en(names), kind: en(AGENDA_KINDS), partner_or_rival: { type: ['string', 'null'], enum: [...names, null] }, items: arr(en(items), 0, 2), motive: str(120) }), 1, 3),
        requests: arr(obj({ giver: en(names), title: str(50), text: str(200), item: en(items), qty: { type: 'integer', minimum: 1, maximum: 12 }, deliver_to: en(names), reward: { type: 'integer', minimum: 1, maximum: 5000 }, days: { type: 'integer', minimum: 2, maximum: 120 } }), 2, 4),
        special_rules: arr(obj({
          name: str(40), kind: en(['ability', 'technique', 'technology', 'process']), summary: str(200), skill: en(skills), difficulty: en(DIFFICULTY_NAMES),
          minutes: { type: 'integer', minimum: 5, maximum: 600 }, must_be_learned: { type: 'boolean' }, min_skill: { type: 'integer', minimum: 0, maximum: 8 },
          consumes: arr(obj({ item: en(items), qty: { type: 'integer', minimum: 1, maximum: 6 } }), 0, 2), fatigue: { type: 'integer', minimum: 0, maximum: 40 },
          on_success: arr(effect, 1, 2), on_failure: arr(effect, 0, 2), known_by: arr(en(names), 0, 3),
        }), 1, 4),
        backgrounds: arr(obj({ name: str(40), description: str(160), attribute_bonus: arr(en(d.core.attributes.map((a) => a.id)), 1, 2), skills: arr(obj({ skill: en(skills), rank: { type: 'integer', minimum: 1, maximum: 2 } }), 2, 3), items: arr(en(items), 1, 3), money: { type: 'integer', minimum: 0, maximum: 100000 } }), 3, 3),
      });
    },
    prompt: (d) => `WORLD: ${brief(d)}\nPEOPLE: ${d.people.npcs.map((n) => `${n.name} (${n.role}, ${n.location})`).join('; ')}\nITEMS: ${d.items.items.map((i) => `${i.id}=${i.value}`).join(', ')}\nPLAYER START: ${d.core.player.background} — ${d.core.player.description} (${d.core.player.wealth})\n\nDesign: 4-8 facts (rumours, secrets, public knowledge, some false) and who knows them; 1-3 NPC agendas creating tension (stockpile = secretly hoard goods bought from a partner to raise prices; undercut = price war against a rival; debt = owes money they may not repay; pilfer = petty theft; none); 2-4 requests NPCs need done (deliver items to someone, with a reward in ${d.core.currency.plural}); 1-4 special rules that make this world mechanically distinctive (its unusual physics, magic or technology as usable abilities, with real costs and failure effects); and 3 starting backgrounds — the FIRST must match the player's described start (${d.core.player.background}); money fits the wealth level and item prices.`,
  },
];

function brief(d) {
  const c = d.core;
  return `${c.name} — ${c.tagline}. ${c.premise} Physics: ${c.physics.join(' ')} Magic: ${c.magic.exists ? c.magic.summary : 'none'}. Technology: ${c.technology.summary}.`;
}

export function stagePrompt(stage, draft, feedback) {
  return { system: SYSTEM, user: stage.prompt(draft) + (feedback ? `\n\nREVISION REQUEST FROM THE PLAYER: ${feedback}` : '') };
}

export const STAGE_TOKENS = { core: 1800, skills: 1800, roles: 320, places: 2400, items: 2400, people: 3400, story: 3600 };
