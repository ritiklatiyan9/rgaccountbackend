import asyncHandler from '../utils/asyncHandler.js';
import {
  getSiteDirectorOverview,
  getSiteDirectorPerson,
} from '../services/siteDirector.service.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 24;
const userWindows = new Map();

const formatINR = (value) => {
  const amount = Number(value) || 0;
  const absolute = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (absolute >= 1e7) return `${sign}₹${(absolute / 1e7).toFixed(2)} Cr`;
  if (absolute >= 1e5) return `${sign}₹${(absolute / 1e5).toFixed(2)} L`;
  return `${sign}₹${Math.round(absolute).toLocaleString('en-IN')}`;
};

const enforceRateLimit = (userId) => {
  const now = Date.now();
  const current = userWindows.get(userId);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    userWindows.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= RATE_LIMIT) return false;
  current.count += 1;
  return true;
};

export const getDirectorOverview = asyncHandler(async (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 100);
  const preset = String(req.query.preset || 'overall').trim().toLowerCase();
  const snapshot = await getSiteDirectorOverview(search, preset);
  res.json(snapshot);
});

export const getDirectorPerson = asyncHandler(async (req, res) => {
  const identityKey = String(req.query.identity || '').trim().slice(0, 180);
  if (!identityKey) return res.status(400).json({ message: 'identity is required' });
  const detail = await getSiteDirectorPerson(identityKey);
  if (!detail) return res.status(404).json({ message: 'Personal ledger not found' });
  res.json(detail);
});

const compactContext = (overview, personDetail) => ({
  generatedAt: overview.generatedAt,
  portfolio: {
    totals: overview.totals,
    sites: overview.sites.map((site) => ({
      name: site.name,
      status: site.status,
      cashBalance: site.cashBalance,
      bankBalance: site.bankBalance,
      totalBalance: site.totalBalance,
      imprestFloat: site.imprestFloat,
      monthInflow: site.monthInflow,
      monthOutflow: site.monthOutflow,
      transactionCount: site.transactionCount,
    })),
    last12Months: overview.trend,
  },
  selectedPerson: personDetail ? {
    person: personDetail.person,
    summary: personDetail.summary,
    sites: personDetail.sites,
    modules: personDetail.modules,
    trend: personDetail.trend.slice(-18),
    recentTransactions: personDetail.transactions.slice(0, 80).map((transaction) => ({
      date: transaction.date,
      site: transaction.siteName,
      module: transaction.moduleLabel,
      particular: transaction.particular,
      debit: transaction.debit,
      credit: transaction.credit,
      paymentMode: transaction.paymentMode,
    })),
  } : null,
});

const buildSystemPrompt = (context) => `
You are "Sites Director AI", a fast financial intelligence assistant inside DG Account.

Use only the supplied live portfolio and person-ledger data. Never invent a site,
transaction, person, date or amount.
- Answer in the user's language. Keep familiar accounting labels in English when clearer.
- Start with the direct answer, then give 2–5 concise evidence bullets and one practical action.
- Use Indian currency notation (₹, lakh, crore).
- Cash balance means cash book less outstanding imprest float. Total balance is cash plus bank.
- For a person, Debit/Given is money paid to them, Credit/Returned is money received back,
  and Pending is Given minus Returned. Positive Pending means the person owes us.
- Compare sites when the question asks where, highest, lowest, risk, concentration or performance.
- Separate portfolio balances from person-ledger balances.
- Mention that the result is based on recorded data when a decision depends on data completeness.
- Stay under 180 words unless the user explicitly asks for detail.
- Do not output JSON, markdown tables or generic disclaimers.

Live data (amounts are INR):
${JSON.stringify(context)}
`.trim();

const localFallbackAnswer = (question, overview, detail) => {
  const lower = String(question || '').toLowerCase();
  if (detail) {
    const summary = detail.summary;
    const largest = detail.sites[0];
    return [
      `${detail.person.name} has ${formatINR(summary.pending)} net pending across ${summary.siteCount} site${summary.siteCount === 1 ? '' : 's'}.`,
      `• Given: ${formatINR(summary.totalGiven)} · Returned: ${formatINR(summary.totalReturned)}`,
      `• Cash pending: ${formatINR(summary.cashPending)} · Bank pending: ${formatINR(summary.bankPending)}`,
      largest ? `• Highest site exposure: ${largest.name} at ${formatINR(largest.pending)}` : null,
      'Action: review the largest pending site and its latest transactions first.',
    ].filter(Boolean).join('\n');
  }

  const totals = overview.totals;
  const ranked = [...overview.sites].sort((a, b) => b.totalBalance - a.totalBalance);
  const top = ranked[0];
  const low = ranked[ranked.length - 1];
  if (/cash|bank|balance|site|portfolio|risk|highest|lowest/.test(lower)) {
    return [
      `The recorded all-site available balance is ${formatINR(totals.totalBalance)}.`,
      `• Cash in hand: ${formatINR(totals.cashBalance)}`,
      `• Bank balance: ${formatINR(totals.bankBalance)}`,
      `• Outstanding imprest float: ${formatINR(totals.imprestFloat)}`,
      top ? `• Highest site: ${top.name} at ${formatINR(top.totalBalance)}` : null,
      low && low.id !== top?.id ? `• Lowest site: ${low.name} at ${formatINR(low.totalBalance)}` : null,
    ].filter(Boolean).join('\n');
  }
  return `I can compare site balances, Cash vs Bank, monthly movement, or analyse a selected person's Personal Ledger across all sites.`;
};

const sendEvent = (res, event, data) => {
  if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const relayOpenRouterStream = async (response, res) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let providerError = null;

  while (true) {
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
          sendEvent(res, 'token', { token });
        }
      } catch {
        // Provider keep-alives and partial lines can be ignored safely.
      }
    }
  }

  return { tokenCount, providerError };
};

export const streamDirectorAssistant = asyncHandler(async (req, res) => {
  if (!enforceRateLimit(req.user.id)) {
    return res.status(429).json({ message: 'Please wait a moment before asking more questions.' });
  }

  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = rawMessages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
    .slice(-10)
    .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 2600) }))
    .filter((message) => message.content);
  const question = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (!question) return res.status(400).json({ message: 'A question is required' });

  const identityKey = String(req.body?.identityKey || '').trim().slice(0, 180);
  const [overview, personDetail] = await Promise.all([
    getSiteDirectorOverview(''),
    identityKey ? getSiteDirectorPerson(identityKey) : Promise.resolve(null),
  ]);
  const context = compactContext(overview, personDetail);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sendEvent(res, 'meta', {
    model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    provider: process.env.OPENROUTER_API_KEY ? 'openrouter' : 'local',
    generatedAt: overview.generatedAt,
  });

  const fallback = () => {
    sendEvent(res, 'token', { token: localFallbackAnswer(question, overview, personDetail) });
  };

  if (!process.env.OPENROUTER_API_KEY) {
    fallback();
    sendEvent(res, 'done', { ok: true, fallback: true });
    return res.end();
  }

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const openRouterResponse = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || `http://localhost:${process.env.PORT || 8000}`,
        'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'DG Account Sites Director AI',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        messages: [{ role: 'system', content: buildSystemPrompt(context) }, ...messages],
        temperature: 0.08,
        max_tokens: 650,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!openRouterResponse.ok || !openRouterResponse.body) {
      const errorText = await openRouterResponse.text().catch(() => '');
      console.error(`[SitesDirectorAI] upstream request failed with status ${openRouterResponse.status}${errorText ? `: ${errorText.slice(0, 280)}` : ''}`);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }

    const { tokenCount, providerError } = await relayOpenRouterStream(openRouterResponse, res);
    if (providerError && tokenCount === 0) {
      console.error(`[SitesDirectorAI] stream failed: ${providerError}`);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }
    if (providerError) sendEvent(res, 'error', { message: 'The AI response was interrupted. Please try again.' });
    sendEvent(res, 'done', { ok: true, fallback: false, partial: Boolean(providerError) });
    return res.end();
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('[SitesDirectorAI] request failed:', error.message);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }
  }
});
