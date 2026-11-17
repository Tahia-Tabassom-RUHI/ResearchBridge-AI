from pathlib import Path
from unittest.mock import patch
from streamlit.testing.v1 import AppTest
from services.scholarly import crossref_record
from services.vault_store import new_token, save_vault, load_vault


def test_vault_token_is_required_and_json_round_trips(tmp_path):
    path=tmp_path/'vault.sqlite3'
    token=new_token()
    assert not save_vault('guessable',{'saved_combos':[]},path)
    assert load_vault('guessable',path) is None
    assert save_vault(token,{'saved_combos':[{'name':'Shelf life'}]},path)
    assert load_vault(token,path)['saved_combos'][0]['name']=='Shelf life'


def test_saved_combo_and_reading_list_survive_new_app_session():
    path=str(Path(__file__).resolve().parents[1]/'app.py')
    first=AppTest.from_file(path).run()
    token=first.session_state['vault_id']
    first.text_area[0].input('Banana good for how long?').run()
    next(b for b in first.button if b.label=='Turn into search').click().run()
    first.button(key='topic_bubble_0').click().run()
    paper=crossref_record({'DOI':'10.1/shelf','title':['Banana shelf life'],
        'abstract':'A study of banana shelf life. It examines storage conditions.',
        'subject':['Shelf life']})
    with patch('screens.home.retrieve',return_value=[paper]):
        next(b for b in first.button if b.label=='Find real papers →').click().run()
    first.button(key='reading_add_0').click().run()
    second=AppTest.from_file(path)
    second.query_params['vault']=token
    second.run()
    assert second.session_state['ui_step']=='Papers'
    assert second.session_state['saved_combos'][0]['reading_ids']==[paper['id']]
    assert second.session_state['saved_papers'][paper['id']]['title']=='Banana shelf life'
    assert not second.exception


def test_vault_can_rename_remove_and_undo_a_study_set():
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py')).run()
    app.text_area[0].input('Banana good for how long?').run()
    next(b for b in app.button if b.label=='Turn into search').click().run()
    app.button(key='topic_bubble_0').click().run()
    app.button(key='save_combo').click().run()
    app.button(key='rail_Vault').click().run()
    app.button(key='combo_edit_0').click().run()
    app.text_input(key='combo_name_0').input('Banana shelf life study').run()
    app.button(key='combo_rename_0').click().run()
    assert app.session_state['saved_combos'][0]['name']=='Banana shelf life study'
    app.button(key='combo_remove_0').click().run()
    assert not app.session_state['saved_combos']
    app.button(key='undo_combo').click().run()
    assert app.session_state['saved_combos'][0]['name']=='Banana shelf life study'
    assert not app.exception
