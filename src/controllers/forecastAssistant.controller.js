import pool from '../config/db.js';
import { cacheEnabled, cacheGet, cacheSet } from '../config/cache.js';
import { getFinanceForecast } from '../graphql/services/forecast.service.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free';
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 24;
const userWindows = new Map();

const clampInteger = (value, fallback, min, max) => {
  const number = Number.parseInt(value, 10);
  return Math.min(Math.max(Number.isFinite(number) ? number : fallback, min), max);
};

const round = (value) => Math.round(Number(value) || 0);

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

const parseCashAmount = (text) => {
  const input = String(text || '');
  const scaled = input.match(/(?:₹|rs\.?|inr)?\s*([\d,.]+)\s*(crores?|cr|करोड़|lakhs?|lacs?|lac|lakh|million|mn)\b/i);
  if (scaled) {
    const numeric = Number(scaled[1].replaceAll(',', ''));
    const unit = scaled[2].toLowerCase();
    const multiplier = /crore|cr|करोड़/.test(unit) ? 1e7 : /lakh|lac/.test(unit) ? 1e5 : 1e6;
    const amount = numeric * multiplier;
    return Number.isFinite(amount) && amount >= 0 && amount <= 1e13 ? amount : null;
  }

  const rupees = input.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i);
  if (!rupees) return null;
  const amount = Number(rupees[1].replaceAll(',', ''));
  return Number.isFinite(amount) && amount >= 0 && amount <= 1e13 ? amount : null;
};

const buildActions = (question, forecast) => {
  const lower = question.toLowerCase();
  const amount = parseCashAmount(question);
  const wantsSimulation = /(what[ -]?if|if i have|suppose|simulate|scenario|possibilit|next month|cash position|cash flow)/i.test(question);
  const actions = [];

  if (wantsSimulation) {
    const openingCash = amount ?? (Number(forecast.currentBalance) || 0);
    const startMonthIndex = /next month/i.test(question) && forecast.forecast.length > 1 ? 1 : 0;
    actions.push({
      id: `cash-scenario-${Math.round(openingCash)}`,
      type: 'OPEN_CASH_SCENARIO',
      label: amount ? `Explore ${formatINR(openingCash)} possibilities` : 'Open interactive scenario lab',
      description: 'Compare conservative, base and optimistic month-by-month outcomes.',
      payload: { openingCash: round(openingCash), startMonthIndex },
    });
  }

  const scenario = ['conservative', 'optimistic', 'base'].find((name) => lower.includes(name));
  if (scenario) {
    actions.push({
      id: `apply-${scenario}`,
      type: 'APPLY_SCENARIO',
      label: `Apply ${scenario} view to page`,
      description: 'Updates the main forecast chart and monthly table.',
      payload: { scenario },
    });
  }

  return actions.slice(0, 2);
};

const buildWhatIf = (forecast, openingCash, startMonthIndex = 0) => {
  if (!Number.isFinite(Number(openingCash))) return null;
  const fields = {
    conservative: 'conservativeNet',
    base: 'net',
    optimistic: 'optimisticNet',
  };
  return Object.fromEntries(Object.entries(fields).map(([scenario, field]) => {
    let balance = Number(openingCash);
    let lowestBalance = balance;
    const months = forecast.forecast.slice(startMonthIndex).map((month) => {
      balance += Number(month[field]) || 0;
      lowestBalance = Math.min(lowestBalance, balance);
      return { label: month.label, closingCash: round(balance) };
    });
    return [scenario, { endingCash: round(balance), lowestBalance: round(lowestBalance), months }];
  }));
};

const buildScenarioDigest = (forecast, openingCash) => {
  const startingCash = Number.isFinite(Number(openingCash))
    ? Number(openingCash)
    : Number(forecast.currentBalance) || 0;
  const fields = {
    conservative: 'conservativeNet',
    base: 'net',
    optimistic: 'optimisticNet',
  };

  return Object.fromEntries(Object.entries(fields).map(([scenario, field]) => {
    let closingCash = startingCash;
    let lowestCash = startingCash;
    let lowestMonth = null;
    let firstDeficitMonth = null;
    let strongestMonth = null;
    let weakestMonth = null;

    forecast.forecast.forEach((month) => {
      const movement = Number(month[field]) || 0;
      closingCash += movement;
      if (closingCash < lowestCash) {
        lowestCash = closingCash;
        lowestMonth = month.label;
      }
      if (closingCash < 0 && !firstDeficitMonth) firstDeficitMonth = month.label;
      if (!strongestMonth || movement > strongestMonth.netMovement) {
        strongestMonth = { label: month.label, netMovement: round(movement) };
      }
      if (!weakestMonth || movement < weakestMonth.netMovement) {
        weakestMonth = { label: month.label, netMovement: round(movement) };
      }
    });

    return [scenario, {
      startingCash: round(startingCash),
      endingCash: round(closingCash),
      totalMovement: round(closingCash - startingCash),
      lowestCash: round(lowestCash),
      lowestMonth,
      firstDeficitMonth,
      strongestMonth,
      weakestMonth,
    }];
  }));
};

const aggregateDues = (dueItems = []) => {
  const empty = () => ({ count: 0, amount: 0 });
  const result = {
    receivable: empty(),
    payable: empty(),
    overdueReceivable: empty(),
    overduePayable: empty(),
    upcomingReceivable: empty(),
    upcomingPayable: empty(),
  };

  dueItems.forEach((item) => {
    const type = item.type === 'RECEIVABLE' ? 'Receivable' : item.type === 'PAYABLE' ? 'Payable' : null;
    if (!type) return;
    const amount = Number(item.amount) || 0;
    const totalKey = type.toLowerCase();
    result[totalKey].count += 1;
    result[totalKey].amount += amount;

    if (item.status === 'OVERDUE') {
      const key = `overdue${type}`;
      result[key].count += 1;
      result[key].amount += amount;
    } else if (item.status === 'UPCOMING') {
      const key = `upcoming${type}`;
      result[key].count += 1;
      result[key].amount += amount;
    }
  });

  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, {
    count: value.count,
    amount: round(value.amount),
  }]));
};

const compactForecastContext = (site, forecast, requestContext) => ({
  site: { id: site.id, name: site.name },
  generatedAt: forecast.generatedAt,
  selectedView: {
    scenario: requestContext.scenario,
    horizonMonths: requestContext.horizonMonths,
    lookbackMonths: requestContext.lookbackMonths,
    hypotheticalOpeningCash: requestContext.openingCash,
    hypotheticalStartMonthIndex: requestContext.startMonthIndex,
  },
  currentBalance: round(forecast.currentBalance),
  totals: forecast.totals,
  risk: forecast.risk,
  analytics: forecast.analytics,
  context: forecast.context,
  runRate: forecast.runRate,
  months: forecast.forecast.map((month, index) => ({
    key: month.key,
    label: month.label,
    period: index === 0 ? 'current_month_remaining' : 'future_month',
    base: { inflow: round(month.inflow), outflow: round(month.outflow), net: round(month.net) },
    conservative: {
      inflow: round(month.conservativeInflow), outflow: round(month.conservativeOutflow), net: round(month.conservativeNet),
    },
    optimistic: {
      inflow: round(month.optimisticInflow), outflow: round(month.optimisticOutflow), net: round(month.optimisticNet),
    },
    known: { receivable: round(month.scheduledInflow), payable: round(month.scheduledOutflow) },
  })),
  exposure: {
    receivableDueCount: forecast.dueItems.filter((item) => item.type === 'RECEIVABLE').length,
    payableDueCount: forecast.dueItems.filter((item) => item.type === 'PAYABLE').length,
    overdueCount: forecast.dueItems.filter((item) => item.status === 'OVERDUE').length,
  },
  dueSummary: aggregateDues(forecast.dueItems),
  decisionSignals: buildScenarioDigest(forecast, requestContext.openingCash),
  hypotheticalPossibilities: buildWhatIf(forecast, requestContext.openingCash, requestContext.startMonthIndex),
});

const buildSystemPrompt = (context) => `
You are "Forecast Copilot", a very fast financial decision-support assistant embedded inside an Indian SaaS ERP.

Answer only about the Finance Forecast page and the supplied site-level data. Be fast, decisive and numerically accurate.
- Reply in the language the user uses. Keep familiar finance labels in English when that is clearer.
- Start with the direct answer. Then give 2–4 short evidence bullets and one practical next step. Stay under 140 words unless the user explicitly requests detail.
- Use Indian currency notation (₹, lakh, crore) and always identify the scenario and forecast month used.
- Treat months[0] as the remaining current month. For "next month", use the first months entry marked future_month (normally months[1]).
- Prefer the supplied decisionSignals and hypotheticalPossibilities instead of doing fresh arithmetic. Opening cash is a starting position; monthly net movement is added to it.
- Distinguish actual cash, projected cash, known dues and unscheduled exposure.
- Never invent transactions, parties, dates or amounts. Say when the data does not support a conclusion.
- When confidence is below 70%, call out that uncertainty in one short phrase. Do not use confidence as a guarantee.
- Compare conservative, base and optimistic outcomes when the user asks a what-if, risk, possibility or decision question.
- Forecasts are decision support, not guaranteed collections.
- Do not output markdown tables, headings with #, JSON, or generic filler.
- Do not claim you changed the ERP. Interactive actions are rendered separately by the application.

Current page data (amounts are INR):
${JSON.stringify(context)}
`.trim();

const localFallbackAnswer = (question, forecast, openingCash) => {
  const asksNextMonth = /next month/.test(question.toLowerCase());
  const first = forecast.forecast[asksNextMonth && forecast.forecast.length > 1 ? 1 : 0];
  const starting = Number.isFinite(Number(openingCash)) ? Number(openingCash) : Number(forecast.currentBalance) || 0;
  if (!first) return 'There is not enough forecast data for this site yet. Add approved transaction history or known dues, then refresh the forecast.';

  const lower = question.toLowerCase();
  if (/(next month|what[ -]?if|if i have|scenario|cash position)/.test(lower)) {
    const baseClose = starting + Number(first.net || 0);
    const conservativeClose = starting + Number(first.conservativeNet || 0);
    const optimisticClose = starting + Number(first.optimisticNet || 0);
    return [
      `Using ${formatINR(starting)} as opening cash for ${first.label}:`,
      `• Conservative closing cash: ${formatINR(conservativeClose)}`,
      `• Base closing cash: ${formatINR(baseClose)}`,
      `• Optimistic closing cash: ${formatINR(optimisticClose)}`,
      `Recommendation: plan against the conservative value and treat stronger collections as upside.`,
    ].join('\n');
  }

  return [
    `The ${forecast.horizonMonths}-month base forecast shows ${formatINR(forecast.totals.base.net)} net movement.`,
    `• Current available cash: ${formatINR(forecast.currentBalance)}`,
    `• Expected inflow: ${formatINR(forecast.totals.base.inflow)}`,
    `• Expected outflow: ${formatINR(forecast.totals.base.outflow)}`,
    `• Cash risk: ${forecast.risk.level} (${forecast.analytics.confidenceScore}% model confidence)`,
  ].join('\n');
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
        // Ignore provider keep-alive or malformed partial lines; valid chunks continue streaming.
      }
    }
  }

  return { tokenCount, providerError };
};

export const streamForecastAssistant = async (req, res) => {
  const siteId = Number(req.body?.siteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid siteId is required' });
  }
  if (!enforceRateLimit(req.user.id)) {
    return res.status(429).json({ message: 'Please wait a moment before asking more questions.' });
  }

  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = rawMessages
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message?.content === 'string')
    .slice(-10)
    .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 2400) }))
    .filter((message) => message.content);
  const question = [...messages].reverse().find((message) => message.role === 'user')?.content;
  if (!question) return res.status(400).json({ message: 'A question is required' });

  const horizonMonths = clampInteger(req.body?.horizonMonths, 6, 1, 18);
  const lookbackMonths = clampInteger(req.body?.lookbackMonths, 12, 3, 24);
  const scenario = ['base', 'conservative', 'optimistic'].includes(req.body?.scenario) ? req.body.scenario : 'base';
  const requestedOpening = Number(req.body?.openingCash);
  const openingCash = Number.isFinite(requestedOpening) ? requestedOpening : null;
  const questionOpeningCash = parseCashAmount(question);
  const effectiveOpeningCash = questionOpeningCash ?? openingCash;
  const startMonthIndex = /next month/i.test(question) && horizonMonths > 1 ? 1 : 0;

  const { rows } = await pool.query('SELECT id, name FROM sites WHERE id = $1 LIMIT 1', [siteId]);
  const site = rows[0];
  if (!site) return res.status(404).json({ message: 'Site not found' });

  if (req.user.role === 'sub_admin') {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, siteId],
    );
    if (!access.rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }

  const cacheKey = `finance-forecast:${siteId}:${horizonMonths}:${lookbackMonths}`;
  let forecast = cacheEnabled() ? await cacheGet(cacheKey) : null;
  if (!forecast) {
    forecast = await getFinanceForecast(siteId, { horizonMonths, lookbackMonths });
    if (cacheEnabled()) await cacheSet(cacheKey, forecast, 55);
  }

  const context = compactForecastContext(site, forecast, {
    scenario, horizonMonths, lookbackMonths, openingCash: effectiveOpeningCash, startMonthIndex,
  });
  const actions = buildActions(question, forecast);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sendEvent(res, 'meta', {
    model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    provider: process.env.OPENROUTER_API_KEY ? 'openrouter' : 'local',
    generatedAt: forecast.generatedAt,
  });
  actions.forEach((action) => sendEvent(res, 'action', action));

  const fallback = () => {
    sendEvent(res, 'token', { token: localFallbackAnswer(question, forecast, effectiveOpeningCash) });
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
        'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'DG Account Forecast Copilot',
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        messages: [{ role: 'system', content: buildSystemPrompt(context) }, ...messages],
        temperature: 0.1,
        max_tokens: 520,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!openRouterResponse.ok || !openRouterResponse.body) {
      const errorText = await openRouterResponse.text().catch(() => '');
      console.error(`[ForecastCopilot] OpenRouter request failed with status ${openRouterResponse.status}${errorText ? `: ${errorText.slice(0, 280)}` : ''}`);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }

    const { tokenCount, providerError } = await relayOpenRouterStream(openRouterResponse, res);
    if (providerError && tokenCount === 0) {
      console.error(`[ForecastCopilot] OpenRouter stream failed: ${providerError}`);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }
    if (providerError) sendEvent(res, 'error', { message: 'The AI response was interrupted. Please try again for a complete answer.' });
    sendEvent(res, 'done', { ok: true, fallback: false, partial: Boolean(providerError) });
    return res.end();
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('[ForecastCopilot] stream failed:', error.message);
      fallback();
      sendEvent(res, 'done', { ok: true, fallback: true });
      return res.end();
    }
  }
};
