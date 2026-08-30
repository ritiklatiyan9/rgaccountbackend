// Shared OpenRouter helper — lifted from dashboardAssistant.controller.js (upstream timeout,
// relay, never-fail fallback) and hardened for the analytics copilot:
//  - an ORDERED model list instead of the 'openrouter/free' auto-router (which can land on
//    moderation/code/reasoning-only models — a content-safety model once replied "User Safety: safe");
//  - automatic fallback to the next model when a request errors or the first ~200 chars of the
//    stream do not look like an answer;
//  - the live /models list (cached 24h) drops stale slugs so a renamed free model never 404s.
// ponytail: the 4 existing assistant controllers keep their private copies; migrating them is optional cleanup.

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const AUTO_ROUTER = 'openrouter/free';

// Preference order of free instruct/chat models (Aug 2026). Anything not in the live list is skipped.
const DEFAULT_MODELS = [
  'google/gemma-4-31b-it:free',
  'z-ai/glm-5.2:free',
  'minimax/minimax-m3:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
];
// Never route to these even if an env var lists them: not chat models.
const BLOCKED_MODEL_RE = /content-safety|guard|moderation|embed|rerank|-code|omni|note-preview/i;

const envList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

let liveModels = { ids: null, fetchedAt: 0 };
/** Set of model ids OpenRouter currently serves; null when the list could not be fetched. */
export const getLiveModelIds = async () => {
  if (liveModels.ids && Date.now() - liveModels.fetchedAt < 24 * 3600_000) return liveModels.ids;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    const ids = new Set((data?.data || []).map((m) => m.id));
    if (ids.size) liveModels = { ids, fetchedAt: Date.now() };
  } catch (error) {
    console.warn('[AI] could not refresh OpenRouter model list:', error.message);
  }
  return liveModels.ids;
};

/**
 * Ordered candidate models. OPENROUTER_ANALYTICS_MODEL may be a comma-separated list; OPENROUTER_MODEL
 * is appended when it is a real slug (the auto-router is only used as a last resort).
 */
export const resolveModels = async () => {
  const configured = [...envList(process.env.OPENROUTER_ANALYTICS_MODEL), ...envList(process.env.OPENROUTER_MODEL)]
    .filter((m) => m !== AUTO_ROUTER);
  let list = [...new Set([...configured, ...DEFAULT_MODELS])].filter((m) => !BLOCKED_MODEL_RE.test(m));
  const live = await getLiveModelIds();
  if (live) {
    const served = list.filter((m) => live.has(m));
    if (served.length) list = served;
  }
  return list.length ? list : [AUTO_ROUTER];
};

export const defaultModel = () => envList(process.env.OPENROUTER_ANALYTICS_MODEL)[0] || DEFAULT_MODELS[0];

export const aiProvider = () => (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'local');

export const cleanText = (value, maxLength = 180) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

export const sanitiseMessages = (raw, maxChars = 2600) => (Array.isArray(raw) ? raw : [])
  .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
  .slice(-10)
  .map((message) => ({ role: message.role, content: cleanText(message.content, maxChars) }))
  .filter((message) => message.content);

export const sendEvent = (res, event, data) => {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

export const startSse = (res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
};

const openRouterHeaders = (title) => ({
  Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.OPENROUTER_SITE_URL || `http://localhost:${process.env.PORT || 8000}`,
  'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || title,
});

/** True when the start of a reply reads like prose, not a classifier label / JSON / empty. */
export const looksLikeAnswer = (head, ended = false) => {
  const t = String(head || '').trim();
  if (!t) return !ended ? true : false;
  if (/^(user\s*safety|safety|unsafe|safe|harmful|category|label|classification|verdict)\b/i.test(t)) return false;
  // reasoning models sometimes stream their scratchpad as content ("We need to answer…", "The user asks…")
  if (/^(we need to|we should|i need to|i should|let me|let's|the user (asks|wants|is asking)|okay,|first,? i)/i.test(t)) return false;
  if (/^[{[]/.test(t) || /^<\|/.test(t)) return false;
  if (ended) return t.length >= 20 && /\s/.test(t);
  return true;
};

/** Reads an upstream SSE stream, forwarding tokens; `onToken(token)` may return false to stop early. */
export const relayOpenRouterStream = async (response, res, onToken) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let providerError = null;
  let stopped = false;

  while (!stopped) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.error?.message) {
          providerError = parsed.error.message;
          continue;
        }
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          tokenCount += 1;
          if (onToken) {
            if (onToken(token) === false) { stopped = true; break; }
          } else {
            sendEvent(res, 'token', { token });
          }
        }
      } catch {
        // Provider keep-alives and partial lines are safe to ignore.
      }
    }
  }
  if (stopped) reader.cancel().catch(() => {});
  return { tokenCount, providerError, stopped };
};

const HEAD_CHARS = 200;

/**
 * One streaming attempt against one model. Tokens are held back until HEAD_CHARS arrive (or the
 * stream ends) and validated; a rejected head aborts the attempt without anything reaching the client.
 * @returns {{status:'ok'|'rejected'|'empty'|'error'|'timeout'|'aborted', providerError?:string}}
 */
const streamOnce = async ({ res, model, systemPrompt, messages, temperature, maxTokens, timeoutMs, title, logTag, clientAbort }) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onClientClose = () => controller.abort();
  clientAbort.add(onClientClose);
  try {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: openRouterHeaders(title),
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature,
        max_tokens: maxTokens,
        stream: true,
        reasoning: { exclude: true },
      }),
      signal: controller.signal,
    });
    // ponytail: timeoutMs bounds time-to-first-byte only; a wall-clock abort mid-stream would cut a real answer.
    clearTimeout(timer);
    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      console.error(`${logTag} ${model} failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ''}`);
      return { status: 'error' };
    }

    let head = '';
    let released = false;
    let rejected = false;
    const { tokenCount, providerError } = await relayOpenRouterStream(response, res, (token) => {
      if (released) { sendEvent(res, 'token', { token }); return true; }
      head += token;
      if (head.length >= HEAD_CHARS) {
        if (!looksLikeAnswer(head)) { rejected = true; return false; }
        released = true;
        sendEvent(res, 'token', { token: head });
      }
      return true;
    });
    if (rejected) {
      console.error(`${logTag} ${model} rejected — reply did not look like an answer: ${cleanText(head, 80)}`);
      return { status: 'rejected' };
    }
    if (!released) {
      // Short reply: validate the whole thing before releasing it.
      if (!looksLikeAnswer(head, true)) {
        console.error(`${logTag} ${model} ${tokenCount ? 'rejected short reply' : 'returned no answer'}: ${cleanText(head, 80)}${providerError ? ` (${providerError})` : ''}`);
        return { status: tokenCount ? 'rejected' : 'empty', providerError };
      }
      sendEvent(res, 'token', { token: head });
    }
    return { status: 'ok', providerError };
  } catch (error) {
    if (error?.name === 'AbortError') return { status: timedOut ? 'timeout' : 'aborted' };
    console.error(`${logTag} ${model} request failed:`, error.message);
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
    clientAbort.delete(onClientClose);
  }
};

/**
 * Streams an OpenRouter chat completion into an ALREADY-STARTED SSE response, trying `models` in
 * order. `fallback` is a () => string producing the deterministic local answer.
 * Always ends `res`; never throws across the SSE boundary.
 */
export async function streamOpenRouterToSse({
  res,
  systemPrompt,
  messages,
  fallback,
  temperature = 0.08,
  maxTokens = 650,
  timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS) || 45_000,
  model,
  models,
  title = 'DG Accounts AI',
  logTag = '[AI]',
}) {
  const finish = (data) => { sendEvent(res, 'done', data); if (!res.writableEnded) res.end(); };
  const emitFallback = () => {
    let token = '';
    try { token = String(fallback?.() || ''); } catch (error) { console.error(`${logTag} fallback failed:`, error.message); }
    sendEvent(res, 'token', { token: token || 'Live data is loaded, but the assistant could not compose an answer. Please try again.' });
  };

  if (!process.env.OPENROUTER_API_KEY) {
    emitFallback();
    return finish({ ok: true, fallback: true });
  }

  const candidates = [...new Set([...(models || []), ...(model ? [model] : [])])];
  const list = candidates.length ? candidates : await resolveModels();
  const clientAbort = new Set();
  res.on('close', () => { if (!res.writableEnded) clientAbort.forEach((fn) => fn()); });

  let lastTimeout = false;
  for (const m of list) {
    const result = await streamOnce({ res, model: m, systemPrompt, messages, temperature, maxTokens, timeoutMs, title, logTag, clientAbort });
    if (result.status === 'ok') {
      if (result.providerError) sendEvent(res, 'error', { message: 'The AI response was interrupted. Please ask again for a complete answer.' });
      sendEvent(res, 'meta', { model: m });
      return finish({ ok: true, fallback: false, partial: Boolean(result.providerError), model: m });
    }
    if (result.status === 'aborted' || res.writableEnded) { if (!res.writableEnded) res.end(); return; }
    lastTimeout = result.status === 'timeout';
    console.warn(`${logTag} ${m}: ${result.status} — trying next model`);
  }
  emitFallback();
  return finish({ ok: true, fallback: true, timeout: lastTimeout });
}

export const parseLenientJson = (text) => {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
};

/**
 * Non-streaming JSON-mode completion trying `models` in order. Never throws: returns { json, model, error }.
 */
export async function completeJson({
  systemPrompt,
  userContent,
  timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS) || 45_000,
  maxTokens = 900,
  temperature = 0.2,
  model,
  models,
  title = 'DG Accounts AI',
}) {
  if (!process.env.OPENROUTER_API_KEY) return { json: null, model: model || defaultModel(), error: 'missing_api_key' };
  const candidates = [...new Set([...(models || []), ...(model ? [model] : [])])];
  const list = candidates.length ? candidates : await resolveModels();
  let lastError = 'no_models';
  for (const m of list) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: openRouterHeaders(title),
        signal: controller.signal,
        body: JSON.stringify({
          model: m,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          reasoning: { exclude: true },
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: typeof userContent === 'string' ? userContent : JSON.stringify(userContent) },
          ],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = data?.error?.message || `OpenRouter request failed (HTTP ${response.status})`;
        console.warn(`[AI] ${m}: ${lastError} — trying next model`);
        continue;
      }
      const json = parseLenientJson(data?.choices?.[0]?.message?.content);
      if (json) return { json, model: data?.model || m, error: null };
      lastError = data?.error?.message || 'unreadable_response';
      console.warn(`[AI] ${m}: ${lastError} — trying next model`);
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'request_failed');
      console.warn(`[AI] ${m}: ${lastError} — trying next model`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { json: null, model: list[0], error: lastError };
}
