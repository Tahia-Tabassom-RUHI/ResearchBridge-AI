"""Optional beginner background reading from Wikipedia, labelled separately from research."""
from datetime import datetime, timezone
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
import json
import re


def _request(params):
    url='https://en.wikipedia.org/w/api.php?'+urlencode({'action':'query','format':'json',**params})
    request=Request(url,headers={'User-Agent':'ResearchBridgeAI/0.2 (hackathon learning app)', 'Accept':'application/json'})
    with urlopen(request,timeout=7) as response:
        return json.load(response)


def search_background_articles(query,limit=4):
    phrase=' '.join(re.findall(r'[\w-]+',query)[:9])
    if not phrase:
        return []
    query_words=set(re.findall(r'[\w-]+',phrase.casefold()))
    found=_request({'list':'search','srsearch':phrase,'srlimit':str(limit)}).get('query',{}).get('search',[])
    ids=[str(item['pageid']) for item in found if item.get('pageid')]
    if not ids:
        return []
    pages=_request({'prop':'extracts','exintro':'1','explaintext':'1','exchars':'900','pageids':'|'.join(ids)}).get('query',{}).get('pages',{})
    result=[]
    for item in found:
        page=pages.get(str(item.get('pageid')), {})
        title=page.get('title') or item.get('title')
        if not title:
            continue
        title_words=set(re.findall(r'[\w-]+',title.casefold()))
        if not (title_words<=query_words or len(title_words & query_words)>=2):
            continue
        url='https://en.wikipedia.org/wiki/'+quote(title.replace(' ','_'))
        result.append(dict(id=url,title=title,abstract=page.get('extract') or None,
            authors=[],author_details=[],doi=None,publication_date=None,source_name='Wikipedia',
            paper_url=url,oa_url=url,paper_type='Background article',is_retracted=False,
            cited_by_count=None,topics=[],keywords=[],retrieved_at=datetime.now(timezone.utc).isoformat(),
            provenance={'source':'Wikipedia','sources':['Wikipedia']}))
    return result


def article_full_text(title):
    pages=_request({'prop':'extracts','explaintext':'1','titles':title}).get('query',{}).get('pages',{})
    return next((page.get('extract') for page in pages.values() if page.get('extract')),None)
