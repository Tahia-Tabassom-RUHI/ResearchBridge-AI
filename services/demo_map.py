"""Explicitly illustrative records for exploring the interface without API access."""
from datetime import datetime
from zoneinfo import ZoneInfo


def demo_papers():
    now = datetime.now(ZoneInfo('Asia/Kuala_Lumpur'))
    output = []
    for i in range(8):
        topics = ['Storage'] + (['Preservation'] if i < 5 else ['Food chemistry'])
        people = ['A'] + (['B'] if i % 2 == 0 else ['C'])
        output.append(dict(id=f'demo:record:{i}', title=f'Illustrative record {i+1} — {topics[-1]}',
            authors=[f'Demo researcher {person}' for person in people],
            author_details=[{'id':f'demo:author:{person}', 'name':f'Demo researcher {person}',
                'institutions':[{'id':f'demo:institution:{0 if person in ("A", "B") else 1}',
                'name':'Demo institution '+('One' if person in ('A','B') else 'Two')}]} for person in people],
            doi=None, abstract=None, paper_url=None, oa_url=None,
            publication_date=f'{now.year-(i%5)}-01-01', paper_type='review' if i%3==0 else 'article',
            is_retracted=False, cited_by_count=[42,18,10,6,3,2,0,None][i],
            retrieved_at=now.isoformat(), provenance={'source':'Illustrative interface demo'},
            source_name='Illustrative data — not a publication', topics=topics, keywords=[]))
    return output
