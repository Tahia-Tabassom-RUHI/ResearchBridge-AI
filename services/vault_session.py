"""Connect the local vault to a Streamlit browser session."""
from copy import deepcopy

import streamlit as st
from services.vault_store import VaultError, load_vault, new_token, update_vault, valid_token


VAULT_DEFAULTS=dict(saved_combos=[],saved_papers={},loose_reading_ids=[],
    active_combo_id=None,light_mode=False,folders={},paper_folders={},reading_status={})
CONFLICT_MESSAGE='The Vault changed in another session. Reload this page, then retry your edit.'


def _session_data():
    return {key:st.session_state.get(key,default) for key,default in VAULT_DEFAULTS.items()}


def _apply(data,keys=VAULT_DEFAULTS):
    for key in keys:
        value=data.get(key,VAULT_DEFAULTS[key])
        if key not in st.session_state or st.session_state[key]!=value:
            st.session_state[key]=deepcopy(value)


def initialize_vault():
    if 'vault_baseline' in st.session_state:
        return
    token=st.query_params.get('vault')
    if not valid_token(token):
        token=new_token()
        st.query_params['vault']=token
    st.session_state.vault_id=token
    try:
        data=load_vault(token)
        if data is None:
            initial=_session_data()
            data=update_vault(token,lambda current:initial if current is None else current)
    except VaultError as exc:
        st.error(str(exc))
        st.stop()
    st.session_state.vault_baseline=deepcopy(data)
    _apply(data)
    active=data.get('active_combo_id')
    if 'ui_step' not in st.session_state and isinstance(active,int) and 0<=active<len(st.session_state.saved_combos):
        combo=st.session_state.saved_combos[active]
        if isinstance(combo,dict) and combo.get('plan') and combo.get('query'):
            st.session_state.update(active_combo_id=active,topic=combo.get('topic',''),
                question=combo.get('topic',''),discovery_plan=combo['plan'],
                selected_directions=list(combo.get('selected',[])),query=combo['query'],
                year_filter=combo.get('year_filter','Any year'),discovery_sample=combo.get('sample'))
            if combo.get('papers'):
                st.session_state.update(papers=list(combo['papers']),weights=dict(combo.get('weights',{})),
                    background_articles=list(combo.get('articles',[])),searched_query=combo['query'],
                    searched_year=combo.get('searched_year','Any year'),ui_step='Papers')
            else:
                st.session_state.ui_step='Direction'


def _study_set_layout(combos):
    return [{key:value for key,value in combo.items() if key!='reading_ids'} for combo in combos]


def _add_to_latest(latest,baseline,candidate,item_id):
    if latest is None:
        raise VaultError(CONFLICT_MESSAGE)
    active=candidate['active_combo_id']
    latest_combos=latest.get('saved_combos',[])
    base_combos=baseline.get('saved_combos',[])
    # Study sets and Undo use list positions, so reject structural changes.
    if _study_set_layout(base_combos)!=_study_set_layout(latest_combos):
        raise VaultError(CONFLICT_MESSAGE)
    if isinstance(active,int) and 0<=active<len(candidate['saved_combos']):
        base_ids=base_combos[active].get('reading_ids',[])
        ids=latest_combos[active].setdefault('reading_ids',[])
    else:
        base_ids=baseline.get('loose_reading_ids',[])
        ids=latest.setdefault('loose_reading_ids',[])
    papers=latest.setdefault('saved_papers',{})
    item=candidate['saved_papers'][item_id]
    if (papers.get(item_id) not in (baseline.get('saved_papers',{}).get(item_id),item)
            or (item_id in base_ids and item_id not in ids)):
        raise VaultError(CONFLICT_MESSAGE)
    if item_id not in ids:
        ids.append(item_id)
    papers[item_id]=item
    return latest


def persist_vault(*,added_item_id=None,fields=VAULT_DEFAULTS):
    baseline=st.session_state['vault_baseline']
    candidate={**baseline,**{key:st.session_state.get(key,VAULT_DEFAULTS[key]) for key in fields}}

    def update(latest):
        if latest==baseline:
            return candidate
        if added_item_id is not None:
            return _add_to_latest(deepcopy(latest),baseline,candidate,added_item_id)
        raise VaultError(CONFLICT_MESSAGE)

    try:
        saved=update_vault(st.session_state['vault_id'],update)
    except VaultError as exc:
        _apply(baseline)
        st.session_state.vault_error=str(exc)
        st.session_state.vault_saved=False
        return False
    st.session_state.vault_baseline=deepcopy(saved)
    if saved is not candidate:
        _apply(saved,('saved_combos','saved_papers','loose_reading_ids','folders','paper_folders','reading_status'))
    st.session_state.pop('vault_error',None)
    st.session_state.vault_saved=True
    return True


def remove_item_everywhere(item_id):
    st.session_state.get('paper_folders',{}).pop(item_id,None)
    st.session_state.get('reading_status',{}).pop(item_id,None)
    st.session_state.get('saved_papers',{}).pop(item_id,None)
    for combo in st.session_state.get('saved_combos',[]):
        combo['reading_ids']=[value for value in combo.get('reading_ids',[]) if value!=item_id]
    st.session_state.loose_reading_ids=[value for value in st.session_state.get('loose_reading_ids',[])
        if value!=item_id]
    persist_vault()
