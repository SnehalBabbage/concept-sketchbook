// App configuration. The model list is configuration, not code (OR-03):
// edit DEFAULT_MODELS here, or override it per browser in Settings.

export const APP_TITLE = 'Concept Sketchbook';

// Free models first; the openrouter/free router picks any available free model
// that supports the parameters we send. A paid model may be appended as a last fallback.
export const DEFAULT_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];

export const OPENROUTER = {
  chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
  modelsUrl: 'https://openrouter.ai/api/v1/models',
  authUrl: 'https://openrouter.ai/auth',
  keyExchangeUrl: 'https://openrouter.ai/api/v1/auth/keys',
};

// Free tier: 50 requests/day (1,000/day after buying $10 of credits). Re-check before release.
export const DEFAULT_DAILY_CAP = 50;
export const MAX_CALLS_PER_GRAPH = 8;
export const RATE_LIMIT_WAIT_MS = 6000;
export const REQUEST_TIMEOUT_MS = 90000;

export const TOPIC_MAX = 200;
export const MIN_CONCEPTS = 14;
export const MAX_CONCEPTS = 30;
export const MAX_EXPLANATION = 300;
export const DETAIL_BATCH = 10;

export const RELATIONS = [
  'needs',
  'part of',
  'special case of',
  'implies',
  'contrasts with',
  'example of',
  'related to',
];

// Look-up links are built here from model-suggested search phrases (FR-09).
export const SEARCH_SITES = [
  { label: 'Encyclopedia', url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  { label: 'Scholar', url: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}` },
  { label: 'YouTube', url: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  { label: 'Khan Academy', url: (q) => `https://www.khanacademy.org/search?page_search_query=${encodeURIComponent(q)}` },
];
