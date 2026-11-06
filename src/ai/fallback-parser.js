// Deterministic rule-based interpreter. Used when the local model is unavailable,
// fails, or times out, and as the reference parser in tests. It covers common
// phrasings; anything it cannot map is returned as a clarification request rather
// than guessed. Output goes through the same schema validation as the LLM's.
import { blankAction } from './schema.js';

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, few: 3, several: 4, some: null };

function num(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUM_WORDS[t] ?? null;
}

/** Parse "for 3 months", "for two weeks", "for 6 hours" → {days, hours} */
export function parseDuration(text) {
  const m = text.match(/\b(?:for|over|during|spend(?:ing)?|next)\s+(?:the\s+next\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|few|several)?\s*(hour|hr|day|week|month|year)s?\b/i)
    || text.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(hour|hr|day|week|month|year)s?\b/i);
  if (!m) return {};
  const n = num(m[1] || 'a') || (m[1] && m[1].toLowerCase() === 'few' ? 3 : 1);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('h')) return { hours: n };
  const days = unit === 'day' ? n : unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n * 360;
  return { days };
}

function act(type, fields = {}) {
  return { ...blankAction(type), ...fields };
}

const NAME_RX = '([a-z][a-z\'\\- ]{1,40}?)';

function stripPolite(s) {
  return s.replace(/^(i\s+(?:want|would like|wish|try|attempt|decide|intend|plan|am going|'m going)\s+(?:to\s+)?|let me\s+|i\s+|please\s+|can i\s+|could i\s+|let's\s+|try to\s+|attempt to\s+)/i, '').replace(/[.!?]+$/, '').trim();
}

export function parseSingle(raw) {
  const original = raw.trim();
  const s = stripPolite(original);
  const l = s.toLowerCase();
  const dur = parseDuration(l);
  let m;

  if (/^(look|look around|l|where am i|survey|observe)( the (room|area|place))?$/.test(l) || /^(look|glance|gaze|peer) (around|about)\b/.test(l) || /^(take in|get my bearings|survey) /.test(l)) return act('look');
  if ((m = l.match(/^(?:look at|examine|inspect|study the face of|x)\s+(.+)$/)) && !/\b(granary|mill|ruin|records|market|prices)\b/.test(m[1])) return act('look', { target: m[1] });
  if (/^(inventory|inv|i|status|stats|check (my )?(status|inventory|purse|money)|how much money( do i have)?)$/.test(l)) return act('status');

  // employment
  if (/\b(job|work for|employ|hire me|any work|for work|a position|apprentice(ship)?)\b/.test(l) && /\b(ask|seek|look for|apply|request|beg|need|want|get|find|offer|hire)\b/.test(l)) {
    m = l.match(/\b(?:ask|beg|request|apply (?:to|with)|offer (?:my services )?to)\s+([a-z' -]+?)\s+(?:for|about|if|whether)\b/) || l.match(/\b(?:work for|hire me,?|from)\s+([a-z' -]+?)$/) || l.match(/\b(?:with|for)\s+([a-z' -]+?)$/);
    return act('ask_job', { target: m ? m[1] : null });
  }
  if ((m = l.match(/^work(?:\s+(?:a|another|\d+|one|two|three|four|five|six))?(?:\s+(?:shift|shifts|day|days))?(?:\s+(?:for|at)\s+(.+))?$/))) {
    const q = l.match(/\b(\d+|two|three|four|five|six)\s+(shift|day)s?\b/);
    return act('work', { target: m[1] || null, quantity: q ? num(q[1]) : null });
  }
  // tasks
  if (/^(accept|agree to|take on|take the|i'll do|i will do|yes,? i'll|deal)\b/.test(l) && /\b(task|job|request|offer|quest|errand|deal|it|run|delivery|that)\b/.test(l)) {
    m = l.match(/\b(?:from|for)\s+([a-z' -]+)$/);
    return act('accept_request', { target: m ? m[1] : null, topic: l });
  }
  // loans & money
  if ((m = l.match(/\b(?:borrow|loan of|lend me|take (?:out )?a loan(?: of)?)\s+(\d+)?\s*(?:marks?)?\s*(?:from\s+(.+))?/)) || (m = l.match(/\bask\s+(.+?)\s+(?:for|to lend me)\s+(?:a\s+)?(?:loan|money)(?:\s+of\s+(\d+))?/))) {
    if (/\bask\s/.test(l) && !/borrow|lend me/.test(l)) return act('loan', { target: m[1], price: m[2] ? Number(m[2]) : null });
    const amt = l.match(/(\d+)/);
    const from = l.match(/\bfrom\s+([a-z' -]+?)(?:\s+(?:for|to|at|so)\b|$)/);
    return act('loan', { price: amt ? Number(amt[1]) : null, target: from ? from[1] : null });
  }
  if (/\b(repay|pay back|pay off|settle (?:my )?debt)\b/.test(l)) {
    const amt = l.match(/(\d+)/), to = l.match(/\b(?:to|for)\s+([a-z' -]+)$/);
    return act('repay', { price: amt ? Number(amt[1]) : null, target: to ? to[1] : null });
  }
  if (/\b(invest in|finance|fund|back)\b/.test(l) && /\b(ask|convince|persuade|pitch|propose)\b/.test(l)) {
    m = l.match(/\b(?:ask|convince|persuade|pitch (?:to)?|propose to)\s+([a-z' -]+?)\s+(?:to|for|that|about)\b/);
    const amt = l.match(/(\d+)/);
    return act('invest', { target: m ? m[1] : null, price: amt ? Number(amt[1]) : null, detail: original });
  }
  // business
  if ((m = l.match(/\b(?:found|start|open|establish|set up|launch|create|build)\s+(?:my own |a |an |my |our )?(?:new )?(.*?(?:bakery|brewery|brewhouse|company|business|shop|works|apothecary|trading|firm|venture|house|enterprise|curing).*)$/))) {
    const capital = l.match(/(?:with|invest(?:ing)?|capital of|using)\s+(\d+)/);
    return act('found_business', { item: m[1], detail: original, price: capital ? Number(capital[1]) : null, approach: /licen[cs]/.test(l) ? 'licensed' : null });
  }
  if (/\b(deposit|withdraw|business report|check (?:on )?my business|close my business|hire staff|pause|resume)\b/.test(l)) {
    const amt = l.match(/(\d+)/);
    return act('manage_business', { detail: l, price: amt ? Number(amt[1]) : null });
  }
  // trade
  if ((m = l.match(/^(?:buy|purchase|get me|order)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|some)\s+)?(.+?)(?:\s+from\s+([a-z' -]+?))?(?:\s+for\s+(\d+)(?:\s*marks?)?(?:\s+(each|total|in total))?)?$/))) {
    return act('buy', { quantity: num(m[1]) || 1, item: m[2].replace(/^(a|an|the|some)\s+/, ''), target: m[3] || null, price: m[4] ? Number(m[4]) : null });
  }
  if ((m = l.match(/^(?:sell)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|all|my)\s+)?(.+?)(?:\s+to\s+([a-z' -]+?))?(?:\s+for\s+(\d+)(?:\s*marks?)?(?:\s+each)?)?$/))) {
    return act('sell', { quantity: m[1] === 'all' || m[1] === 'my' ? null : num(m[1]) || 1, item: m[2], target: m[3] || null, price: m[4] ? Number(m[4]) : null });
  }
  if ((m = l.match(/^(?:haggle|bargain|negotiate)\s+(?:with\s+)?([a-z' -]+?)\s+(?:for|over)\s+(?:(\d+)\s+)?(.+?)(?:\s+at\s+(\d+))?$/))) {
    return act('buy', { target: m[1], quantity: m[2] ? Number(m[2]) : 1, item: m[3], price: m[4] ? Number(m[4]) : null });
  }
  if ((m = l.match(/^give\s+(\d+)\s*(?:marks?|coins?|silver)\s+to\s+(.+)$/)) || (m = l.match(/^give\s+(.+?)\s+(\d+)\s*(?:marks?|coins?)$/))) {
    const isFirstNum = /^\d+$/.test(m[1]);
    return act('give', { item: 'money', price: Number(isFirstNum ? m[1] : m[2]), target: isFirstNum ? m[2] : m[1] });
  }
  if ((m = l.match(/^(?:give|hand|deliver|bring|offer|return)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|all|the|my)\s+)?(.+?)\s+to\s+(.+)$/))) {
    return act('give', { quantity: num(m[1]) || (m[1] === 'all' ? 999 : 1), item: m[2].replace(/^(the|my)\s+/, ''), target: m[3] });
  }
  // crime
  if ((m = l.match(/^(?:steal|pickpocket|swipe|lift|pinch|filch|rob)\s+(?:(\d+|a|an|one|two|three|some)\s+)?(.+?)(?:\s+from\s+(.+))?$/))) {
    if (!m[3] && /^(pickpocket|rob)/.test(l)) return act('steal', { target: m[2], item: 'money' });
    return act('steal', { quantity: num(m[1]) || 1, item: m[2].replace(/^(the|some|his|her|their)\s+/, ''), target: m[3] || null });
  }
  if ((m = l.match(/^(?:attack|fight|hit|punch|stab|kill|assault|strike)\s+(.+)$/))) return act('attack', { target: m[1] });
  // social
  if ((m = l.match(/^tell\s+([a-z' -]+?)\s+(?:about|that|of)\s+(.+)$/)) || (m = l.match(/^(?:inform|warn|alert|report to)\s+([a-z' -]+?)\s+(?:about|that|of)\s+(.+)$/))) return act('tell', { target: m[1], topic: m[2] });
  if ((m = l.match(/^(?:show)\s+(?:the\s+)?(.+?)\s+to\s+(.+)$/))) return act('tell', { target: m[2], topic: m[1] });
  if ((m = l.match(/^(?:persuade|convince)\s+([a-z' -]+?)\s+(?:to|that|into|of)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'persuade', detail: m[2] });
  if ((m = l.match(/^(?:intimidate|threaten|menace|lean on)\s+([a-z' -]+?)(?:\s+(?:into|to|about|until)\s+(.+))?$/))) {
    const topic = m[2] && /tell|reveal|confess|admit|explain/.test(m[2]) ? m[2].replace(/^(telling|tell|revealing|reveal|confessing|confess|admitting|admit)\s+(me\s+)?(about\s+|what\s+)?/, '') : null;
    return act('talk', { target: m[1], approach: 'intimidate', detail: m[2] || null, topic });
  }
  if ((m = l.match(/^(?:lie to|deceive|trick|bluff|con|fool)\s+([a-z' -]+?)(?:\s+(?:that|about|into|by saying)\s+(.+))?$/))) return act('talk', { target: m[1], approach: 'deceive', detail: m[2] || null });
  if ((m = l.match(/^(?:flatter|compliment|praise)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'flatter' });
  if ((m = l.match(/^(?:apologi[sz]e to|say sorry to)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'apologize' });
  if ((m = l.match(/^(?:insult|mock|curse at|offend)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'insult' });
  if ((m = l.match(/^(?:ask|question|quiz|interrogate|press)\s+([a-z' -]+?)\s+(?:about|regarding|on|if|whether|what|why|who|where|how)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'ask', topic: m[2] });
  if ((m = l.match(/^(?:talk|speak|chat|converse)\s+(?:to|with)\s+([a-z' -]+?)(?:\s+(?:about|regarding)\s+(.+))?$/))) return act('talk', { target: m[1], approach: m[2] ? 'ask' : 'chat', topic: m[2] || null });
  if ((m = l.match(/^(?:greet|meet|introduce myself to|say hello to|hail|approach)\s+(.+)$/))) return act('talk', { target: m[1], approach: 'chat' });
  if ((m = l.match(/^(?:say|tell)\s+["“](.+)["”]\s+to\s+(.+)$/)) || (m = l.match(/^(?:say to)\s+([a-z' -]+?)[,:]\s*(.+)$/))) return act('talk', { target: m[2] && !m[1].includes(' ') ? m[1] : m[2], detail: m[1].includes(' ') ? m[1] : m[2], approach: 'chat' });
  // travel
  if ((m = l.match(/^(?:go|walk|travel|head|return|move|run|hurry|sail|journey|ride|take the (?:boat|riverboat|ferry))(?:\s+back)?(?:\s+(?:to|towards|toward|into|over to|down to|up to|out to|for))?\s+(?:the\s+)?(.+)$/))) return act('move', { destination: m[1] });
  if ((m = l.match(/^(?:visit|enter|leave for)\s+(?:the\s+)?(.+)$/))) return act('move', { destination: m[1] });
  // learning
  if ((m = l.match(/^(?:study|learn|read about|read up on|take lessons in|research the basics of)\s+(.+?)(?:\s+(?:with|from|under)\s+([a-z' -]+?))?(?:\s+(?:for|over)\s+.+)?$/)) || (m = l.match(/^(?:spend .+? (?:studying|learning))\s+(.+?)(?:\s+(?:with|from|under)\s+([a-z' -]+?))?$/))) {
    const skill = m[1].replace(/\s+(for|over)\s+.*$/, '').trim(); // resolved against the world's skills by the engine
    if (skill) return act('study', { skill, target: m[2] || null, hours: dur.hours || null, days: dur.days || null, approach: null });
  }
  if ((m = l.match(/^(?:read)\s+(?:my\s+|the\s+)?(.+)$/))) return act('use', { item: m[1], hours: dur.hours || null });
  if ((m = l.match(/^(?:train|practi[cs]e|drill|exercise)\s+(?:my\s+)?(.+?)(?:\s+(?:for|over)\s+.+)?$/))) {
    const skill = m[1].trim();
    if (skill) return act('train', { skill, hours: dur.hours || null, days: dur.days || null });
  }
  // invention & research
  if ((m = l.match(/^(?:research|invent|design|develop|devise|experiment with|work on|engineer|discover)\s+(?:a |an |the |new |my )*(.+)$/))) {
    const novelty = /never seen|revolution|unheard|first ever|world-changing/.test(l) ? 'revolutionary' : /new|novel|better|improved|alloy|machine|method/.test(l) ? 'significant' : 'incremental';
    const skill = /alloy|metal|machine|engine|device|mechan|transport|wheel|mill|pump|bridge/.test(l) ? 'engineering' : /potion|tincture|chemical|reagent/.test(l) ? 'alchemy' : /cure|disease|medicine|remedy/.test(l) ? 'medicine' : /herb|plant|crop/.test(l) ? 'herbalism' : 'scholarship';
    return act('research', { topic: m[1].slice(0, 80), detail: original, skill, novelty, hours: dur.hours || 4, approach: /invent|design|device|machine|alloy|build/.test(l) ? 'invention' : null });
  }
  // crafting, gathering
  if ((m = l.match(/^(?:craft|make|bake|brew|forge|cook|smith|prepare|salt|cure)\s+(?:(\d+|a|an|one|two|three|some)\s+)?(?:batch(?:es)? of\s+)?(.+)$/))) {
    const verb = l.split(' ')[0];
    const item = ['bake', 'brew', 'salt', 'cure'].includes(verb) ? `${verb} ${m[2]}` : m[2];
    return act('craft', { item, quantity: num(m[1]) || 1 });
  }
  if ((m = l.match(/^(?:gather|forage(?: for)?|pick|collect|harvest|chop|cut)\s*(.+)?$/))) return act('gather', { item: m[1] ? m[1].replace(/^(some|for)\s+/, '') : null, hours: dur.hours || null });
  // investigation
  if ((m = l.match(/^(?:investigate|search|explore|snoop(?: around)?|look for|hunt for|examine|inspect|scout|case|check)\s*(.*)$/))) return act('investigate', { topic: m[1] || null, detail: original });
  if (/\b(prices?|market)\b/.test(l) && /\b(check|look|see|compare)\b/.test(l)) return act('investigate', { topic: 'market prices' });
  // needs
  if ((m = l.match(/^(?:sleep|rest|nap|lie down|go to bed|turn in)/))) return act('rest', { hours: dur.hours || (dur.days ? dur.days * 24 : null) });
  if ((m = l.match(/^(?:wait|pass time|idle|loiter|linger|bide)/))) return act('wait', { hours: dur.hours || (dur.days ? dur.days * 24 : 1) });
  if (/^(eat|have a meal|get (some )?food|have (some )?(dinner|breakfast|lunch|supper)|dine)/.test(l)) {
    m = l.match(/^eat\s+(?:my\s+|a\s+|some\s+|the\s+)?(.+)$/);
    return act('eat', { item: m && !/meal|food|something/.test(m[1]) ? m[1] : null });
  }
  if (/^(heal|treat|bandage|tend|patch up|see a healer|get healed)/.test(l)) return act('heal', {});
  if ((m = l.match(/^(?:equip|wear|wield|put on|don)\s+(?:my\s+|the\s+)?(.+)$/))) return act('equip', { item: m[1] });
  if ((m = l.match(/^(?:unequip|take off|remove)\s+(?:my\s+|the\s+)?(.+)$/))) return act('equip', { item: m[1], approach: 'unequip' });
  if ((m = l.match(/^(?:use|apply|drink|consume)\s+(?:my\s+|the\s+|a\s+)?(.+)$/))) return act('use', { item: m[1] });
  if ((m = l.match(/^(?:take|pick up|grab)\s+(?:(\d+)\s+)?(?:the\s+)?(.+?)(?:\s+from\s+(.+))?$/))) {
    if (m[3]) return act('steal', { item: m[2], target: m[3], quantity: m[1] ? Number(m[1]) : 1 });
    return act('take', { item: m[2], quantity: m[1] ? Number(m[1]) : 1 });
  }
  if ((m = l.match(/^(?:drop|put down|discard|leave)\s+(?:(\d+)\s+)?(?:the\s+|my\s+)?(.+)$/))) return act('drop', { item: m[2], quantity: m[1] ? Number(m[1]) : 1 });
  return null;
}

export const HELP_TEXT = 'Describe what you want to do in your own words — SATURN understands far more than commands. For example: "ask the innkeeper what she has heard lately", "ask the merchant for work", "buy two loaves of bread", "go to the market", "study medicine with the healer for a week", "investigate the warehouse at night", "borrow 50 from the moneylender and open a workshop", "invent a better pump", "use <one of this world\'s abilities>". People and exits on the left are clickable. The World and Journal tabs list opportunities; click any roll to see exactly how it was decided.';

const SPLIT_RX = /\s*(?:,?\s+and then\s+|,?\s+then\s+|;\s*|\.\s+(?=[A-Za-z]))\s*/i;

export function fallbackInterpret(text) {
  const t = String(text || '').trim();
  if (!t) return { mode: 'clarify', intent: '', actions: [], plan_title: null, risks: [], question: 'What would you like to do?', reason: null };
  if (/^(help|\?|how (do|can) i play|what can i do|commands)\b/i.test(t)) {
    return { mode: 'meta', intent: 'help', actions: [], plan_title: null, risks: [], question: HELP_TEXT, reason: null };
  }
  const parts = t.split(SPLIT_RX).filter(Boolean).slice(0, 6);
  const actions = [];
  const unparsed = [];
  for (const part of parts) {
    // "go to the market and buy bread" – split on " and " only when both halves parse
    const sub = part.split(/\s+and\s+(?=(?:go|buy|sell|talk|ask|study|work|eat|rest|sleep|tell|give|steal|investigate|search|read|train|craft|make|gather|then)\b)/i);
    for (const piece of sub) {
      const a = parseSingle(piece);
      if (a) actions.push(a);
      else unparsed.push(piece);
    }
  }
  if (!actions.length) {
    return {
      mode: 'clarify', intent: t.slice(0, 200), actions: [], plan_title: null, risks: [],
      question: `The offline parser couldn't map "${t.slice(0, 80)}" to an action. Try simple phrasing like: "talk to <person> about <topic>", "buy 2 <item>", "go to <place>", "study <skill> for 5 days", "investigate", or "help".`,
      reason: 'fallback parser: no pattern matched',
    };
  }
  const long = actions.some((a) => (a.days && a.days > 3));
  const mode = actions.length > 1 || long ? 'plan' : 'act';
  return {
    mode: mode === 'plan' && actions.length === 1 && !long ? 'act' : mode, intent: t.slice(0, 200), actions, plan_title: mode === 'plan' ? t.slice(0, 100) : null,
    risks: long ? ['Living costs (food and lodging) accrue every day.', 'The world keeps moving while you are occupied.'] : [],
    question: unparsed.length ? `I did not understand: "${unparsed.join('; ').slice(0, 150)}".` : null, reason: null,
  };
}
