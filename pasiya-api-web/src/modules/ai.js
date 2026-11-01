// Free / low-cost AI endpoints through OFFICIAL provider APIs (no scraping of chat websites).
// Each model name tries a chain of providers and uses the first one that is configured and answers.
// Model ids change often, so every id can be overridden from wrangler.toml [vars] without touching the code.
import { HttpError, fetchT } from '../lib/util.js';

const chains = (env) => ({
  // Every model ends with the keyless Cloudflare Workers AI fallback, so the AI category works even with ZERO provider keys.
  gemini: [['gemini', env.MODEL_GEMINI || 'gemini-2.5-flash'], ['workers-ai', env.MODEL_GEMINI_FALLBACK_CF || '@cf/meta/llama-3.3-70b-instruct-fp8-fast']],
  gpt: [
    ['openrouter', env.MODEL_GPT_OPENROUTER || 'openai/gpt-oss-20b:free'],
    ['groq', env.MODEL_GPT_GROQ || 'openai/gpt-oss-20b'],
    ['workers-ai', env.MODEL_GPT_CF || '@cf/openai/gpt-oss-20b']
  ],
  deepseek: [
    ['deepseek', env.MODEL_DEEPSEEK || 'deepseek-chat'],
    ['openrouter', env.MODEL_DEEPSEEK_OPENROUTER || 'deepseek/deepseek-chat-v3.1:free'],
    ['workers-ai', env.MODEL_DEEPSEEK_CF || '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b']
  ],
  // There is no free Claude API. This needs an OpenRouter key with credits.
  claude: [['openrouter', env.MODEL_CLAUDE || 'anthropic/claude-haiku-4.5'], ['workers-ai', env.MODEL_CLAUDE_FALLBACK_CF || '@cf/meta/llama-3.3-70b-instruct-fp8-fast']],
  llama: [
    ['workers-ai', env.MODEL_LLAMA_CF || '@cf/meta/llama-3.1-8b-instruct'],
    ['groq', env.MODEL_LLAMA_GROQ || 'llama-3.1-8b-instant']
  ]
});
export const MODEL_NAMES = ['gemini', 'gpt', 'deepseek', 'claude', 'llama'];

const configured = (prov, env) => ({
  gemini: !!env.GEMINI_API_KEY, openrouter: !!env.OPENROUTER_API_KEY, groq: !!env.GROQ_API_KEY,
  deepseek: !!env.DEEPSEEK_API_KEY, 'workers-ai': !!env.AI
}[prov]);

async function openaiStyle(url, key, model, messages, max, extraHeaders = {}) {
  const r = await fetchT(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: max, temperature: 0.7 })
  }, 28000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
  const t = d.choices?.[0]?.message?.content;
  if (!t) throw new Error('empty answer');
  return t;
}

async function run(prov, model, messages, max, env) {
  if (prov === 'gemini') {
    const sys = messages.find((m) => m.role === 'system')?.content;
    const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
    const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: user }] }], ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}), generationConfig: { maxOutputTokens: max } })
    }, 28000);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error?.message || `HTTP ${r.status}`);
    const t = d.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('');
    if (!t) throw new Error('empty answer');
    return t;
  }
  if (prov === 'openrouter') return openaiStyle('https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_API_KEY, model, messages, max, { 'X-Title': 'PASIYA API' });
  if (prov === 'groq') return openaiStyle('https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, model, messages, max);
  if (prov === 'deepseek') return openaiStyle('https://api.deepseek.com/chat/completions', env.DEEPSEEK_API_KEY, model, messages, max);
  if (prov === 'workers-ai') {
    const d = await env.AI.run(model, { messages, max_tokens: max });
    const t = d?.response ?? d?.choices?.[0]?.message?.content ?? d?.output_text;
    if (!t) throw new Error('empty answer');
    return String(t);
  }
  throw new Error('unknown provider');
}

export function makeHandler(forced) {
  return async (p, env) => {
    const name = forced || String(p.model || 'gpt').toLowerCase();
    const prompt = String(p.prompt ?? p.q ?? p.text ?? '').trim();
    if (!prompt) throw new HttpError(400, 'prompt is required (example: ?prompt=Hello).');
    if (prompt.length > 4000) throw new HttpError(400, 'prompt is too long (max 4000 characters).');
    const chain = chains(env)[name];
    if (!chain) throw new HttpError(400, `Unknown model "${name}". Use: ${MODEL_NAMES.join(', ')}`);
    const usable = chain.filter(([prov]) => configured(prov, env));
    if (!usable.length) {
      const need = 'the [ai] binding in wrangler.toml (free, no key) or a provider key';
      throw new HttpError(503, `The "${name}" model is not enabled on this server. The owner must add ${need}.`);
    }
    const max = Math.min(Number(p.max_tokens) || 700, 1500);
    const messages = [
      ...(p.system ? [{ role: 'system', content: String(p.system).slice(0, 800) }] : []),
      { role: 'user', content: prompt }
    ];
    const tried = [];
    for (const [prov, model] of usable) {
      try {
        const answer = await run(prov, model, messages, max, env);
        return { model: name, provider: prov, modelId: model, answer: answer.trim() };
      } catch (e) { tried.push(`${prov}: ${e.message}`); }
    }
    throw new HttpError(502, 'All providers failed. ' + tried.join(' | '));
  };
}
