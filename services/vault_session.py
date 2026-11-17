"""Connect the local vault to a Streamlit browser session."""
import streamlit as st
from services.vault_store import load_vault, new_token, save_vault, valid_token


def initialize_vault():
    if st.session_state.get('vault_loaded'):
        return
    token=st.query_params.get('vault')
    if not valid_token(token):
        token=new_token()
        st.query_params['vault']=token
    st.session_state.vault_id=token
    data=load_vault(token)
    if not isinstance(data,dict):
        # Preserve an open pre-vault session when the app updates in place.
        data=dict(saved_combos=st.session_state.get('saved_combos',[]),
            saved_papers=st.session_state.get('saved_papers',{}),
            loose_reading_ids=st.session_state.get('loose_reading_ids',[]),
            active_combo_id=st.session_state.get('active_combo_id'),
            light_mode=st.session_state.get('light_mode',False))
        save_vault(token,data)
    combos=data.get('saved_combos',[])
    saved=data.get('saved_papers',{})
    st.session_state.saved_combos=combos if isinstance(combos,list) else []
    st.session_state.saved_papers=saved if isinstance(saved,dict) else {}
    st.session_state.loose_reading_ids=data.get('loose_reading_ids',[])
    st.session_state.light_mode=bool(data.get('light_mode',False))
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
    st.session_state.vault_loaded=True


def persist_vault():
    token=st.session_state.get('vault_id')
    if not token:
        return False
    data=dict(saved_combos=st.session_state.get('saved_combos',[]),
        saved_papers=st.session_state.get('saved_papers',{}),
        loose_reading_ids=st.session_state.get('loose_reading_ids',[]),
        active_combo_id=st.session_state.get('active_combo_id'),
        light_mode=st.session_state.get('light_mode',False))
    saved=save_vault(token,data)
    st.session_state.vault_saved=saved
    return saved


def remove_item_everywhere(item_id):
    st.session_state.get('saved_papers',{}).pop(item_id,None)
    for combo in st.session_state.get('saved_combos',[]):
        combo['reading_ids']=[value for value in combo.get('reading_ids',[]) if value!=item_id]
    st.session_state.loose_reading_ids=[value for value in st.session_state.get('loose_reading_ids',[])
        if value!=item_id]
    persist_vault()
