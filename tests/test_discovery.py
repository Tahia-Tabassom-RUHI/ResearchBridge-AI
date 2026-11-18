from pathlib import Path
from unittest.mock import patch
import pytest
from streamlit.testing.v1 import AppTest
from services.papers import normalize, abstract_text
from services.ranking import rank_papers, query_from_question, starter_directions


def sample():
    return normalize({'id':'https://openalex.org/W1','title':'Fruit juice storage', 'publication_date':'2024-01-01', 'keywords':[{'display_name':'Storage'}]})


def test_missing_evidence_stays_missing():
    p = sample()
    assert p['abstract'] is None
    assert p['doi'] is None
    assert p['is_retracted'] is None
    assert abstract_text({'Hello':[0], 'world':[1]}) == 'Hello world'


def test_focus_ranking_and_retraction():
    a = sample()
    b = dict(a, id='other', title='Oxidation', keywords=[])
    retracted = dict(b, id='retracted', is_retracted=True)
    assert rank_papers([a,b,retracted], {'Oxidation':3}) == [b,a]
    assert rank_papers([a,b], {'Oxidation':0}) == [a,b]


def test_starter_is_not_general_understanding():
    assert starter_directions('keep a smoothie in the fridge')
    assert not starter_directions('orbital mechanics')
    assert 'smoothie' in query_from_question('How long can I keep a smoothie?')


def test_question_to_bubble_to_handoff():
    app = AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_input(key='question').input('fruit juice storage').run()
    next(b for b in app.button if b.label == 'Turn into search').click().run()
    with patch('screens.home.retrieve', return_value=[sample()]):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert not app.exception
    bubble = next(b for b in app.button if b.key == 'metric_Storage')
    bubble.click().run()
    assert not app.exception
    assert app.session_state['map_selected'] == 'Storage'
    app.button(key='reading_add_0').click().run()
    assert len(app.session_state['saved_papers']) == 1
    app.button(key='reading_preview_0').click().run()
    app.button(key='preview_read').click().run()
    assert app.session_state['reader_id'] == sample()['id']
    assert any('needs a usable abstract' in item.value for item in app.info)
    assert not any(b.label == 'Guided Reading & Reflections' for b in app.button)


def test_empty_and_error_search_keep_question():
    from services.papers import DiscoveryError
    app = AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_input(key='question').input('orbital mechanics').run()
    next(b for b in app.button if b.label == 'Turn into search').click().run()
    with patch('screens.home.retrieve', return_value=[]):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert 'No records found' in app.warning[0].value
    with patch('screens.home.retrieve', side_effect=DiscoveryError('Service unavailable')):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert app.error[0].value == 'Service unavailable'
    app.button(key='rail_Sources').click().run()
    assert app.error[0].value == 'Service unavailable'
    app.button(key='rail_Question').click().run()
    assert app.text_input(key='question').value == 'orbital mechanics'
    assert not app.exception


@pytest.mark.parametrize('with_papers',[False,True])
def test_sources_show_partial_failure_and_exclusions(monkeypatch,with_papers):
    from services.scholarly import crossref_record

    monkeypatch.setattr('screens.home.secret',lambda name,default='':default)
    valid=crossref_record({'DOI':'10.1234/valid','title':['Storage study']})
    retracted={**valid,'id':'old','doi':None,'title':'Withdrawn study','is_retracted':True}
    notice={**valid,'id':'notice','doi':None,'title':'Withdrawal notice','paper_type':'retraction-notice'}
    papers=[valid,retracted,notice] if with_papers else []
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    query='storage publications' if with_papers else 'missing storage publications'
    app.text_input(key='question').input(query).run()
    next(b for b in app.button if b.label=='Turn into search').click().run()

    with patch('services.scholarly.search_crossref',return_value=papers), \
            patch('services.scholarly.search_europe',side_effect=TimeoutError):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    assert any('Europe PMC could not respond' in warning.value for warning in app.warning)
    assert (app.session_state['ui_step'] == 'Papers') == with_papers
    app.button(key='rail_Sources').click().run()
    assert app.header[0].value=='Sources & transparency'
    assert any('Providers that responded · Crossref' in text.value for text in app.markdown)
    warnings=[warning.value for warning in app.warning]
    assert any('Europe PMC could not respond' in warning for warning in warnings)
    if with_papers:
        assert 'Retracted paper · Withdrawn study' in warnings
        assert 'Retraction notice · Withdrawal notice' in warnings
    else:
        assert any('no paper records' in prompt.value for prompt in app.info)
    assert not app.exception


def test_packed_circles_do_not_overlap_or_leave_board():
    import math
    from components.bubble_board import pack_circles
    nodes = pack_circles({f'Topic {i}': i % 4 for i in range(12)})
    for i, node in enumerate(nodes):
        assert 0 <= node['left'] <= 100-node['size']
        assert 0 <= node['top'] <= 100-node['size']
        for other in nodes[i+1:]:
            assert math.hypot(node['x']-other['x'], node['y']-other['y']) >= node['r']+other['r']
