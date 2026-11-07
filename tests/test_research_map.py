from datetime import date
from pathlib import Path
from unittest.mock import patch
from streamlit.testing.v1 import AppTest
from services.papers import normalize
from services.research_map import map_data, VIEWS


def record(identifier='W1', **changes):
    work = dict(id=f'https://openalex.org/{identifier}', title='Storage study', publication_date='2025-02-01',
        topics=[{'display_name':'Storage'}], keywords=[{'display_name':'Storage'}], cited_by_count=12,
        type='review', open_access={'is_oa':True, 'oa_url':'https://example.org/paper'},
        authorships=[{'author':{'id':'https://openalex.org/A1','display_name':'Same Name'},
                     'institutions':[{'id':'https://openalex.org/I1','display_name':'University'}]},
                    {'author':{'id':'https://openalex.org/A2','display_name':'Same Name'},
                     'institutions':[{'id':'https://openalex.org/I1','display_name':'University'}]}])
    work.update(changes)
    return normalize(work)


def test_entity_identity_and_per_record_deduplication():
    papers = [record(), record(), record('W2')]
    authors = map_data(papers, 'Authors')
    assert len(authors['groups']) == 2  # Same display name, different people.
    assert all(g['value'] == 2 for g in authors['groups'].values())
    assert map_data(papers, 'Institutions')['groups']['https://openalex.org/I1']['value'] == 2
    assert map_data(papers, 'Topic volume')['groups']['Storage']['value'] == 2
    assert map_data(papers, 'Citation attention')['groups']['Storage']['value'] == 24


def test_scope_retractions_unknowns_and_real_zero():
    papers = [record(), record('W2', is_retracted=True), record('W3', cited_by_count=None), record('W4', cited_by_count=0)]
    data = map_data(papers, 'Citation attention', 'Storage')
    assert len(data['records']) == 3
    assert data['missing'] == 1
    assert data['groups']['Storage']['value'] == 12
    assert len(data['groups']['Storage']['paper_ids']) == 2
    assert not map_data(papers, 'Authors', 'unrelated')['records']


def test_subset_views_and_dates():
    papers = [record(), record('W2', type='article', publication_date='2020-01-01', open_access={}),
              record('W3', publication_date=None, cited_by_count=None)]
    assert map_data(papers, 'Reviews')['groups']['Storage']['value'] == 2
    assert map_data(papers, 'Recent activity', today=date(2026,11,5))['groups']['Storage']['value'] == 1
    assert map_data(papers, 'Free to read')['groups']['Storage']['value'] == 2
    assert map_data(papers, 'Publication years')['groups']['unknown']['value'] == 1


def test_all_map_views_and_source_drilldown():
    app = AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py'), default_timeout=30).run()
    app.text_area[0].input('storage').run()
    next(b for b in app.button if b.label.startswith('Turn my')).click().run()
    with patch('screens.home.retrieve', return_value=[record()]):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    app.button(key='nav_Bubble map').click().run()
    next(r for r in app.radio if r.key == 'board_mode').set_value('Explore research activity').run()
    for view in VIEWS:
        next(s for s in app.selectbox if s.key == 'map_view').select(view).run()
        assert not app.exception, view
    next(s for s in app.selectbox if s.key == 'map_view').select('Authors').run()
    next(b for b in app.button if b.key == 'metric_https://openalex.org/A1').click().run()
    assert app.session_state['map_selected'] == 'https://openalex.org/A1'
    assert any((b.key or '').startswith('insight_save_') for b in app.button)
    next(b for b in app.button if (b.key or '').startswith('insight_save_')).click().run()
    assert len(app.session_state['saved_papers']) == 1
    next(s for s in app.selectbox if s.key == 'map_view').select('Reviews').run()
    assert 'map_selected' not in app.session_state
    assert not app.exception


def test_demo_is_labelled_and_zero_is_distinct_from_unknown():
    from services.demo_map import demo_papers
    demo = demo_papers()
    assert all(p['provenance']['source'] == 'Illustrative interface demo' and p['doi'] is None and p['paper_url'] is None for p in demo)
    data = map_data([record(cited_by_count=0)], 'Citation attention')
    assert data['groups']['Storage']['value'] == 0 and data['missing'] == 0
    data = map_data([record(cited_by_count=None)], 'Citation attention')
    assert not data['groups'] and data['missing'] == 1
