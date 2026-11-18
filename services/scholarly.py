"""Bounded public scholarly searches; source records, never generated citations."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from html import unescape
import json
import re
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from services.papers import DiscoveryError, biomedical_ids, doi_url, safe_url


def clean(value):
    return re.sub(r'\s+', ' ', unescape(re.sub('<[^>]+>', ' ', value or ''))).strip() or None


def get_json(url):
    req = Request(url, headers={'User-Agent':'ResearchBridge-Hackathon/0.2', 'Accept':'application/json'})
    with urlopen(req, timeout=12) as response:
        return json.load(response)


def publication_date(value):
    """Keep a valid provider date at its original precision."""
    value = str(value)
    if not re.fullmatch(r'[0-9]{4}(?:-[0-9]{2}){0,2}',value):
        return None
    try:
        date.fromisoformat(value+{4:'-01-01',7:'-01',10:''}[len(value)])
    except ValueError:
        return None
    return value


def base_record(identifier, title, source):
    return dict(id=identifier, title=clean(title), authors=[], author_details=[], doi=None,
        abstract=None, publication_date=None, source_name=None, paper_url=None, oa_url=None,
        paper_type=None, is_retracted=None, cited_by_count=None, is_oa=None,
        topics=[], keywords=[], retrieved_at=datetime.now(timezone.utc).isoformat(),
        provenance={'source':source, 'sources':[source]})


def crossref_record(work):
    doi = doi_url(work.get('DOI'))
    title = clean((work.get('title') or [''])[0])
    if not doi or not title:
        return None
    paper = base_record(doi, title, 'Crossref')
    paper['doi'] = paper['paper_url'] = doi
    paper['abstract'] = clean(work.get('abstract'))
    for author in work.get('author') or []:
        name = clean(author.get('name') or ' '.join([author.get('given',''), author.get('family','')]))
        if not name:
            continue
        paper['authors'].append(name)
        paper['author_details'].append({'id':safe_url(author.get('ORCID')), 'name':name,
            'institutions':[{'id':None,'name':a.get('name'),'country_code':a.get('country')} for a in author.get('affiliation',[]) if a.get('name')]})
    for field in ('published', 'published-online', 'published-print'):
        parts = (work.get(field) or {}).get('date-parts') or []
        if parts and parts[0]:
            candidate = '-'.join(str(p).zfill(4 if i==0 else 2) for i,p in enumerate(parts[0][:3]))
            if published:=publication_date(candidate):
                paper['publication_date'] = published
                break
    paper['source_name'] = (work.get('container-title') or [None])[0]
    paper['paper_type'] = work.get('type')
    paper['keywords'] = work.get('subject') or []
    paper['cited_by_count'] = work.get('is-referenced-by-count')
    retractions = [update for update in work.get('update-to') or []
        if isinstance(update,dict) and str(update.get('type')).lower()=='retraction']
    if retractions:
        paper['paper_type'] = 'retraction-notice'
        paper['retraction_targets'] = [target for update in retractions
            if (target:=doi_url(update.get('DOI'))) and target!=doi]
    return paper


def europe_record(work):
    title = clean(work.get('title'))
    if not title or not work.get('id'):
        return None
    url = 'https://europepmc.org/article/'+quote(work.get('source','MED'))+'/'+quote(work['id'])
    paper = base_record(url, title, 'Europe PMC')
    paper['paper_url'] = url
    paper['doi'] = doi_url(work.get('doi'))
    paper['identifiers'] = biomedical_ids(
        work.get('pmid') or (work['id'] if work.get('source')=='MED' else None),
        work.get('pmcid') or (work['id'] if work.get('source')=='PMC' else None),
    )
    paper['abstract'] = clean(work.get('abstractText'))
    paper['publication_date'] = publication_date(work.get('firstPublicationDate')) or publication_date(work.get('pubYear'))
    paper['source_name'] = ((work.get('journalInfo') or {}).get('journal') or {}).get('title')
    types = {t.lower() for t in (work.get('pubTypeList') or {}).get('pubType') or []
        if isinstance(t,str)}
    if 'retraction of publication' in types:
        paper['paper_type'] = 'retraction-notice'
    elif work.get('source')=='PPR' or 'preprint' in types:
        paper['paper_type'] = 'preprint'
    elif types & {'review','systematic review','scoping review','meta-analysis'}:
        paper['paper_type'] = 'review'
    elif 'journal article' in types:
        paper['paper_type'] = 'article'
    if 'retracted publication' in types:
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


def _identifiers(paper):
    return [paper['id'],*paper.get('identifiers',[])]


def _merge_metadata(current,paper):
    provenance = current['provenance']
    fields = provenance.setdefault('field_sources',{})
    source = paper['provenance']
    provenance['sources'] = list(dict.fromkeys(provenance.get('sources',[provenance['source']])
        + source.get('sources',[source['source']])))

    def take(field):
        current[field] = paper[field]
        fields[field] = source.get('field_sources',{}).get(field,source['source'])

    for field in ('doi','abstract','oa_url','source_name','cited_by_count'):
        if current.get(field) in (None,'') and paper.get(field) not in (None,''):
            take(field)
    for field in ('is_oa','is_retracted'):
        if paper.get(field) is True or (current.get(field) is None and paper.get(field) is False):
            take(field)
    old_date,new_date = current.get('publication_date'),paper.get('publication_date')
    if new_date and (not old_date or new_date.startswith(old_date+'-')):
        take('publication_date')
    old_type,new_type = current.get('paper_type'),paper.get('paper_type')
    if new_type and (not old_type or new_type=='retraction-notice'
            or (old_type in ('article','journal-article') and new_type in ('review','preprint','posted-content'))):
        take('paper_type')
    if len(paper.get('authors') or [])>len(current.get('authors') or []):
        take('authors')
        take('author_details')
    elif current.get('authors')==paper.get('authors') and not current.get('author_details') and paper.get('author_details'):
        take('author_details')
    for field in ('topics','keywords','identifiers'):
        current[field] = sorted(set(current.get(field,[])+paper.get(field,[])))


def _identity_keys(records):
    linked = defaultdict(list)
    for index,(paper,_) in enumerate(records):
        for identifier in _identifiers(paper):
            linked[identifier].append(index)

    keys = {}
    for start in range(len(records)):
        if start in keys:
            continue
        # Resolve the whole identifier chain before deciding which DOI it implies.
        component = {start}
        pending = [start]
        while pending:
            paper,_ = records[pending.pop()]
            for identifier in _identifiers(paper):
                for index in linked.pop(identifier,()):
                    if index not in component:
                        component.add(index)
                        pending.append(index)

        dois = {records[index][1] for index in component if records[index][1]}
        if len(dois)>1:
            # Keep explicit DOIs and exact record IDs in an ambiguous cluster.
            for index in component:
                paper,doi = records[index]
                keys[index] = ('doi',doi) if doi else ('record',paper['id'])
        else:
            key = ('doi',next(iter(dois))) if dois else ('component',start)
            keys.update(dict.fromkeys(component,key))
    return keys


def merge_records(records):
    """Match canonical DOIs or shared, unambiguous provider identifiers."""
    records = [(paper,doi_url(paper.get('doi'))) for paper in records]
    keys = _identity_keys(records)
    merged,retractions = {},{}
    for index,(paper,doi) in enumerate(records):
        key = keys[index]
        record = {**paper,'doi':doi,'publication_date':publication_date(paper.get('publication_date'))}
        if key in merged:
            _merge_metadata(merged[key],record)
        else:
            provenance = paper['provenance']
            merged[key] = {**record,'provenance':{**provenance,
                'field_sources':dict(provenance.get('field_sources',{}))}}
        for target in paper.get('retraction_targets',[]):
            retractions[target] = paper['provenance']['source']

    for paper in merged.values():
        if paper['doi'] in retractions:
            paper['is_retracted'] = True
            paper['provenance']['field_sources']['is_retracted'] = retractions[paper['doi']]
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
