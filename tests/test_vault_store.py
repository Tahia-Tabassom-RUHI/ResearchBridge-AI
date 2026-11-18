from pathlib import Path
from unittest.mock import patch
from streamlit.testing.v1 import AppTest
from services.scholarly import crossref_record
from services.vault_store import new_token, save_vault, load_vault, update_vault


def _app(token=None):
    app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'app.py'))
    if token is not None:
        app.query_params['vault']=token
    return app.run()


def _search(app,papers):
    app.text_input(key='question').input('Banana shelf life').run()
    next(b for b in app.button if b.label=='Turn into search').click().run()
    app.button(key='topic_bubble_0').click().run()
    with patch('screens.home.retrieve',return_value=papers):
        next(b for b in app.button if b.label=='Find real papers →').click().run()
    return app


def _papers():
    return [crossref_record({'DOI':f'10.1234/{i}','title':[f'Banana shelf life {i}']})
        for i in (1,2)]


def test_vault_token_is_required_and_json_round_trips(tmp_path):
    path=tmp_path/'vault.sqlite3'
    token=new_token()
    assert not save_vault('guessable',{'saved_combos':[]},path)
    assert load_vault('guessable',path) is None
    assert save_vault(token,{'saved_combos':[{'name':'Shelf life'}]},path)
    assert load_vault(token,path)['saved_combos'][0]['name']=='Shelf life'


def test_saved_combo_and_reading_list_survive_new_app_session(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    paper=_papers()[0]
    first=_search(_app(),[paper])
    token=first.session_state['vault_id']
    first.button(key='reading_add_0').click().run()
    second=_app(token)
    assert second.session_state['ui_step']=='Papers'
    assert second.session_state['saved_combos'][0]['reading_ids']==[paper['id']]
    assert second.session_state['saved_papers'][paper['id']]==paper
    assert not second.exception


def test_two_sessions_keep_distinct_additions_to_the_same_reading_list(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    papers=_papers()
    first=_search(_app(),papers)
    token=first.session_state['vault_id']
    second=_app(token)
    first.button(key='reading_add_0').click().run()
    second.button(key='reading_add_1').click().run()

    expected=[paper['id'] for paper in papers]
    stored=load_vault(token)
    assert stored['saved_combos'][0]['reading_ids']==expected
    assert list(stored['saved_papers'])==expected
    assert second.session_state['saved_combos'][0]['reading_ids']==expected
    assert not first.exception and not second.exception


def test_stale_remove_reports_conflict_and_leaves_saved_data_intact(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    papers=_papers()
    first=_search(_app(),papers)
    first.button(key='reading_add_0').click().run()
    token=first.session_state['vault_id']
    second=_app(token)
    first.button(key='reading_add_1').click().run()
    expected=load_vault(token)
    second.button(key='reading_add_0_membership').click().run()

    assert 'changed in another session' in second.error[0].value
    assert 'Reload' in second.error[0].value
    assert second.button(key='reading_add_0_membership').label.startswith('Remove from ')
    assert load_vault(token)==expected
    refreshed=_app(token)
    refreshed.button(key='reading_add_0_membership').click().run()
    assert not refreshed.error
    assert load_vault(token)['saved_combos'][0]['reading_ids']==[papers[1]['id']]


def test_stale_add_after_study_set_edit_requests_reload(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    app=_search(_app(),_papers())
    token=app.session_state['vault_id']

    def rename_study_set(data):
        return {**data,'saved_combos':[{**data['saved_combos'][0],'name':'Renamed elsewhere'}]}

    saved=update_vault(token,rename_study_set)
    app.button(key='reading_add_0').click().run()
    assert 'changed in another session' in app.error[0].value
    assert app.button(key='reading_add_0').label=='Save to Library'
    assert load_vault(token)==saved


def test_failed_add_and_remove_show_errors_without_changing_the_list(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    papers=_papers()
    app=_search(_app(),papers)
    app.button(key='reading_add_0').click().run()
    token=app.session_state['vault_id']
    expected=load_vault(token)
    with monkeypatch.context() as failed:
        failed.setattr('services.vault_store.MAX_VAULT_SIZE',1)
        app.button(key='reading_add_1').click().run()
    assert 'storage limit reached' in app.error[0].value
    assert app.button(key='reading_add_1').label=='Save to Library'
    assert load_vault(token)==expected

    with patch('services.vault_store._connect',side_effect=OSError):
        app.button(key='reading_add_0_membership').click().run()
    assert 'storage is unavailable' in app.error[0].value
    assert app.button(key='reading_add_0_membership').label.startswith('Remove from ')
    assert load_vault(token)==expected
    app.button(key='reading_add_0_membership').click().run()
    assert not app.error
    assert not load_vault(token)['saved_combos'][0]['reading_ids']


def test_vault_can_rename_remove_and_undo_a_study_set(monkeypatch):
    monkeypatch.setattr('screens.home.secret', lambda name, default='': default)
    monkeypatch.setattr('streamlit.components.v1.declare_component',
        lambda *args,**kwargs:lambda **kwargs:{'index':0,'action':'select'})
    app=_app()
    app.text_input(key='question').input('Banana good for how long?').run()
    next(b for b in app.button if b.label=='Turn into search').click().run()
    app.button(key='topic_bubble_0').click().run()
    app.button(key='save_combo').click().run()
    app.button(key='topic_bubble_1').click().run()
    app.button(key='save_combo').click().run()
    app.button(key='rail_Question').click().run()
    app.button(key='saved_searches').click().run()
    app.text_input(key='combo_name_0').input('Banana shelf life study').run()
    next(b for b in app.button if b.label=='Save').click().run()
    assert app.session_state['saved_combos'][0]['name']=='Banana shelf life study'
    next(b for b in app.button if b.label=='Remove').click().run()
    assert len(app.session_state['saved_combos'])==1
    next(b for b in app.button if b.label=='Undo remove').click().run()
    assert app.session_state['saved_combos'][0]['name']=='Banana shelf life study'
    assert not app.exception
