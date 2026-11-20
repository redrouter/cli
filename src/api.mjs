export const ORIGIN = 'https://redrouter.org';
export const DEFAULT_MODEL = 'red-cyber-1';

export async function request(path, { key, body, fetcher = fetch } = {}) {
  const response = await fetcher(`${ORIGIN}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const advice = { 401: 'Check REDROUTER_API_KEY at https://redrouter.org/keys.', 402: 'Check trial eligibility or add credits at https://redrouter.org/credits.', 429: 'Your request or spending limit was reached; check https://redrouter.org/settings.' };
    await response.body?.cancel();
    throw new Error(`RedRouter HTTP ${response.status}. ${advice[response.status] ?? 'See https://redrouter.org/docs/troubleshooting.'}`);
  }
  // The catalog and capped smoke generations are small; reject an unexpected response size.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error('RedRouter response exceeded 2 MB.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function catalog(options) {
  const data = await request('/api/catalog', options);
  if (!Array.isArray(data.models)) throw new Error('RedRouter returned an invalid catalog.');
  const models = data.models.filter(m => m.available && !m.early_access);
  for (const m of models) {
    if (typeof m.id !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(m.id) || typeof m.display_name !== 'string' || !Number.isSafeInteger(m.context_tokens) || !Number.isSafeInteger(m.max_output_tokens) || !m.pricing || !m.capabilities) throw new Error('RedRouter returned invalid model metadata.');
    for (const p of ['input_usd_per_mtok', 'output_usd_per_mtok', 'cached_input_usd_per_mtok']) {
      if (!Number.isFinite(Number(m.pricing[p])) || Number(m.pricing[p]) < 0) throw new Error('RedRouter returned invalid prices.');
    }
  }
  return models;
}

export async function probe(protocol, model, key, options = {}) {
  const prompt = 'Reply with the single word OK.';
  const messages = [{ role: 'user', content: prompt }];
  const paths = { chat: '/v1/chat/completions', messages: '/v1/messages', responses: '/v1/responses' };
  const body = protocol === 'responses'
    ? { model, input: prompt, max_output_tokens: 64, store: false, parallel_tool_calls: true }
    : { model, messages, max_tokens: 64, stream: false };
  const data = await request(paths[protocol], { ...options, key, body });
  const output = protocol === 'chat' ? data.choices?.[0]?.message?.content
    : protocol === 'messages' ? data.content?.filter(c => c.type === 'text').map(c => c.text).join('')
    : data.output?.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
  if (typeof output !== 'string' || !output.trim()) throw new Error(`${protocol} returned no text; setup test did not pass.`);
  return true;
}

export function piModel(m) {
  return {
    id: m.id, name: m.display_name, reasoning: false,
    input: m.capabilities.image_input ? ['text', 'image'] : ['text'],
    cost: { input: Number(m.pricing.input_usd_per_mtok), output: Number(m.pricing.output_usd_per_mtok), cacheRead: Number(m.pricing.cached_input_usd_per_mtok), cacheWrite: 0 },
    contextWindow: m.context_tokens, maxTokens: m.max_output_tokens,
    compat: { supportsStore: false },
  };
}

export function opencodeProvider(models) {
  return {
    npm: '@ai-sdk/openai-compatible', name: 'RedRouter', env: ['REDROUTER_API_KEY'],
    options: { baseURL: `${ORIGIN}/v1`, apiKey: '{env:REDROUTER_API_KEY}' },
    models: Object.fromEntries(models.map(m => [m.id, {
      name: m.display_name, tool_call: m.capabilities.tool_calling, reasoning: false,
      modalities: { input: m.capabilities.image_input ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context: m.context_tokens, output: Math.min(m.max_output_tokens, 8192) },
      cost: { input: Number(m.pricing.input_usd_per_mtok), output: Number(m.pricing.output_usd_per_mtok), cache_read: Number(m.pricing.cached_input_usd_per_mtok) },
    }])),
  };
}
