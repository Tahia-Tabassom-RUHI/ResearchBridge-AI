import json
from unittest.mock import patch
import pytest
from services.discovery_ai import AIUnavailable, validate_plan, interpret_question, explain_abstract, guided_plan, generate_json
from services.scholarly import merge_records, crossref_record, europe_record, discover
from services.papers import DiscoveryError


def test_crossref_record_is_source_metadata_not_ai():
    p=crossref_record({'DOI':'10.1/real','title':['A <i>title</i>'],'abstract':'<jats:p>An abstract.</jats:p>',
        'published':{'date-parts':[[2025,3]]},'author':[{'given':'Ada','family':'Lee'}],'is-referenced-by-count':0})
    assert p['title']=='A title' and p['abstract']=='An abstract.'
    assert p['publication_date']=='2025-03' and p['cited_by_count']==0
    assert p['oa_url'] is None and p['is_retracted'] is None
    assert crossref_record({'title':['No DOI']}) is None


def test_merge_keeps_real_abstract_and_provenance():
    a=crossref_record({'DOI':'10.1/REAL','title':['Title']})
    b=europe_record({'id':'123','source':'MED','title':'Title','doi':'10.1/real',
        'abstractText':'Actual retrieved abstract','isOpenAccess':'Y','pmcid':'PMC123'})
    papers=merge_records([a,b])
    assert len(papers)==1 and papers[0]['abstract']=='Actual retrieved abstract'
    assert papers[0]['provenance']['sources']==['Crossref','Europe PMC']
    assert papers[0]['oa_url']=='https://europepmc.org/articles/PMC123'


def test_one_search_provider_can_fail():
    p=crossref_record({'DOI':'10.1/test','title':['Title']})
    with patch('services.scholarly.search_crossref',return_value=[p]),patch('services.scholarly.search_europe',side_effect=TimeoutError):
        found=discover('topic')
    assert len(found)==1 and found[0]['search_notices']
    with patch('services.scholarly.search_crossref',side_effect=TimeoutError),patch('services.scholarly.search_europe',side_effect=TimeoutError):
        with pytest.raises(DiscoveryError):discover('topic')


def plan():
    return dict(understanding='You might be exploring memory.',clarifying_question='Which aspect?',
        directions=[{'label':'Learning','query':'memory learning'}],concepts=[{'term':'Retention','meaning':'Keeping information over time.'}])


def test_plan_rejects_citation_invention_and_malformed_fields():
    assert validate_plan(plan())['directions'][0]['query']=='memory learning'
    bad=plan();bad['directions'][0]['query']='https://invented.example/paper'
    with pytest.raises(ValueError):validate_plan(bad)
    with patch('services.discovery_ai.generate_json',return_value={'papers':['made up']}):
        with pytest.raises(AIUnavailable):interpret_question('question','key')
    assert 'Guided' in guided_plan('how do I forget studied things')['origin']


def test_abstract_requires_actual_evidence():
    paper={'title':'Title','abstract':'The study investigated learning in students.'}
    valid={'orientation':'The study examines learning.', 'evidence_quote':'investigated learning in students.', 'reading_tip':'Look for the study question.'}
    with patch('services.discovery_ai.generate_json',return_value=valid):
        assert explain_abstract(paper,'question','key')['orientation']==valid['orientation']
    with patch('services.discovery_ai.generate_json',return_value={**valid,'evidence_quote':'invented result'}):
        with pytest.raises(AIUnavailable):explain_abstract(paper,'question','key')
    with patch('services.discovery_ai.generate_json',return_value={**valid,'orientation':'It improved learning by 95 percent.'}):
        with pytest.raises(AIUnavailable):explain_abstract(paper,'question','key')
    with patch('services.discovery_ai.generate_json') as api:
        with pytest.raises(AIUnavailable):explain_abstract({'abstract':None},'question','key')
        api.assert_not_called()


def test_no_secret_in_url_and_no_hidden_extra_fields():
    class Reply:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def read(self):return json.dumps({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':'{}'}]}}]}).encode()
    with patch('services.discovery_ai.urlopen',return_value=Reply()) as call:
        assert generate_json('system',{'question':'text'},'private-test-token')=={}
    request=call.call_args.args[0]
    assert 'private-test-token' not in request.full_url
    assert request.get_header('X-goog-api-key')=='private-test-token'
    assert 'gemini-2.5-flash-lite' in request.full_url


def test_guidance_direction_choice_and_focus_changes_real_search():
    from pathlib import Path
    from streamlit.testing.v1 import AppTest
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py'),default_timeout=20).run()
    app.text_area[0].input('Why do I forget things I studied yesterday?').run()
    next(b for b in app.button if b.label.startswith('Turn my')).click().run()
    next(r for r in app.radio if r.key=='plan_direction').set_value('Retrieval practice').run()
    assert app.text_input(key='query').value=='retrieval practice learning'
    p=crossref_record({'DOI':'10.1/test','title':['Retrieval practice learning'],'subject':['Memory']})
    with patch('screens.home.retrieve',return_value=[p]):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    app.button(key='nav_Bubble map').click().run()
    next(b for b in app.button if b.key=='bubble_Memory').click().run()
    with patch('screens.home.retrieve',return_value=[p]) as search:
        next(b for b in app.button if b.key=='search_focus').click().run()
    assert 'Memory' in search.call_args.args[3][0]
    assert not app.exception


def test_saved_real_search_is_labelled_and_secret_can_be_forgotten():
    from pathlib import Path
    from streamlit.testing.v1 import AppTest
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py'),default_timeout=20).run()
    next(b for b in app.button if b.key=='saved_Learning and memory').click().run()
    assert any('Saved real-paper search' in info.value for info in app.info)
    assert all(p['rehearsal_snapshot'] for p in app.session_state['papers'])
    app.text_input(key='gemini_session_key').input('test-key-never-a-real-secret').run()
    next(b for b in app.button if b.label=='Forget session key').click().run()
    assert app.text_input(key='gemini_session_key').value==''
    assert not app.session_state['ai_enabled']
    assert not app.exception


def test_steps_preserve_inputs_and_keep_results_out_of_question_screen():
    from pathlib import Path
    from streamlit.testing.v1 import AppTest
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py'),default_timeout=20).run()
    assert app.button(key='nav_Papers').disabled
    app.button(key='example_2').click().run()
    question=app.text_area[0].value
    app.button[0]  # Sidebar is present on every step.
    next(b for b in app.button if b.label.startswith('Turn my')).click().run()
    app.text_input(key='query').input('my edited search').run()
    app.selectbox(key='year_filter').select('Since 2020').run()
    app.button(key='nav_Question').click().run()
    assert app.text_area[0].value==question
    app.button(key='nav_Direction').click().run()
    assert app.text_input(key='query').value=='my edited search'
    assert app.selectbox(key='year_filter').value=='Since 2020'
    records=[crossref_record({'DOI':f'10.1/{i}','title':[f'Study {i}']}) for i in range(5)]
    with patch('screens.home.retrieve',return_value=records):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    assert not app.text_area
    assert len([b for b in app.button if b.label=='Open paper →'])==2
    app.button(key='nav_Question').click().run()
    assert not any(b.label=='Open paper →' for b in app.button)
    app.button(key='nav_Papers').click().run()
    next(b for b in app.button if b.label=='Next →').click().run()
    assert len([b for b in app.button if b.label=='Open paper →'])==2
    next(b for b in app.button if b.label=='Open paper →').click().run()
    assert app.session_state['ui_step']=='Read paper'
    assert len(app.tabs)==3
    assert not app.exception
