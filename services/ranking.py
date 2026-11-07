"""Editable query preparation and explicit interest ranking, never quality scoring."""
import re
from collections import Counter

STOP = set('a an the is are was were i we you my me how what why when where can could would should do does did to of in on for and or with that this it be have has long about want know there things world like'.split())

def query_from_question(question):
    words = re.findall(r"[\w-]+", question.lower())
    return ' '.join(w for w in words if w not in STOP)[:300] or question.strip()[:300]

def suggest_directions(papers, limit=6):
    counts = Counter()
    for paper in papers:
        counts.update(set(paper.get('keywords', []) + paper.get('topics', [])))
    generic = {'humans','human','male','female','adult','aged','middle aged','young adult','animals','adolescent','child','comparative study','article'}
    return [term for term, count in counts.most_common() if term.casefold() not in generic][:limit]

def matches(paper, term):
    text = ' '.join([paper['title'], paper.get('abstract') or '', *paper.get('keywords', []), *paper.get('topics', [])]).casefold()
    return term.casefold() in text

def rank_papers(papers, weights, mode='Best matches'):
    # Retracted records remain visible under Sources, never recommended.
    eligible = [p for p in papers if p.get('is_retracted') is not True]
    def score(paper):
        focus = sum(weight for term, weight in weights.items() if matches(paper, term))
        if mode == 'Recent research':
            return (focus, paper.get('publication_date') or '')
        if mode == 'Start here':
            return (focus, paper.get('paper_type') == 'review', bool(paper.get('abstract')))
        return (focus,)
    return sorted(eligible, key=score, reverse=True)

# Small, explicit starter maps, not a claim of general AI understanding.
STARTERS = [
    ({'smoothie', 'fridge', 'refrigerator'}, [
        ('Microbial growth', 'How microorganisms multiply in food; one possible angle on spoilage.', 'food spoilage refrigeration'),
        ('Storage temperature', 'How temperature affects changes during storage.', 'food storage temperature'),
        ('Oxidation', 'Chemical changes involving oxidation, which can affect colour and flavour.', 'fruit juice oxidation'),
        ('Shelf life', 'How researchers assess changes in a product over time.', 'fruit smoothie shelf life')]),
    ({'plant', 'plants'}, [
        ('Plant disease detection', 'Ways to identify signs of disease in plants.', 'plant disease detection'),
        ('Smartphone imaging', 'Using images captured by phones as research data.', 'plant disease smartphone imaging'),
        ('Low-cost monitoring', 'Approaches designed around inexpensive equipment.', 'plant health low cost monitoring')]),
    ({'forget', 'studied', 'remember', 'studying'}, [
        ('Memory retention', 'How information is maintained over time.', 'learning memory retention'),
        ('Retrieval practice', 'Practising bringing information to mind.', 'retrieval practice learning'),
        ('Spaced learning', 'Studying across separated sessions.', 'spaced learning memory')]),
]

def starter_directions(question):
    tokens = set(re.findall(r'\w+', question.lower()))
    for triggers, directions in STARTERS:
        if tokens & triggers:
            return directions
    return []


def relevance_details(paper, query):
    """Show inspectable word matching rather than an opaque quality score."""
    words = list(dict.fromkeys(w for w in re.findall(r'[\w-]+', query.lower()) if w not in STOP and len(w)>2))
    title = paper['title'].casefold()
    body = ' '.join([paper.get('abstract') or '', *paper.get('keywords',[]), *paper.get('topics',[])]).casefold()
    hits = [w for w in words if w in title or w in body]
    score = sum(2 if w in title else 1 for w in hits) / max(2*len(words),1)
    return score, hits


def shortlist(papers, query, weights, goal='Help me start'):
    eligible = [p for p in papers if p.get('is_retracted') is not True and p.get('paper_type') not in ('retraction','retraction-notice')]
    def score(p):
        relevance,_ = relevance_details(p,query)
        focus = sum(w for term,w in weights.items() if matches(p,term)) / max(sum(weights.values()),1)
        baseline = relevance + .15*focus
        # A preprint can be useful but is not presented as reviewed publication.
        if p.get('paper_type') in ('preprint','posted-content'):
            baseline -= .06
        if goal in ('Help me start','Start here'):
            return (baseline + .08*bool(p.get('abstract')) + .05*(p.get('paper_type')=='review'), bool(p.get('abstract')))
        if goal == 'Recent research':
            return (round(baseline,1), p.get('publication_date') or '')
        if goal == 'Free to read':
            return (bool(p.get('oa_url')), baseline)
        return (baseline,)
    return sorted(eligible,key=score,reverse=True)
