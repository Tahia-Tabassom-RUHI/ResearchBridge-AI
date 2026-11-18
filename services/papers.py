"""OpenAlex discovery. All displayed paper metadata comes from retrieved records."""
import json
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote, unquote, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

class DiscoveryError(Exception):
    pass


def provider_records(payload, convert, *path):
    """Parse a provider's result list without dropping valid sibling records."""
    for field in path:
        if not isinstance(payload,dict) or field not in payload:
            raise DiscoveryError('The provider returned an invalid search response.')
        payload=payload[field]
    if not isinstance(payload,list):
        raise DiscoveryError('The provider returned an invalid search response.')

    records=[]
    malformed=False
    for row in payload:
        if not isinstance(row,dict):
            malformed=True
            continue
        try:
            record=convert(row)
        except (AttributeError,IndexError,KeyError,TypeError,ValueError):
            malformed=True
            continue
        if record is None:
            continue
        if any(not isinstance(record.get(field),str) or not record[field].strip()
                for field in ('id','title')):
            malformed=True
            continue
        for field in ('keywords','topics'):
            values=record.get(field)
            if not isinstance(values,list):
                values=[]
            record[field]=[value for value in values if isinstance(value,str) and value.strip()]
        for field in ('abstract','source_name','paper_type'):
            if not isinstance(record.get(field),str):
                record[field]=None
        count=record.get('cited_by_count')
        if type(count) is not int or count<0:
            record['cited_by_count']=None
        records.append(record)
    if malformed and not records:
        raise DiscoveryError('The provider returned malformed paper records.')
    return records


def safe_url(value):
    return value if isinstance(value, str) and urlparse(value).scheme in ('http', 'https') and urlparse(value).netloc else None

def doi_url(value):
    """Validate DOI syntax and canonicalize resolver URLs and bare identifiers."""
    if not isinstance(value, str):
        return None
    value=value.strip()
    if value.lower().startswith('doi:'):
        value=value[4:].strip()
    elif value.lower().startswith(('http://','https://')):
        if not value.isprintable():
            return None
        try:
            url=urlparse(value)
            if url.netloc.lower() not in ('doi.org','dx.doi.org'):
                return None
            path=url.path+(';' + url.params if url.params else '')
            if re.search(r'%(?![0-9a-fA-F]{2})',path):
                return None
            value=unquote(path.removeprefix('/'),errors='strict')
        except ValueError:
            return None
    if (not re.fullmatch(r'10\.[0-9]{4,}(?:\.[0-9]+)*/\S+',value)
            or not value.isprintable() or any(part in ('.','..') for part in value.split('/'))):
        return None
    return 'https://doi.org/'+quote(value.lower(),safe='/():;._-')


def biomedical_ids(pmid=None,pmcid=None):
    identifiers=[]
    if isinstance(pmid,str):
        pmid=pmid.removeprefix('https://pubmed.ncbi.nlm.nih.gov/').rstrip('/')
    if isinstance(pmcid,str):
        pmcid=pmcid.removeprefix('https://www.ncbi.nlm.nih.gov/pmc/articles/')
        pmcid=pmcid.removeprefix('https://pmc.ncbi.nlm.nih.gov/articles/').rstrip('/')
    if isinstance(pmid,str) and re.fullmatch(r'[1-9][0-9]*',pmid):
        identifiers.append('pmid:'+pmid)
    if isinstance(pmcid,str) and re.fullmatch(r'PMC[1-9][0-9]*',pmcid):
        identifiers.append('pmcid:'+pmcid)
    return identifiers


def is_retracted_or_notice(paper):
    return (paper.get('is_retracted') is True
        or paper.get('paper_type') in ('retraction','retraction-notice'))


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
    doi = doi_url(work.get('doi'))
    ids = work.get('ids') or {}
    identifiers = biomedical_ids(ids.get('pmid'),ids.get('pmcid'))
    return dict(id=work['id'], title=work['title'],
        authors=[a['author']['display_name'] for a in work.get('authorships', []) if (a.get('author') or {}).get('display_name')],
        doi=doi, publication_date=work.get('publication_date'), source_name=source.get('display_name'),
        abstract=abstract_text(work.get('abstract_inverted_index')),
        paper_url=doi or safe_url(location.get('landing_page_url')) or safe_url(work['id']),
        oa_url=safe_url(oa.get('oa_url')), paper_type=work.get('type'), is_retracted=work.get('is_retracted'),
        retrieved_at=datetime.now(timezone.utc).isoformat(), provenance={'source': 'OpenAlex'},
        author_details=[{'id': (a.get('author') or {}).get('id'), 'name': (a.get('author') or {}).get('display_name'), 'institutions': [{'id': inst.get('id'), 'name': inst.get('display_name'), 'country_code':inst.get('country_code')} for inst in a.get('institutions', []) if inst.get('display_name')]} for a in work.get('authorships', []) if (a.get('author') or {}).get('display_name')],
        cited_by_count=work.get('cited_by_count'), is_oa=oa.get('is_oa'), identifiers=identifiers,
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
    return provider_records(payload,normalize,'results')


def search_papers(query, year=None, api_key=None, extra_queries=()):
    """Search public sources; OpenAlex supplements them only when configured."""
    from services.scholarly import discover
    return discover(query, year, api_key, extra_queries)
