"""Descriptive research maps over retrieved records, not evidence-strength grades."""
from datetime import date, datetime
from zoneinfo import ZoneInfo
from services.ranking import matches
from services.papers import safe_url

VIEWS = {
    'Topic volume': 'Number of retrieved records carrying each topic or keyword. Topics overlap; counts do not add up to the sample size.',
    'Authors': 'Number of retrieved records credited to each author. Authors are grouped by source identity (OpenAlex ID or ORCID, when available); this is activity in this sample, not a field-wide expertise ranking.',
    'Citation attention': 'Sum of OpenAlex citation counts for retrieved records carrying each topic. Citations indicate attention, not agreement or correctness. The same citing work can contribute more than once.',
    'Reviews': 'Retrieved records marked review, grouped by topic. Review status does not establish a systematic review, meta-analysis, or consensus.',
    'Recent activity': 'Records published in the last three calendar years (including this year), grouped by topic. This is a snapshot, not a measured growth rate.',
    'Free to read': 'Retrieved records with a reported open-access URL, grouped by topic. Access does not measure quality.',
    'Institutions': 'Number of retrieved records linked to each author-affiliated institution. Each institution is counted once per record; collaborations can count for several institutions.',
    'Publication years': 'Retrieved records grouped by publication year. Search ranking and date filters affect this distribution; it is not the total publishing history of the field.',
}


def unique_papers(papers):
    seen = set()
    for paper in papers:
        identity = (paper.get('doi') or paper['id']).lower().rstrip('/')
        if identity not in seen and paper.get('is_retracted') is not True:
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
        if view == 'Authors':
            authors = paper.get('author_details') or []
            if not authors:
                missing += 1
            for index, author in enumerate(authors):
                # Never merge people solely because their names are identical.
                key = author.get('id') or f"unresolved:{paper['id']}:{index}"
                label = author['name'] + ('' if author.get('id') else ' (unresolved identity)')
                add(key, label, paper, url=safe_url(author.get('id')))
        elif view == 'Institutions':
            found = False
            for author in paper.get('author_details', []):
                for institution in author.get('institutions', []):
                    key = institution.get('id')
                    if key:
                        found = True
                        add(key, institution['name'], paper, url=safe_url(key))
            if not found:
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
