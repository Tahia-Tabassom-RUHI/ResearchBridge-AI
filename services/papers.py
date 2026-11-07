"""OpenAlex discovery. All displayed paper metadata comes from retrieved records."""
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

class DiscoveryError(Exception):
    pass

def safe_url(value):
    return value if isinstance(value, str) and urlparse(value).scheme in ('http', 'https') and urlparse(value).netloc else None

def abstract_text(index):
    if not isinstance(index, dict):
        return None
    words = {position: word for word, positions in index.items() if isinstance(positions, list)
             for position in positions if isinstance(position, int) and 0 <= position < 30000}
    return ' '.join(words[i] for i in sorted(words)) or None

def normalize(work):
    location = work.get('primary_location') or {}
    source = location.get('source') or {}
    oa = work.get('open_access') or {}
    return dict(id=work['id'], title=work['title'],
        authors=[a['author']['display_name'] for a in work.get('authorships', []) if (a.get('author') or {}).get('display_name')],
        doi=safe_url(work.get('doi')), publication_date=work.get('publication_date'), source_name=source.get('display_name'),
        abstract=abstract_text(work.get('abstract_inverted_index')),
        paper_url=safe_url(work.get('doi')) or safe_url(location.get('landing_page_url')) or safe_url(work['id']),
        oa_url=safe_url(oa.get('oa_url')), paper_type=work.get('type'), is_retracted=work.get('is_retracted'),
        retrieved_at=datetime.now(timezone.utc).isoformat(), provenance={'source': 'OpenAlex'},
        author_details=[{'id': (a.get('author') or {}).get('id'), 'name': (a.get('author') or {}).get('display_name'), 'institutions': [{'id': inst.get('id'), 'name': inst.get('display_name')} for inst in a.get('institutions', []) if inst.get('display_name')]} for a in work.get('authorships', []) if (a.get('author') or {}).get('display_name')],
        cited_by_count=work.get('cited_by_count'), is_oa=oa.get('is_oa'),
        keywords=[k['display_name'] for k in work.get('keywords', []) if k.get('display_name')],
        topics=[t['display_name'] for t in work.get('topics', []) if t.get('display_name')])

def search_openalex(query, year=None, api_key=None):
    if not query.strip() or len(query) > 500:
        raise DiscoveryError('Use a search phrase between 1 and 500 characters.')
    params = {'search': query.strip(), 'per_page': 30}
    key = api_key or os.getenv('OPENALEX_API_KEY')
    if key:
        params['api_key'] = key
    if year:
        params['filter'] = f'from_publication_date:{int(year)}-01-01'
    request = Request('https://api.openalex.org/works?' + urlencode(params), headers={'User-Agent': 'ResearchBridge/0.1'})
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except HTTPError as exc:
        message = 'OpenAlex requires an API key or has reached its usage limit. Add OPENALEX_API_KEY in Streamlit secrets.' if exc.code in (401, 403, 429) else 'The paper service could not complete this search. Try again shortly.'
        raise DiscoveryError(message) from None
    except (URLError, TimeoutError, ValueError):
        raise DiscoveryError('Could not reach the paper service. Your question and focus are still here; try again.') from None
    seen, papers = set(), []
    for work in payload.get('results', []):
        if not work.get('id') or not work.get('title'):
            continue
        key = (work.get('doi') or work['id']).lower().rstrip('/')
        if key not in seen:
            seen.add(key)
            papers.append(normalize(work))
    return papers


def search_papers(query, year=None, api_key=None, extra_queries=()):
    """Search public sources; OpenAlex supplements them only when configured."""
    from services.scholarly import discover
    return discover(query, year, api_key, extra_queries)
