"""Bounded public scholarly searches; source records, never generated citations."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html import unescape
import json
import re
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from services.papers import DiscoveryError, safe_url


def clean(value):
    return re.sub(r'\s+', ' ', unescape(re.sub('<[^>]+>', ' ', value or ''))).strip() or None


def get_json(url):
    req = Request(url, headers={'User-Agent':'ResearchBridge-Hackathon/0.2', 'Accept':'application/json'})
    with urlopen(req, timeout=12) as response:
        return json.load(response)


def base_record(identifier, title, source):
    return dict(id=identifier, title=clean(title), authors=[], author_details=[], doi=None,
        abstract=None, publication_date=None, source_name=None, paper_url=None, oa_url=None,
        paper_type=None, is_retracted=None, cited_by_count=None, is_oa=None,
        topics=[], keywords=[], retrieved_at=datetime.now(timezone.utc).isoformat(),
        provenance={'source':source, 'sources':[source]})


def crossref_record(work):
    doi = work.get('DOI')
    title = clean((work.get('title') or [''])[0])
    if not doi or not title:
        return None
    paper = base_record('https://doi.org/'+doi.lower(), title, 'Crossref')
    paper['doi'] = paper['paper_url'] = 'https://doi.org/'+quote(doi, safe='/():;._-')
    paper['abstract'] = clean(work.get('abstract'))
    for author in work.get('author', []):
        name = clean(author.get('name') or ' '.join([author.get('given',''), author.get('family','')]))
        if not name:
            continue
        paper['authors'].append(name)
        paper['author_details'].append({'id':safe_url(author.get('ORCID')), 'name':name,
            'institutions':[{'id':None,'name':a.get('name')} for a in author.get('affiliation',[]) if a.get('name')]})
    for field in ('published', 'published-online', 'published-print'):
        parts = (work.get(field) or {}).get('date-parts') or []
        if parts and parts[0]:
            paper['publication_date'] = '-'.join(str(p).zfill(4 if i==0 else 2) for i,p in enumerate(parts[0][:3]))
            break
    paper['source_name'] = (work.get('container-title') or [None])[0]
    paper['paper_type'] = work.get('type')
    paper['keywords'] = work.get('subject') or []
    paper['cited_by_count'] = work.get('is-referenced-by-count')
    # Crossref update relationships can identify retraction notices, not universal status.
    updates = work.get('update-to') or []
    if any(u.get('type') == 'retraction' for u in updates):
        paper['is_retracted'] = True
    return paper


def europe_record(work):
    title = clean(work.get('title'))
    if not title or not work.get('id'):
        return None
    url = 'https://europepmc.org/article/'+quote(work.get('source','MED'))+'/'+quote(work['id'])
    paper = base_record(url, title, 'Europe PMC')
    paper['paper_url'] = url
    if work.get('doi'):
        paper['doi'] = 'https://doi.org/'+quote(work['doi'], safe='/():;._-')
    paper['abstract'] = clean(work.get('abstractText'))
    paper['publication_date'] = work.get('firstPublicationDate') or work.get('pubYear')
    paper['source_name'] = ((work.get('journalInfo') or {}).get('journal') or {}).get('title')
    types = (work.get('pubTypeList') or {}).get('pubType') or []
    paper['paper_type'] = 'review' if any('review' in t.lower() for t in types) else ('preprint' if work.get('source') == 'PPR' else 'article')
    if any(t.lower() == 'retracted publication' for t in types):
        paper['is_retracted'] = True
    elif any('retraction of publication' in t.lower() for t in types):
        paper['is_retracted'] = True
    authors = (work.get('authorList') or {}).get('author') or []
    for author in authors:
        name = clean(author.get('fullName') or author.get('collectiveName'))
        if not name:
            continue
        aid = author.get('authorId') or {}
        author_url = 'https://orcid.org/'+aid['value'] if aid.get('type') == 'ORCID' and aid.get('value') else None
        paper['authors'].append(name)
        paper['author_details'].append({'id':author_url, 'name':name, 'institutions':[]})
    paper['cited_by_count'] = work.get('citedByCount')
    if work.get('isOpenAccess') in ('Y','N'):
        paper['is_oa'] = work['isOpenAccess'] == 'Y'
    if paper['is_oa'] and work.get('pmcid'):
        paper['oa_url'] = 'https://europepmc.org/articles/'+quote(work['pmcid'])
    paper['keywords'] = (work.get('keywordList') or {}).get('keyword') or []
    paper['topics'] = sorted({m['descriptorName'] for m in (work.get('meshHeadingList') or {}).get('meshHeading',[]) if m.get('descriptorName')})
    return paper


def search_crossref(query, year=None):
    params = {'query.bibliographic':query, 'rows':20}
    if year:
        params['filter'] = f'from-pub-date:{year}-01-01'
    data = get_json('https://api.crossref.org/works?'+urlencode(params))
    return [p for w in data.get('message',{}).get('items',[]) if (p:=crossref_record(w))]


def search_europe(query, year=None):
    # Convert user phrasing to literal words; do not allow injected API query syntax.
    words = re.findall(r'[\w-]+', query)[:22]
    search = ' AND '.join('"'+w+'"' for w in words)
    if year:
        search += f' AND FIRST_PDATE:[{int(year)}-01-01 TO 3000-12-31]'
    params = {'query':search, 'format':'json', 'resultType':'core', 'pageSize':20}
    data = get_json('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'+urlencode(params))
    return [p for w in data.get('resultList',{}).get('result',[]) if (p:=europe_record(w))]


def merge_records(records):
    """Merge duplicate DOIs, filling absent abstracts and retaining provenance."""
    merged = {}
    for paper in records:
        key = (paper.get('doi') or paper['id']).lower().rstrip('/')
        if key not in merged:
            merged[key] = dict(paper)
            continue
        current = merged[key]
        for field in ('abstract','oa_url','source_name','publication_date'):
            if not current.get(field) and paper.get(field):
                current[field] = paper[field]
        current['is_retracted'] = True if current.get('is_retracted') or paper.get('is_retracted') else None
        current['topics'] = sorted(set(current.get('topics',[])+paper.get('topics',[])))
        current['keywords'] = sorted(set(current.get('keywords',[])+paper.get('keywords',[])))
        sources = list(dict.fromkeys(current['provenance'].get('sources',[current['provenance']['source']])+paper['provenance'].get('sources',[paper['provenance']['source']])))
        current['provenance'] = {'source':current['provenance']['source'], 'sources':sources}
        if not current.get('author_details'):
            current['author_details'] = paper.get('author_details',[])
        if current.get('cited_by_count') is None:
            current['cited_by_count'] = paper.get('cited_by_count')
    return list(merged.values())


def discover(query, year=None, api_key=None, extra_queries=()):
    if not query.strip() or len(query)>500:
        raise DiscoveryError('Use a short search phrase, up to 500 characters.')
    phrases = list(dict.fromkeys([query.strip()]+[q.strip() for q in extra_queries if q.strip()]))[:2]
    results, notices, successful = [], [], []
    jobs = [(name, fn, q) for q in phrases for name,fn in [('Crossref',search_crossref),('Europe PMC',search_europe)]]
    if api_key:
        from services.papers import search_openalex
        jobs.append(('OpenAlex', lambda q,y: search_openalex(q,y,api_key),query))
    # Retrieve independently; an unavailable provider must not disable the others.
    with ThreadPoolExecutor(max_workers=5) as executor:
        pending = {executor.submit(fn,q,year):(name,index) for index,(name,fn,q) in enumerate(jobs)}
        by_job = {}
        for future in as_completed(pending):
            name,index = pending[future]
            try:
                by_job[index] = future.result()
                successful.append(name)
            except Exception:
                notices.append(f'{name} could not respond to one search; other available sources were kept.')
        for index in sorted(by_job):
            results.extend(by_job[index])
    if not successful:
        raise DiscoveryError('The paper services are temporarily unreachable. Try again, or load a saved real-paper search for rehearsal.')
    papers = merge_records(results)
    if year:
        papers = [p for p in papers if p.get('publication_date') and int(p['publication_date'][:4]) >= int(year)]
    for paper in papers:
        paper['search_notices'] = list(dict.fromkeys(notices))
        paper['search_sources'] = sorted(set(successful))
    return papers[:80]
