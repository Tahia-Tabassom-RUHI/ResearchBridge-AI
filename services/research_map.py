"""Descriptive research maps over retrieved records, not evidence-strength grades."""
from datetime import date, datetime
import re
from zoneinfo import ZoneInfo
from services.ranking import matches
from services.papers import doi_url, is_retracted_or_notice, safe_url
from services.ranking import STOP

VIEWS = {
    'Topic volume': 'Number of retrieved records carrying each topic or keyword. When sources omit those fields, repeated title words help reveal topics. Counts overlap and do not add up to the sample size.',
    'Authors': 'Number of retrieved records credited to each author. Stable IDs are preferred; identical names without IDs are grouped as unverified name matches. This is activity in this search sample, not expertise or reputation.',
    'Citation attention': 'Sum of source-reported citation counts for retrieved records carrying each topic. Provider coverage varies. Citations indicate attention, not agreement or correctness.',
    'Reviews': 'Retrieved records marked review, grouped by topic. Review status does not establish a systematic review, meta-analysis, or consensus.',
    'Recent activity': 'Records published in the last three calendar years (including this year), grouped by topic. This is a snapshot, not a measured growth rate.',
    'Free to read': 'Retrieved records with a reported open-access URL, grouped by topic. Access does not measure quality.',
    'Institutions': 'Number of retrieved records linked to each author-affiliated institution. Names without IDs are unverified matches. Collaborations can count for several institutions.',
    'Countries': 'Number of retrieved records with an explicit country in author affiliation metadata. Many sources omit countries; missing is unknown, not zero.',
    'Publication venues': 'Number of retrieved records by journal or source name. This is publication activity in the sample, not a quality or reputation score.',
    'Publication years': 'Retrieved records grouped by publication year. Search ranking and date filters affect this distribution; it is not the total publishing history of the field.',
}


def unique_papers(papers):
    seen = set()
    for paper in papers:
        doi = doi_url(paper.get('doi'))
        identity = ('doi',doi) if doi else ('record',paper['id'])
        if identity not in seen and not is_retracted_or_notice(paper):
            seen.add(identity)
            yield paper


def map_data(papers, view, topic=None, today=None):
    """Return traceable counts, exact contributing record IDs, and missing coverage."""
    current_year = (today or datetime.now(ZoneInfo('Asia/Kuala_Lumpur')).date()).year
    records = [p for p in unique_papers(papers) if not topic or matches(p, topic)]
    groups, missing = {}, 0
    def add(key, label, paper, value=1, url=None):
        group = groups.setdefault(key, dict(label=label, value=0, paper_ids=[], url=url))
        if paper['id'] not in group['paper_ids']:
            group['value'] += value
            group['paper_ids'].append(paper['id'])
    for paper in records:
        terms = sorted(set(paper.get('topics', []) + paper.get('keywords', [])))
        if not terms and view == 'Topic volume':
            generic = {'study', 'analysis', 'effect', 'effects', 'using', 'based',
                'method', 'methods', 'results', 'paper', 'review', 'performance',
                'approach', 'comparison', 'investigation', 'evaluation',
                'during', 'figure', 'figures', 'windy', 'algorithm', 'algorithms'}
            terms = sorted({word.title() for word in re.findall(r'[a-zA-Z]{5,}', paper.get('title') or '')
                if word.casefold() not in STOP and word.casefold() not in generic})
        if view == 'Authors':
            authors = paper.get('author_details') or []
            if not authors:
                missing += 1
            for index, author in enumerate(authors):
                # An exact-name group is useful for exploration but never verifies identity.
                key = author.get('id') or 'unverified-name:'+author['name'].strip().casefold()
                label = author['name'] + ('' if author.get('id') else ' (name match, unverified)')
                add(key, label, paper, url=safe_url(author.get('id')))
        elif view == 'Institutions':
            found = False
            for author in paper.get('author_details', []):
                for institution in author.get('institutions', []):
                    name=institution.get('name')
                    key = institution.get('id') or ('unverified-institution:'+name.strip().casefold() if name else None)
                    if key and name:
                        found = True
                        add(key, name+('' if institution.get('id') else ' (name match, unverified)'), paper,
                            url=safe_url(institution.get('id')))
            if not found:
                missing += 1
        elif view == 'Countries':
            countries={institution.get('country_code','').upper() for author in paper.get('author_details',[])
                for institution in author.get('institutions',[]) if institution.get('country_code')}
            if not countries:
                missing += 1
            for code in countries:
                add(code, code, paper)
        elif view == 'Publication venues':
            venue=(paper.get('source_name') or '').strip()
            if venue:
                add('venue:'+venue.casefold(), venue, paper)
            else:
                missing += 1
        elif view == 'Publication years':
            year = publication_year(paper)
            add(str(year) if year else 'unknown', str(year) if year else 'Year unknown', paper)
            missing += year is None
        else:
            if view == 'Reviews' and paper.get('paper_type') != 'review':
                missing += paper.get('paper_type') is None
                continue
            if view == 'Recent activity':
                year = publication_year(paper)
                if year is None:
                    missing += 1
                    continue
                if not current_year-2 <= year <= current_year:
                    continue
            if view == 'Free to read' and not paper.get('oa_url'):
                continue
            value = paper.get('cited_by_count') if view == 'Citation attention' else 1
            if value is None:
                missing += 1
                continue
            if not terms:
                missing += 1
            for term in terms:
                add(term, term, paper, value=value)
    ordered = sorted(groups.items(), key=lambda pair: (-pair[1]['value'], pair[1]['label'], pair[0]))
    return dict(groups=dict(ordered), records=records, missing=missing)


def publication_year(paper):
    try:
        year = int((paper.get('publication_date') or '')[:4])
        return year if 1000 <= year <= 9999 else None
    except ValueError:
        return None
