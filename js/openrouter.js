// OpenRouter is the only model gateway. Everything goes through ask().
import { APP_TITLE, OPENROUTER, RATE_LIMIT_WAIT_MS, REQUEST_TIMEOUT_MS } from './config.js?v=32d83d848e';
import { addCall, callsToday, getPkce, setPkce } from './store.js?v=32d83d848e';

export class ApiError extends Error {
  // kind: key | cap | budget | rate | unavailable | invalid | aborted | failed
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ApiError('aborted', 'Cancelled.'));
    }, { once: true });
  });

function parseContent(content) {
  if (Array.isArray(content)) content = content.map((p) => p.text || '').join('');
  if (typeof content !== 'string') throw new ApiError('invalid', 'The model returned no text.');
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1];
  try {
    return JSON.parse(text);
  } catch {
    // Some models wrap JSON in prose; take the outermost object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
    }
    throw new ApiError('invalid', 'The reply was not valid JSON.');
  }
}

function classify(status, message) {
  const m = (message || '').toLowerCase();
  if (status === 401 || status === 403) return new ApiError('key', 'OpenRouter rejected the key. Check it in Settings.');
  if (status === 402) return new ApiError('key', 'This key has no credit left for this model. Add credit or use a free model.');
  if (status === 429) {
    if (m.includes('per-day') || m.includes('per day') || m.includes('daily')) {
      return new ApiError('cap', 'The free daily limit on this key is used up. Try again tomorrow, or add credits on OpenRouter.');
    }
    return new ApiError('rate', 'Rate limited.');
  }
  return new ApiError('unavailable', message || `Model unavailable (HTTP ${status}).`);
}

async function callModel({ key, model, schemaName, schema, messages, signal }) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  addCall();
  let res;
  try {
    res = await fetch(OPENROUTER.chatUrl, {
      method: 'POST',
      signal: timeout.signal,
      referrerPolicy: 'origin',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': APP_TITLE,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        provider: { require_parameters: true },
        plugins: [{ id: 'response-healing' }],
      }),
    });
  } catch {
    if (signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
    throw new ApiError('unavailable', timeout.signal.aborted ? 'The model took too long.' : 'Could not reach OpenRouter.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw classify(res.status, body?.error?.message);
  if (body?.error) throw classify(body.error.code || 500, body.error.message);

  const msg = body?.choices?.[0]?.message;
  if (msg?.refusal) throw new ApiError('invalid', `The model declined: ${msg.refusal}`);
  return { data: parseContent(msg?.content), model: body?.model || model };
}

/**
 * Ask the model chain for one structured JSON answer.
 * Per model: a 429 waits and retries once; an invalid answer is retried once with the
 * problems listed; an unavailable model is skipped at once. A key problem stops everything.
 * validate(data) returns a list of problems (empty when the answer passes the gates).
 */
export async function ask({ key, models, dailyCap, budget, schemaName, schema, messages, validate, acceptLast, signal, onStatus }) {
  if (!key) throw new ApiError('key', 'Add an OpenRouter key in Settings first.');
  let last = 'No models are configured.';
  let lastBad = null; // with acceptLast, the last answer that parsed but failed a gate

  for (const model of models) {
    let convo = messages;
    let rateRetried = false;
    let fixRetried = false;

    for (;;) {
      if (signal?.aborted) throw new ApiError('aborted', 'Cancelled.');
      if (callsToday() >= dailyCap) {
        throw new ApiError('cap', `Stopped before the daily cap (${dailyCap} calls today). Try again tomorrow or raise the cap in Settings if your key allows it.`);
      }
      if (budget.used >= budget.max) {
        if (acceptLast && lastBad) return lastBad;
        throw new ApiError('budget', `This map used its budget of ${budget.max} calls. Retry the failed stage later.`);
      }
      budget.used += 1;
      onStatus?.(`asking ${model}${rateRetried || fixRetried ? ' (retry)' : ''}`);

      try {
        const { data, model: usedModel } = await callModel({ key, model, schemaName, schema, messages: convo, signal });
        const problems = validate ? validate(data) : [];
        if (!problems.length) return { data, model: usedModel };
        last = `${model}: ${problems.slice(0, 3).join('; ')}`;
        lastBad = { data, model: usedModel, problems };
        if (fixRetried) break;
        fixRetried = true;
        convo = [
          ...messages,
          { role: 'assistant', content: JSON.stringify(data) },
          { role: 'user', content: `Your answer failed these checks:\n- ${problems.slice(0, 12).join('\n- ')}\nReturn the full corrected JSON only.` },
        ];
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.kind === 'aborted') throw err;
        if (['key', 'cap', 'budget'].includes(err.kind)) {
          if (acceptLast && lastBad && err.kind !== 'key') return lastBad;
          throw err;
        }
        last = `${model}: ${err.message}`;
        if (err.kind === 'rate' && !rateRetried) {
          rateRetried = true;
          onStatus?.(`rate limited on ${model}, waiting`);
          await sleep(RATE_LIMIT_WAIT_MS, signal);
          continue;
        }
        if (err.kind === 'invalid' && !fixRetried) {
          fixRetried = true;
          continue;
        }
        break; // unavailable, or second failure: next model
      }
    }
  }
  if (acceptLast && lastBad) return lastBad;
  throw new ApiError('failed', `Every model in the chain failed. Last problem: ${last}`);
}

// --- Free model discovery (no key needed) ---
export async function fetchFreeModels() {
  const res = await fetch(OPENROUTER.modelsUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  return data
    .filter((m) => m.id.endsWith(':free'))
    .filter((m) => (m.supported_parameters || []).some((p) => p === 'structured_outputs' || p === 'response_format'))
    .map((m) => m.id);
}

// --- Sign in with OpenRouter (OAuth PKCE, OR-02) ---
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  setPkce({ verifier });
  const callback = location.origin + location.pathname;
  location.assign(`${OPENROUTER.authUrl}?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`);
}

// Returns a key if this page load is the OAuth callback, otherwise null.
export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return null;
  history.replaceState(null, '', location.pathname); // keep the code out of the address bar
  const pkce = getPkce();
  setPkce(null);
  if (!pkce) throw new Error('Sign-in was started in another tab. Please try again.');
  const res = await fetch(OPENROUTER.keyExchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: pkce.verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter sign-in failed (HTTP ${res.status}).`);
  const { key } = await res.json();
  if (!key) throw new Error('OpenRouter sign-in returned no key.');
  return key;
}
