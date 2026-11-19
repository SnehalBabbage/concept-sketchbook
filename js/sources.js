// Real references for a concept, looked up in open catalogues: Wikipedia for articles and
// OpenAlex or Crossref for scholarly papers (each with a DOI). The model never supplies these, so every
// item is a record that exists; whether it is relevant is for the learner to judge.

const WIKI = (q) => `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&srprop=snippet&format=json&origin=*`;
const ALEX = (q) => `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=has_doi:true,cited_by_count:%3E5&per-page=4&select=doi,display_name,publication_year,authorships,cited_by_count,primary_location`;

const CROSSREF = (q) => `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&filter=type:journal-article,has-abstract:true&rows=8&select=DOI,title,author,issued,container-title,is-referenced-by-count`;

// Only these hosts may appear as reference links, including in imported maps.
const ALLOWED = ['https://en.wikipedia.org/wiki/', 'https://doi.org/'];
export const isAllowedRef = (url) => typeof url === 'string' && ALLOWED.some((p) => url.startsWith(p));

const plain = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();

async function getJson(url, signal) {
  const res = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function articles(q, signal) {
  const data = await getJson(WIKI(q), signal);
  return (data?.query?.search || []).map((r) => ({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    note: plain(r.snippet).slice(0, 160),
  }));
}

async function openAlexPapers(q, signal) {
  const data = await getJson(ALEX(q), signal);
  if (data?.error || !Array.isArray(data?.results)) throw new Error(data?.error || 'OpenAlex error'); // its rate limit arrives as HTTP 200
  return data.results
    .filter((w) => w.doi && w.display_name)
    .map((w) => {
      const names = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
      const authors = names.length > 2 ? `${names[0]} et al.` : names.join(' & ');
      const venue = w.primary_location?.source?.display_name;
      return {
        title: plain(w.display_name),
        url: w.doi.startsWith('https://doi.org/') ? w.doi : `https://doi.org/${w.doi.replace(/^doi:/i, '')}`,
        note: [authors, w.publication_year, venue, `cited by ${w.cited_by_count}`].filter(Boolean).join(' · '),
      };
    });
}

async function crossrefPapers(q, signal) {
  const data = await getJson(CROSSREF(q), signal);
  return (data?.message?.items || [])
    .filter((w) => w.DOI && w.title?.[0] && (w['is-referenced-by-count'] || 0) > 5)
    .slice(0, 4)
    .map((w) => {
      const names = (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
      const authors = names.length > 2 ? `${names[0]} et al.` : names.join(' & ');
      const year = w.issued?.['date-parts']?.[0]?.[0];
      return {
        title: plain(w.title[0]),
        url: `https://doi.org/${w.DOI}`,
        note: [authors, year, w['container-title']?.[0], `cited by ${w['is-referenced-by-count']}`].filter(Boolean).join(' · '),
      };
    });
}

// OpenAlex ranks better, but rate-limits anonymous search under load; Crossref is the fallback.
async function papers(q, signal) {
  try {
    const items = await openAlexPapers(q, signal);
    if (items.length) return { items, via: 'OpenAlex' };
  } catch { /* fall through to Crossref */ }
  return { items: await crossrefPapers(q, signal), via: 'Crossref' };
}

// Look up references for one concept. Each catalogue may fail on its own.
export async function findReferences(concept, topic, signal) {
  const q = concept.phrases?.[0] || concept.name;
  const scholarly = `${concept.name} ${topic}`.slice(0, 200);
  const [a, p] = await Promise.allSettled([articles(q, signal), papers(scholarly, signal)]);
  if (a.status === 'rejected' && p.status === 'rejected') throw new Error('Could not reach the paper and article catalogues.');
  return {
    articles: a.status === 'fulfilled' ? a.value : [],
    papers: p.status === 'fulfilled' ? p.value.items : [],
    papersVia: p.status === 'fulfilled' ? p.value.via : '',
    failed: [a.status === 'rejected' && 'articles', p.status === 'rejected' && 'papers'].filter(Boolean),
    at: Date.now(),
  };
}

export function sanitizeRefs(refs) {
  if (!refs || typeof refs !== 'object') return null;
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((r) => isAllowedRef(r?.url))
    .slice(0, 6)
    .map((r) => ({ title: String(r.title || '').slice(0, 300), url: r.url, note: String(r.note || '').slice(0, 300) }));
  return {
    articles: clean(refs.articles),
    papers: clean(refs.papers),
    papersVia: ['OpenAlex', 'Crossref'].includes(refs.papersVia) ? refs.papersVia : '',
    failed: [],
    at: Number(refs.at) || Date.now(),
  };
}
