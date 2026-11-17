from pathlib import Path
from unittest.mock import patch
from streamlit.testing.v1 import AppTest
from services.topic_signals import topic_signals, expand_directions_from_sample
from services.background_articles import search_background_articles, article_full_text
from services.scholarly import crossref_record
from services.ranking import shortlist


def test_topic_bubbles_use_preview_counts_and_question_relevance():
    directions=[{'label':'Shelf life','query':'banana shelf life'},
        {'label':'Nutrition','query':'banana nutritional composition'}]
    papers=[{'title':'Banana shelf life in storage','abstract':'Storage affects shelf life.',
        'topics':[],'keywords':[],'is_retracted':False},
        {'title':'Another shelf life study','abstract':'Banana ripening.',
        'topics':[],'keywords':[],'is_retracted':False}]
    signals=topic_signals('How long does a banana last?',directions,papers)
    assert signals['Shelf life']['count']==2
    assert signals['Nutrition']['count']==0
    assert signals['Shelf life']['relevance']>signals['Nutrition']['relevance']


def test_unknown_question_gets_source_derived_bubbles_without_ai():
    from services.discovery_ai import guided_plan
    question='How do solar panels work during cloudy weather?'
    plan=guided_plan(question)
    papers=[{'title':'Cloud cover and photovoltaic power','abstract':'',
        'topics':['Photovoltaics','Cloud cover'],'keywords':[]},
        {'title':'Photovoltaics during cloud cover','abstract':'',
        'topics':['Photovoltaics','Cloud cover'],'keywords':[]}]
    expanded=expand_directions_from_sample(question,plan,papers)
    labels=[item['label'] for item in expanded['directions']]
    assert 'Photovoltaics' in labels and 'Cloud cover' in labels
    assert 'no AI' in expanded['origin']
    signals=topic_signals(question,expanded['directions'],papers)
    assert 'Search my wording' not in labels
    assert signals['Photovoltaics']['count']==2


def test_background_articles_are_labelled_and_have_real_source_urls():
    search={'query':{'search':[{'pageid':10,'title':'Shelf life'},
        {'pageid':11,'title':'Red banana'}]}}
    extracts={'query':{'pages':{'10':{'title':'Shelf life','extract':'A source introduction.'}}}}
    with patch('services.background_articles._request',side_effect=[search,extracts,extracts]):
        items=search_background_articles('banana shelf life')
        full=article_full_text('Shelf life')
    assert items[0]['paper_type']=='Background article'
    assert len(items)==1
    assert items[0]['paper_url']=='https://en.wikipedia.org/wiki/Shelf_life'
    assert items[0]['abstract']==full=='A source introduction.'


def test_combo_reading_list_and_quick_preview():
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_area[0].input('Banana good for how long?').run()
    next(b for b in app.button if b.label=='Turn into search').click().run()
    app.button(key='topic_bubble_0').click().run()
    paper=crossref_record({'DOI':'10.1/shelf','title':['Banana shelf life'],
        'abstract':'Bananas change during storage. This study examines shelf life.',
        'subject':['Shelf life']})
    with patch('screens.home.retrieve',return_value=[paper]):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    assert len(app.session_state['saved_combos'])==1
    app.button(key='reading_about_0').click().run()
    assert any('Bananas change during storage.' in node.value for node in app.markdown)
    app.button(key='reading_add_0').click().run()
    assert paper['id'] in app.session_state['saved_combos'][0]['reading_ids']
    app.pills(key='reading_type').set_value('My reading list').run()
    assert app.button(key='reading_preview_0')
    app.button(key='reading_preview_0').click().run()
    app.button(key='preview_read').click().run()
    assert app.session_state['reader_id']==paper['id']
    assert app.session_state['ui_step']=='Read paper'
    assert not app.exception


def test_removing_from_combo_updates_its_reading_list():
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_area[0].input('Banana good for how long?').run()
    next(b for b in app.button if b.label=='Turn into search').click().run()
    app.button(key='topic_bubble_0').click().run()
    paper=crossref_record({'DOI':'10.1/remove','title':['Banana shelf life'],'subject':['Shelf life']})
    with patch('screens.home.retrieve',return_value=[paper]):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    app.button(key='reading_add_0').click().run()
    assert app.button(key='reading_add_0').label=='− Remove'
    app.button(key='reading_add_0').click().run()
    assert app.session_state['saved_combos'][0]['reading_ids']==[]
    app.pills(key='reading_type').set_value('My reading list').run()
    assert not any(b.key=='reading_preview_0' for b in app.button)


def test_newest_order_really_prioritizes_publication_date():
    old=crossref_record({'DOI':'10.1/old','title':['Banana shelf life'],
        'published':{'date-parts':[[2020,1,1]]}})
    new=crossref_record({'DOI':'10.1/new','title':['Fruit study'],
        'published':{'date-parts':[[2025,1,1]]}})
    assert shortlist([old,new],'banana shelf life',{},'Recent research')[0]['id']==new['id']
