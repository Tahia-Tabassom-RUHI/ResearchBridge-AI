from pathlib import Path
from unittest.mock import patch
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
    app.text_area[0].input('fruit juice storage').run()
    next(b for b in app.button if b.label.startswith('Turn my')).click().run()
    with patch('screens.home.retrieve', return_value=[sample()]):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert not app.exception
    app.button(key='nav_Bubble map').click().run()
    bubble = next(b for b in app.button if b.key == 'bubble_Storage')
    bubble.click().run()
    assert not app.exception
    assert app.session_state['weights']['Storage'] == 2
    app.button(key='nav_Papers').click().run()
    next(b for b in app.button if b.label == 'Save for later').click().run()
    assert len(app.session_state['saved_papers']) == 1
    next(b for b in app.button if b.label == 'Open paper →').click().run()
    next(b for b in app.button if b.label == 'Learn this paper →').click().run()
    assert app.session_state['selected_paper']['id'] == sample()['id']


def test_empty_and_error_search_keep_question():
    from services.papers import DiscoveryError
    app = AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_area[0].input('orbital mechanics').run()
    next(b for b in app.button if b.label.startswith('Turn my')).click().run()
    with patch('screens.home.retrieve', return_value=[]):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert 'No records found' in app.warning[0].value
    with patch('screens.home.retrieve', side_effect=DiscoveryError('Service unavailable')):
        next(b for b in app.button if b.label == 'Find real papers →').click().run()
    assert app.error[0].value == 'Service unavailable'
    app.button(key='nav_Question').click().run()
    assert app.text_area[0].value == 'orbital mechanics'
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
