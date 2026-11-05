// Local inference via node-llama-cpp (bundled llama.cpp binaries; no external server).
// Output is constrained by a JSON-schema grammar so the model can only emit
// well-formed JSON of the expected shape.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const MODEL_PROFILES = [
  { id: 'light', label: 'Light (≈1.3 GB, 8 GB RAM)', file: 'Qwen3.5-2B-Q4_K_M.gguf', contextSize: 6144, note: 'Fastest; weaker at complex plans.' },
  { id: 'standard', label: 'Standard (≈2.5 GB, 8–16 GB RAM)', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', contextSize: 8192, note: 'Recommended balance of reliability and speed.' },
  { id: 'high', label: 'High (≈5.7 GB, GPU or 16 GB+ RAM)', file: 'Qwen3.5-9B-Q4_K_M.gguf', contextSize: 8192, note: 'Best narration; needs a capable GPU for comfortable speed.' },
];

export function modelSearchDirs(extra = []) {
  const dirs = [...extra];
  if (process.env.SATURN_MODELS) dirs.push(process.env.SATURN_MODELS);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'models'));
  dirs.push(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../models'));
  dirs.push(path.join(os.homedir(), '.saturn', 'models'));
  return [...new Set(dirs)];
}

export function findModels(extraDirs = []) {
  const found = [];
  for (const d of modelSearchDirs(extraDirs)) {
    try {
      for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.gguf')) found.push({ file: f, path: path.join(d, f), size: fs.statSync(path.join(d, f)).size, profile: MODEL_PROFILES.find((p) => p.file === f)?.id || null });
    } catch { /* missing dir */ }
  }
  return found;
}

export class LocalLLM {
  constructor({ modelPath, contextSize = 8192, gpu = 'auto', threads = undefined, log = () => {} } = {}) {
    this.modelPath = modelPath;
    this.contextSize = contextSize;
    this.gpu = gpu;
    this.threads = threads;
    this.log = log;
    this.state = 'unloaded';
    this.error = null;
    this._grammars = new Map();
    this._queue = Promise.resolve();
    this.stats = { calls: 0, failures: 0, totalMs: 0, tokens: 0 };
  }

  async load(onProgress) {
    if (this.state === 'ready') return;
    this.state = 'loading';
    try {
      const { getLlama, LlamaChatSession, resolveChatWrapper } = await import('node-llama-cpp');
      this._LlamaChatSession = LlamaChatSession;
      this.llama = await getLlama({ gpu: this.gpu === 'cpu' ? false : this.gpu, logLevel: 'error', build: 'never' });
      this.model = await this.llama.loadModel({ modelPath: this.modelPath, onLoadProgress: onProgress });
      this.context = await this.model.createContext({ contextSize: Math.min(this.contextSize, this.model.trainContextSize || this.contextSize), threads: this.threads, flashAttention: true });
      this.sequence = this.context.getSequence();
      // Discourage hidden "thinking" so the grammar-constrained answer starts immediately.
      const chatWrapper = resolveChatWrapper(this.model, { customWrapperSettings: { qwen: { thoughts: 'discourage' } } });
      this.session = new LlamaChatSession({ contextSequence: this.sequence, chatWrapper });
      this.state = 'ready';
      this.info = { model: path.basename(this.modelPath), gpu: this.llama.gpu || 'cpu', contextSize: this.context.contextSize, wrapper: this.session.chatWrapper.wrapperName };
      this.log(`model ready: ${JSON.stringify(this.info)}`);
    } catch (e) {
      this.state = 'error';
      this.error = String(e.message || e);
      throw e;
    }
  }

  async grammar(schema) {
    const key = JSON.stringify(schema);
    if (!this._grammars.has(key)) this._grammars.set(key, await this.llama.createGrammarForJsonSchema(schema));
    return this._grammars.get(key);
  }

  /**
   * Generate schema-constrained JSON. Calls are serialised (one sequence).
   * Returns {parsed, text, ms, tokens}. Throws on timeout/abort/parse failure.
   */
  generateJson(opts) {
    const run = () => this._generate(opts);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _generate({ system, user, schema, maxTokens = 400, temperature = 0.3, timeoutMs = 90000, signal, onToken, seed }) {
    if (this.state !== 'ready') throw new Error(`model not ready (${this.state})`);
    const grammar = await this.grammar(schema);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ac.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort);
    const t0 = Date.now();
    let tokens = 0;
    this.stats.calls++;
    try {
      this.session.setChatHistory([{ type: 'system', text: system }]);
      const text = await this.session.prompt(user, {
        grammar, maxTokens, temperature, topP: 0.9, seed, signal: ac.signal, stopOnAbortSignal: false,
        onToken: (t) => { tokens += Array.isArray(t) ? t.length : 1; onToken?.(tokens); },
      });
      let parsed;
      try { parsed = grammar.parse(text); } catch (e) {
        // tolerate stray leading/trailing characters around a single JSON object
        const a = text.indexOf('{'), b = text.lastIndexOf('}');
        if (a < 0 || b <= a) throw e;
        parsed = JSON.parse(text.slice(a, b + 1));
      }
      const ms = Date.now() - t0;
      this.stats.totalMs += ms;
      this.stats.tokens += tokens;
      return { parsed, text, ms, tokens };
    } catch (e) {
      this.stats.failures++;
      if (ac.signal.aborted) throw new Error(String(ac.signal.reason?.message || 'aborted'));
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async dispose() {
    try { await this.context?.dispose(); await this.model?.dispose(); } catch { /* ignore */ }
    this.state = 'unloaded';
  }
}
