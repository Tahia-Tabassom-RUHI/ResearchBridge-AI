"""Beginner-first discovery: express a question, choose a direction, open real research."""
from dataclasses import asdict
import os
from pathlib import Path
from urllib.parse import urlencode
import streamlit as st
from services.papers import DiscoveryError, is_retracted_or_notice, search_papers, safe_url
from services.ranking import query_from_question, suggest_directions, shortlist
from services.discovery_ai import AIUnavailable, DEFAULT_MODEL, DEFAULT_HF_MODEL, guided_plan, interpret_question, explain_abstract
from components.paper_card import paper_card
from components.bubble_board import combination_board
from components.reading_workspace import reading_workspace
from services.demo_map import demo_papers
from screens.journal import journal_header
from screens.library import library_sidebar, render_library
from screens.research_matrix import render as render_research_matrix
from services.library import catalog as library_catalog, open_library
from screens.paper_reader import load_retrieved_paper, open_manual_reader
from services.ai_explainer import CARD_TITLES, generate_explanations, load_provider_configs
from services.paper_reader import validate_paper_input
from services.topic_signals import topic_signals, expand_directions_from_sample
from services.background_articles import search_background_articles
from screens.discovery_workspace import choose_reader, render_discovery_workspace, save_actions
from services.vault_session import initialize_vault, persist_vault

MAX_COMBOS=30

def secret(name, default=''):
    value=os.getenv(name,default)
    try:
        return st.secrets.get(name,value)
    except st.errors.StreamlitSecretNotFoundError:
        return value


def coach_configs():
    try:
        return load_provider_configs(st.secrets)
    except st.errors.StreamlitSecretNotFoundError:
        return load_provider_configs({})


def reserve_demo_ai_call(provider):
    if provider != 'huggingface':
        return True
    used=st.session_state.get('hf_requests_used',0)
    if used>=2:
        return False
    st.session_state.hf_requests_used=used+1
    return True


def explain_result_item(item,ai_key,model,provider):
    configs=coach_configs()
    if any(config.free_plan_confirmed for config in configs):
        try:
            generated=generate_explanations(item['title'],item['abstract'],configs,
                session_usage=st.session_state.setdefault('coach_usage',{}))
        except ValueError as exc:
            st.warning(str(exc))
            return None
        if generated.pack:
            card=generated.pack['research_problem']
            return {'simple':card['explanation'],'excerpt':card['supporting_excerpt'] or 'No supporting excerpt supplied.'}
        st.warning(generated.fair_use_notice or 'AI help is unavailable right now.')
        return None
    if not reserve_demo_ai_call(provider):
        st.warning('The free demo AI limit is reached for this session.')
        return None
    try:
        result=explain_abstract(item,st.session_state.get('topic',''),ai_key,model,provider)
        return {'simple':result['orientation'],'excerpt':result['evidence_quote']}
    except AIUnavailable as exc:
        st.warning(str(exc))
        return None


@st.cache_data(ttl=900, show_spinner=False, max_entries=40)
def retrieve(query, year, key, extra_queries=()):
    return search_papers(query,year,key,extra_queries)


def preview_topic_sample(question,plan):
    """Small live sample for bubble sizing; failure leaves counts unknown."""
    query=query_from_question(question)
    extra=(plan['directions'][0]['query'],) if plan.get('directions') else ()
    try:
        return retrieve(query,None,secret('OPENALEX_API_KEY'),extra)
    except DiscoveryError:
        return None


@st.cache_data(ttl=900,show_spinner=False,max_entries=40)
def retrieve_background(query):
    try:
        return search_background_articles(query,limit=5)
    except Exception:
        return []


def forget_session_key():
    st.session_state.gemini_session_key=''
    st.session_state.hf_session_key=''
    st.session_state.ai_guidance_opt_in=False


def combined_direction_query(plan, selected, fallback):
    phrases = [item['query'] for item in plan['directions'] if item['label'] in selected]
    if not phrases:
        return query_from_question(fallback)
    words = []
    seen = set()
    for phrase in phrases:
        for word in phrase.split():
            if word.casefold() not in seen:
                words.append(word)
                seen.add(word.casefold())
    return ' '.join(words)[:500]


def select_direction(label):
    selected = list(st.session_state.get('selected_directions', []))
    if label in selected:
        selected.remove(label)
    else:
        selected.append(label)
    st.session_state.selected_directions = selected
    st.session_state.last_selected_direction=label
    st.session_state.active_combo_id=None
    st.session_state.query = combined_direction_query(
        st.session_state.discovery_plan, selected, st.session_state.get('topic', ''))
    st.session_state.ui_step = 'Direction'


def topic_partition(plan, namespace='topic'):
    selected = st.session_state.get('selected_directions', [])
    chosen = [item for item in plan['directions'] if item['label'] in selected]
    sample=st.session_state.get('discovery_sample')
    signals=topic_signals(st.session_state.get('topic',''),plan['directions'],sample) if sample is not None else None
    st.caption('Tap topics to combine them. Bigger = more matches · teal = closer to your question.')
    left,right=st.columns(2)
    left.caption('TOPICS')
    right.caption('COMBINATION')
    combination_board(plan['directions'],selected,select_direction,namespace,signals)
    last=st.session_state.get('last_selected_direction')
    meaning=next((item.get('meaning') for item in plan['directions'] if item['label']==last),None)
    if chosen:
        st.caption(' + '.join(item['label'] for item in chosen))


def load_results(query, year_value, year_label, openalex_key, extra_queries=()):
    with st.spinner('Finding real papers and checking their source records…'):
        papers=retrieve(query,year_value,openalex_key,extra_queries)
    with st.spinner('Finding beginner background articles…'):
        articles=retrieve_background(query)
    st.session_state.papers=papers
    st.session_state.pop('search_failure',None)
    st.session_state.background_articles=articles
    st.session_state.nav_panel_open=False
    st.session_state.pop('map_selected',None)
    old=st.session_state.get('weights',{}) if st.session_state.get('searched_query')==query else {}
    terms=suggest_directions(papers)
    st.session_state.weights={term:old.get(term,1) for term in terms}
    for term,weight in old.items():
        if weight>1:
            st.session_state.weights[term]=weight
    st.session_state.searched_query=query
    st.session_state.searched_year=year_label
    st.session_state.search_phrases=[query,*extra_queries]
    st.session_state.pop('selected_paper',None)
    if st.session_state.get('selected_directions'):
        save_current_combo()
        return papers
    active=st.session_state.get('active_combo_id')
    combos=st.session_state.get('saved_combos',[])
    if (isinstance(active,int) and 0<=active<len(combos)
            and combos[active]['query']==query and combos[active]['year_filter']==year_label):
        combos[active]['papers']=papers
        combos[active]['weights']=dict(st.session_state.weights)
        combos[active]['searched_year']=year_label
    persist_vault()
    return papers


def save_current_combo():
    plan=st.session_state.get('discovery_plan')
    if not plan:
        return
    selected=list(st.session_state.get('selected_directions',[]))
    query=st.session_state.get('query','').strip()
    name=' + '.join(selected) or query or 'My question'
    sample=st.session_state.get('discovery_sample')
    compact_sample=[dict(title=paper.get('title'),abstract=(paper.get('abstract') or '')[:1200],
        topics=paper.get('topics') or [],keywords=paper.get('keywords') or [],
        is_retracted=paper.get('is_retracted'))
        for paper in (sample or [])[:80]] if sample is not None else None
    combo=dict(name=name[:75],topic=st.session_state.get('topic',''),plan=plan,
        selected=selected,query=query,year_filter=st.session_state.get('year_filter','Any year'),
        papers=list(st.session_state.get('papers',[])) if (st.session_state.get('searched_query')==query
            and st.session_state.get('searched_year')==st.session_state.get('year_filter','Any year')) else [],
        weights=dict(st.session_state.get('weights',{})),
        articles=list(st.session_state.get('background_articles',[])),reading_ids=[],sample=compact_sample,
        searched_year=st.session_state.get('searched_year','Any year'))
    combos=st.session_state.setdefault('saved_combos',[])
    match=next((i for i,item in enumerate(combos) if item['query']==query and item['selected']==selected
        and item['topic']==combo['topic'] and item['year_filter']==combo['year_filter']),None)
    if match is None:
        if len(combos)>=MAX_COMBOS:
            st.session_state.combo_limit_notice=True
            return
        combos.append(combo)
        match=len(combos)-1
    else:
        combo['reading_ids']=list(combos[match].get('reading_ids',[]))
        combos[match]=combo
    st.session_state.active_combo_id=match
    persist_vault()


def rename_combo(index):
    name=st.session_state.get(f'combo_name_{index}','').strip()[:75]
    if name:
        st.session_state.saved_combos[index]['name']=name
        if persist_vault():
            st.session_state.edit_combo_index=None


def remove_combo(index):
    combos=st.session_state.saved_combos
    deleted={'index':index,'combo':combos.pop(index),
        'was_active':st.session_state.get('active_combo_id')==index}
    active=st.session_state.get('active_combo_id')
    if isinstance(active,int):
        st.session_state.active_combo_id=None if active==index else active-1 if active>index else active
    if persist_vault():
        st.session_state.deleted_combo=deleted


def undo_remove_combo():
    deleted=st.session_state.get('deleted_combo')
    if not deleted:
        return
    index=min(deleted['index'],len(st.session_state.saved_combos))
    st.session_state.saved_combos.insert(index,deleted['combo'])
    active=st.session_state.get('active_combo_id')
    if deleted['was_active']:
        st.session_state.active_combo_id=index
    elif isinstance(active,int) and active>=index:
        st.session_state.active_combo_id=active+1
    if persist_vault():
        st.session_state.pop('deleted_combo',None)


def open_combo(index):
    combo=st.session_state.saved_combos[index]
    st.session_state.active_combo_id=index
    if not persist_vault():
        return False
    st.session_state.pop('search_failure',None)
    st.session_state.update(topic=combo['topic'],question=combo['topic'],
        discovery_plan=combo['plan'],selected_directions=list(combo['selected']),query=combo['query'],
        year_filter=combo['year_filter'],result_page=0,paper_view='Papers',last_selected_direction=None,
        discovery_sample=combo.get('sample'))
    if combo['papers']:
        st.session_state.update(papers=list(combo['papers']),weights=dict(combo['weights']),
            background_articles=list(combo.get('articles',[])),
            searched_query=combo['query'],searched_year=combo['searched_year'],ui_step='Papers')
    else:
        for key in ('papers','weights','searched_query','background_articles'):
            st.session_state.pop(key,None)
        st.session_state.ui_step='Direction'
    st.session_state.nav_panel_open=False
    return True


def render_combo_tray():
    combos=st.session_state.setdefault('saved_combos',[])
    if st.session_state.get('combo_limit_notice'):
        st.warning(f'Vault is full at {MAX_COMBOS} study sets. Remove one to save another.')
    if st.session_state.get('deleted_combo'):
        st.button('Undo removed study set',key='undo_combo',on_click=undo_remove_combo,width='stretch')
    if not combos:
        st.caption('Choose bubbles and tap Save combo. Your study sets will appear here.')
        return
    for index,combo in enumerate(combos):
        count=len(combo['papers'])
        label=combo['name']+(f' · {count} papers' if count else ' · ready to search')
        open_button,edit_button,remove_button=st.columns([6,1,1],gap='small')
        open_button.button(label,key=f'combo_{index}',on_click=open_combo,args=(index,),
            type='primary' if st.session_state.get('active_combo_id')==index else 'secondary',width='stretch')
        edit_button.button('✎',key=f'combo_edit_{index}',help='Rename study set',
            on_click=lambda i=index: st.session_state.update(edit_combo_index=i))
        remove_button.button('×',key=f'combo_remove_{index}',help='Remove study set',
            on_click=remove_combo,args=(index,))
        if st.session_state.get('edit_combo_index')==index:
            st.text_input('Study set name',value=combo['name'],key=f'combo_name_{index}',max_chars=75)
            st.button('Save name',key=f'combo_rename_{index}',on_click=rename_combo,args=(index,))
    if st.session_state.get('vault_saved',True):
        st.caption('Bookmark this page to return to your saved study sets.')


def open_combo_reading(index):
    if open_combo(index):
        st.session_state.ui_step='Combo reading'


def page_combo_reading(ai_key='',enabled=False,model='',provider='huggingface'):
    index=st.session_state.get('active_combo_id')
    combos=st.session_state.get('saved_combos',[])
    if not isinstance(index,int) or index>=len(combos):
        st.session_state.ui_step='Vault'
        st.rerun()
    combo=combos[index]
    st.header(combo['name'])
    with st.container(horizontal=True):
        st.button('← Previous research',on_click=go,args=('Vault',))
        st.button('Find more',on_click=open_combo,args=(index,))
    catalog={p['id']:p for p in [*combo.get('papers',[]),*combo.get('articles',[])]}
    catalog.update(st.session_state.get('saved_papers',{}))
    items=[catalog[i] for i in combo.get('reading_ids',[]) if i in catalog]
    if not items:
        st.caption('Reading list is empty. Use Find more to add items.')
        return
    library,reader=st.columns([1,3],gap='small')
    with library:
        st.caption(f'{len(items)} saved items')
        selected=st.radio('Documents',[p['id'] for p in items],
            format_func=lambda key:catalog[key]['title'],key=f'study_document_{index}',label_visibility='collapsed')
    with reader:
        paper=catalog[selected]
        st.subheader(paper['title'])
        text,original,notes,coach,foundations=st.tabs(['Read','Original paper','Notes & board','Learning tools','Foundations'])
        with text:
            with st.container(height=540,border=True):
                st.write(paper.get('abstract') or 'No text supplied. Use Original paper to read the source.')
            st.caption('Retrieved text. Use Original paper for the complete document.')
        with original:
            url=safe_url(paper.get('oa_url') or paper.get('paper_url'))
            if url:
                st.link_button('Open source ↗',url)
                st.iframe(url,height=560)
                st.caption('Some publishers block embedded viewing. Use Open source if needed.')
            else:
                st.caption('No source link supplied.')
        with notes:
            reading_workspace(paper,{p['id']:p for p in items})

        with coach:
            st.session_state.reader_id=paper['id']
            st.session_state.reader_origin='Papers'
            st.session_state.setdefault('reading_catalog',{})[paper['id']]=paper
            page_reader(ai_key,enabled,model,provider)
        with foundations:
            from screens.knowledge_check import render_knowledge_check
            render_knowledge_check()


def page_vault():
    st.header('Previous research')
    st.button('← Discover Papers', on_click=go, args=('Question',))
    combos=st.session_state.get('saved_combos',[])
    if not combos:
        st.caption('Save a search from Search topics to return to it here.')
        return
    rows=[{'Saved search':c['name'],'Topics':' + '.join(c.get('selected',[])),
        'Results':len(c.get('papers',[])), 'Reading list':len(c.get('reading_ids',[]))} for c in combos]
    import streamlit.components.v1 as components
    from pathlib import Path
    table=components.declare_component('vault_double_click',path=str(Path(__file__).resolve().parents[1]/'components'/'vault_table'))
    event=table(rows=rows,key='vault_table',default=None)
    selected=[]
    if event and 0<=event.get('index',-1)<len(combos):
        selected=[event['index']]
        if event.get('action')=='open' and event.get('nonce')!=st.session_state.get('vault_open_event'):
            st.session_state.vault_open_event=event['nonce']
            open_combo_reading(selected[0])
            st.rerun()
    if selected:
        index=selected[0]
        with st.container(horizontal=True):
            st.button('Open saved research',on_click=open_combo_reading,args=(index,),key='vault_open')
            with st.popover('Rename'):
                st.text_input('Name',value=combos[index]['name'],key=f'combo_name_{index}',max_chars=75)
                st.button('Save',on_click=rename_combo,args=(index,))
            st.button('Remove',on_click=remove_combo,args=(index,))
    if st.session_state.get('deleted_combo'):
        st.button('Undo remove',on_click=undo_remove_combo)


STEPS = ['Question', 'Direction', 'Papers', 'My Library', 'Sources']


def go(step):
    st.session_state.ui_step=step


def open_nav(step):
    st.session_state.nav_panel_open = step == "Settings" and not st.session_state.get("nav_panel_open")
    if step in STEPS:
        st.session_state.ui_step=step


def open_workspaces():
    st.session_state.nav_panel_open = False
    go('Workspaces')


def open_knowledge_check(paper=None, lessons_only=False):
    st.session_state.knowledge_return = st.session_state.ui_step
    st.session_state.knowledge_check_paper = paper
    st.session_state.knowledge_lessons_only = lessons_only
    st.session_state.nav_panel_open = False
    go('Knowledge check')


def close_nav():
    st.session_state.nav_panel_open=False


def sidebar():
    st.session_state.setdefault('nav_panel_open',False)
    with st.sidebar:
        st.html('<div class="journal-brand"><img src="app/static/journal/brand.svg" alt="">ResearchBridge</div>')
        step = st.session_state.ui_step
        settings = st.session_state.nav_panel_open
        def nav(label, key, icon, active, callback, *args):
            st.button(label, key=key, icon=f":material/{icon}:",
                      type="primary" if active and not settings else "tertiary",
                      width="stretch", on_click=callback, args=args)
        nav("Discover", "rail_Question", "explore", step in ("Question", "Direction", "Papers"),
            open_nav, "Question")
        nav("My Library", "rail_My Library", "local_library", step in ("My Library", "Saved"), open_library)
        with st.container(key="library_tree", gap=None):
            library_sidebar()
        nav("Guided Reading", "rail_guided", "menu_book", step == "Guided reading",
            open_tool, "Guided reading")
        nav("Learning Assistant", "rail_assistant", "school", step == "Learning Assistant",
            open_tool, "Learning Assistant")
        nav("Notes", "rail_notes", "edit_note", step == "Notes",
            open_tool, "Notes")
        nav("Workspace", "rail_workspace", "dashboard", step in ("Workspaces", "Workspace picker", "Read paper"),
            open_workspaces)
        nav("Sources", "rail_Sources", "source", step == "Sources", open_nav, "Sources")
        st.button("Settings", key="rail_Settings", icon=":material/settings:",
                  type="primary" if settings else "tertiary", width="stretch", on_click=open_nav, args=("Settings",))
    provider=st.session_state.get('ai_provider','Hugging Face')
    hf_key=st.session_state.get('hf_session_key','') or secret('HF_TOKEN')
    gemini_key=st.session_state.get('gemini_session_key','') or secret('GEMINI_API_KEY')
    ai_key=hf_key if provider=='Hugging Face' else gemini_key
    model=secret('HF_MODEL',DEFAULT_HF_MODEL) if provider=='Hugging Face' else secret('GEMINI_MODEL',DEFAULT_MODEL)
    enabled=st.session_state.get('ai_guidance_opt_in',False)
    if st.session_state.nav_panel_open:
        with st.container(key='nav_panel',border=True):
            st.subheader('Settings')
            st.button('Close settings',key='nav_close',on_click=close_nav)
            with st.expander('Learning tools'):
                st.button('Knowledge check & learning cards',on_click=open_knowledge_check)
            with st.expander('AI connection'):
                provider=st.selectbox('Provider', ['Hugging Face','Gemini'], key='ai_provider')
                hf_key=st.text_input('Hugging Face token (this session only)',type='password',key='hf_session_key') or secret('HF_TOKEN')
                gemini_key=st.text_input('Gemini key (this session only)',type='password',key='gemini_session_key') or secret('GEMINI_API_KEY')
                ai_key=hf_key if provider=='Hugging Face' else gemini_key
                model=secret('HF_MODEL',DEFAULT_HF_MODEL) if provider=='Hugging Face' else secret('GEMINI_MODEL',DEFAULT_MODEL)
                enabled=st.checkbox('Use live AI guidance',key='ai_guidance_opt_in')
                if provider=='Hugging Face':
                    st.link_button('Get a free Hugging Face token ↗','https://huggingface.co/settings/tokens')
                    st.caption(f"Free account credits · {max(0,2-st.session_state.get('hf_requests_used',0))} demo calls left")
                else:
                    st.link_button('Get a Gemini API key ↗','https://aistudio.google.com/api-keys')
                st.button('Forget session key',on_click=forget_session_key)
            with st.expander('Rehearsal & examples'):
                if st.button('Try an example research map',key='try_map_demo'):
                    install_search(demo_papers(),'Illustrative research-map demo','Illustrative years','Papers')
                    st.rerun()
                from services.rehearsal import saved_searches
                for item in saved_searches():
                    if st.button('Load saved real search: '+item['label'],key='saved_'+item['label']):
                        install_search(item['papers'],item['query'],'Saved search; original timestamps preserved','Papers')
                        st.rerun()
    return ai_key, enabled, 'huggingface' if provider=='Hugging Face' else 'gemini', model


def install_search(papers,query,year,step):
    st.session_state.update(papers=papers,query=query,discovery_plan=guided_plan(query),
        weights={term:1 for term in suggest_directions(papers)},searched_query=query,
        searched_year=year,background_articles=[],nav_panel_open=False,
        ui_step='Papers' if step=='Bubble map' else step,
        result_page=0,selected_directions=[],active_combo_id=None)
    for key in ('map_selected','reader_id','plan_direction','search_failure'):
        st.session_state.pop(key,None)


def page_question(ai_key,enabled,model,provider):
    question = st.text_input(
        'Your question', key='question',
        placeholder='wondering that…', max_chars=700,
    )
    if st.button('Turn into search', type='primary', disabled=not question.strip()):
        plan=guided_plan(question)
        if enabled and reserve_demo_ai_call(provider):
            try:
                with st.spinner('Finding possible research directions…'):
                    plan=interpret_question(question,ai_key,model,provider)
            except AIUnavailable as exc:
                st.session_state.ai_notice=str(exc)
        elif enabled:
            st.session_state.ai_notice='Hugging Face demo limit reached for this session. Guided search is ready.'
        with st.spinner('Finding related topics…'):
            sample=preview_topic_sample(question,plan)
        if plan.get('origin','').startswith('Guided'):
            plan=expand_directions_from_sample(question,plan,sample)
        st.session_state.update(topic=question,research_goal='Help me start',discovery_plan=plan,
            query=query_from_question(question),ui_step='Direction',result_page=0,
            selected_directions=[],active_combo_id=None,discovery_sample=sample,last_selected_direction=None)
        for name in ('plan_direction','papers','weights','searched_query','selected_paper','map_selected','reader_id','reader_origin','search_failure'):
            st.session_state.pop(name,None)
        st.rerun()


def page_direction(openalex_key,ai_key='',enabled=False,model='',provider='huggingface'):
    plan=st.session_state.discovery_plan
    st.header('Explore your question')
    if st.session_state.pop('ai_notice', None):
        st.caption('Showing guided suggestions. You can edit the search.')
    with st.container(horizontal=True, key='topic_tools', vertical_alignment='center', gap='small'):
        with st.popover('Edit question or search terms', width='content'):
            page_question(ai_key,enabled,model,provider)
            with st.expander('Exact search terms'):
                st.text_input('Search terms', key='query', max_chars=500)
        query=st.session_state.get('query','')
        with st.popover('Search filters', width='content'):
            year = st.selectbox('Publication window', ['Any year', 'Since 2024', 'Since 2020', 'Since 2015'], key='year_filter')
            if query.strip():
                st.link_button('Web search ↗', 'https://www.google.com/search?'+urlencode({'q': query}))
        st.button('Save search',key='save_combo',on_click=save_current_combo,
            disabled=not bool(st.session_state.get('selected_directions')),width='content')
        search_now=st.button('Find real papers →',type='primary',disabled=not query.strip(),width='content')
    st.caption(query)
    topic_partition(plan)
    if search_now:
        try:
            papers=load_results(query,None if year=='Any year' else int(year[-4:]),year,openalex_key)
            if papers:
                st.session_state.ui_step='Papers'
                st.session_state.result_page=0
                st.rerun()
            else:
                st.warning('No records found. Try a shorter phrase, a different direction, or Any year.')
                show_source_warnings(papers)
        except DiscoveryError as exc:
            st.session_state.search_failure=(query,str(exc))
            st.error(str(exc))


def sample_notice(papers):
    if any(p.get('provenance',{}).get('source')=='Illustrative interface demo' for p in papers):
        st.warning('Example data: invented records for trying the interface.')
    elif any(p.get('rehearsal_snapshot') for p in papers):
        st.info('Saved real-paper search for rehearsal · original timestamps preserved')


def page_papers(ai_key,enabled,model,provider):
    sample_notice(st.session_state.papers)
    show_source_warnings(st.session_state.papers)
    available=any(config.free_plan_confirmed for config in coach_configs()) or bool(enabled and ai_key)
    explain=(lambda item: explain_result_item(item,ai_key,model,provider)) if available else None
    render_discovery_workspace(st.session_state.papers,
        st.session_state.get('background_articles',[]),
        st.session_state.searched_query,st.session_state.weights,explain)


def show_paper_results():
    papers=st.session_state.papers
    st.header('A few places to begin')
    st.caption(f"{len(papers)} source records · {st.session_state.searched_query}")
    sample_notice(papers)
    goal=st.selectbox('Choose what helps you now',['Help me start','Best matches','Recent research','Free to read'],key='paper_goal')
    ranked=shortlist(papers,st.session_state.searched_query,st.session_state.weights,goal)
    if not ranked:
        st.warning('No eligible records to recommend. Change your direction.')
        return
    page=min(st.session_state.get('result_page',0),max((len(ranked)-1)//2,0))
    st.session_state.result_page=page
    for paper in ranked[page*2:page*2+2]:
        paper_card(paper,st.session_state.weights,query=st.session_state.searched_query,compact=True)
    prev,position,nxt=st.columns([1,2,1])
    prev.button('← Previous',disabled=page==0,on_click=set_result_page,args=(page-1,),width='stretch')
    position.caption(f'{page*2+1}–{min(page*2+2,len(ranked))} of {len(ranked)} · 2 papers at a time')
    nxt.button('Next →',disabled=(page+1)*2>=len(ranked),on_click=set_result_page,args=(page+1,),width='stretch')


def set_result_page(page):
    st.session_state.result_page=page


def current_reader_paper(prefer_catalog):
    reader_id=st.session_state.get('reader_id')
    catalog=st.session_state.get('reading_catalog',{})
    paper=catalog.get(reader_id) if prefer_catalog else next(
        (p for p in st.session_state.get('papers',[]) if p['id']==reader_id),None)
    if paper is None:
        paper=st.session_state.get('saved_papers',{}).get(reader_id)
    if paper is None:
        paper=catalog.get(reader_id)
    return paper


def page_reader(ai_key,enabled,model,provider):
    standalone = st.session_state.ui_step == 'Read paper'
    origin = st.session_state.get('reader_origin')
    from_library = standalone and origin == 'My Library'
    from_workspace = standalone and origin in ('Workspace', 'Workspace picker')
    back_step = 'My Library' if from_library else 'Papers'
    back_label = '← Back to My Library' if from_library else '← Back to papers'
    paper = current_reader_paper(from_library or from_workspace)
    if standalone:
        with st.container(horizontal=True):
            if origin == 'Workspace picker':
                st.button('← Back to paper picker', on_click=return_to_picker, args=('Read paper',))
            if not from_workspace:
                st.button(back_label, on_click=go, args=(back_step,))
            st.button('← Back to Workspaces', on_click=open_workspaces)
            st.button('+ Add Paper', on_click=open_workspace_picker, args=('Read paper',))
    else:
        st.button(back_label, on_click=go, args=(back_step,))
    if paper is None:
        st.info('Choose a paper from your results or My Library.')
        return
    is_background = paper.get('paper_type') == 'Background article'
    is_source_link = paper.get('paper_type') == 'Source link'
    st.subheader(paper['title'])
    if from_workspace:
        workspace_paper_details(paper)
    else:
        st.caption(' · '.join(filter(None,[paper.get('publication_date'),paper.get('source_name')])))
    if is_background:
        st.caption('Text: Wikipedia contributors · CC BY-SA 4.0. Original page links to its authors and history.')
    workspace_tab,abstract_tab,help_tab,details_tab,source_tab=st.tabs(
        ['Workspace','Abstract','Read & Learn','Source details','Original page'],
        default='Read & Learn' if origin == 'Workspace' else 'Workspace')
    with workspace_tab:
        st.caption(('Read this background article, group items, connect notes, and draw.' if is_background else
            'Read the retrieved abstract, group saved items, connect notes, and draw. The full paper opens at its source.'))
        reading_workspace(paper,st.session_state.get('saved_papers',{}))
    with abstract_tab:
        st.caption('Background article text; use research records for evidence.' if is_background else
            'Retrieved abstract only; the full paper has not been reviewed.')
        with st.container(height=330,border=True):
            st.write(paper.get('abstract') or 'Abstract unavailable. Open the original source to inspect the paper.')
    with help_tab:
        if is_background or is_source_link:
            st.info('This item helps you explore. The research paper explanation is available on research records.')
        else:
            usable_abstract = not validate_paper_input(paper['title'], paper.get('abstract'))
            with st.container(horizontal=True):
                st.button('Knowledge Check', key='check_'+paper['id'],
                          on_click=open_knowledge_check, args=(paper,))
                st.button('Prerequisite Lessons', key='lessons_'+paper['id'],
                          on_click=open_knowledge_check, args=(paper, True))
                if usable_abstract:
                    guided_reading_button(paper)
            st.subheader('AI Guided Learning')
            if not usable_abstract:
                st.info('This record needs a usable abstract for Guided Reading and AI explanations. Its source details and original link are still available when supplied.')
            else:
                st.caption('Free reading guide · based on the abstract text')
                for prompt in ('What question are the authors investigating?', 'How did they study it?', 'Which result is actually stated?'):
                    st.write('• '+prompt)
                render_ai_guidance(paper, ai_key, enabled, model, provider)
    with details_tab:
        with st.container(height=330,border=True):
            st.write('**Authors:** '+(', '.join(paper.get('authors') or []) or 'Unavailable'))
            st.write('**Record source:** '+((paper.get('provenance') or {}).get('source') or 'Unknown'))
            st.write('**Type:** '+(paper.get('paper_type') or 'Unknown'))
            st.caption('Originally retrieved: '+(paper.get('retrieved_at') or 'Unknown'))
            st.caption('Publication type does not establish peer review. Relevance is not a quality assessment.')
    original_url=safe_url(paper.get('paper_url'))
    free_text_url=safe_url(paper.get('oa_url'))
    with source_tab:
        source_url=free_text_url or original_url
        if source_url:
            st.caption('Some publishers block embedded previews. If the preview is blank, open the source in a new tab.')
            st.link_button('Open original in a new tab ↗',source_url)
            st.iframe(source_url,height=610)
        else:
            st.info('This source record did not provide a usable original-page link.')
    actions=st.columns(3)
    if original_url:
        actions[0].link_button('Original source ↗',original_url,width='stretch')
    if free_text_url:
        actions[1].link_button('Free text ↗',free_text_url,width='stretch')
    if not (from_library or from_workspace):
        save_actions(actions[2], paper, 'reader_save_' + paper['id'])


def guided_reading_button(paper):
    if st.button('Guided Reading & Reflections', key='learn_'+paper['id']):
        st.session_state.selected_paper = paper
        try:
            load_retrieved_paper(paper)
        except ValueError:
            st.info('This record needs a longer abstract for guided reading. You can still open the original source.')
        else:
            st.session_state.pop('guided_picker', None)
            st.session_state.pop('manual_picker', None)
            st.session_state.guided_standalone = False
            go('Guided reading')
            st.rerun()


PICKER_ACTIONS = {
    "Guided reading": "Start Guided Reading",
    "Learning Assistant": "Start AI Guided Learning",
    "Notes": "Open Personal Notes",
    "Read paper": "Open Paper Workspace",
}


def open_workspace_picker(return_to, target="Read paper"):
    st.session_state.setdefault("picker_origins", {})[target] = return_to
    st.session_state.update(workspace_picker_return=return_to, picker_target=target,
                            picker_selection=[], workspace_query="", nav_panel_open=False)
    go("Workspace picker")


def activate_study_paper(target, index):
    state = st.session_state
    queue = state.study_queues[target]
    paper = queue["papers"][index]
    if target == "Guided reading":
        state.pop("manual_picker", None)
        load_retrieved_paper(paper)
        state.guided_picker = True
    if target == "Learning Assistant":
        state.assistant_picker = True
    queue["index"] = index
    go(target)


def return_to_picker(target):
    state = st.session_state
    if state.picker_target != target:
        origin = state.picker_origins[target]
        open_workspace_picker(origin, target)
        queue = state.get("study_queues", {}).get(target)
        if queue:
            state.picker_selection = [paper["id"] for paper in queue["papers"]]
    else:
        go("Workspace picker")


def study_navigation(target):
    queue = st.session_state.study_queues[target]
    index = queue["index"]
    with st.container(horizontal=True, vertical_alignment="center"):
        st.button("← Back to paper picker", on_click=return_to_picker, args=(target,))
        if len(queue["papers"]) > 1:
            st.button("Previous Paper", disabled=index == 0,
                      on_click=activate_study_paper, args=(target, index - 1))
            st.caption(f"Paper {index + 1} of {len(queue['papers'])}")
            st.button("Next Paper", disabled=index == len(queue["papers"]) - 1,
                      on_click=activate_study_paper, args=(target, index + 1))


def pick_study_paper(paper_id, widget):
    selection = st.session_state.picker_selection
    if st.session_state[widget]:
        selection.append(paper_id)
    else:
        selection.remove(paper_id)


def workspace_paper_details(paper):
    details = [', '.join(paper.get('authors') or []), paper.get('source_name'), paper.get('publication_date'),
               (paper.get('provenance') or {}).get('source')]
    if metadata := ' · '.join(dict.fromkeys(value for value in details if value)):
        st.caption(metadata)
    st.caption(st.session_state.reading_status.get(paper['id'], 'To Read'))


def page_workspaces():
    st.header('My Workspaces')
    with st.container(horizontal=True):
        st.button('+ Add Paper', type='primary', on_click=open_workspace_picker, args=('Workspaces',))
        st.button('Read Your Own Abstract', on_click=open_manual_reader)
    papers = list(library_catalog().values())
    if not papers:
        st.info('Save a paper in My Library to open its workspace here.')
        st.button('Choose a Paper from My Library', on_click=open_workspace_picker, args=('Workspaces',))
    for start in range(0, len(papers), 3):
        for column, paper in zip(st.columns(3), papers[start:start + 3]):
            with column.container(border=True):
                st.subheader(paper['title'])
                workspace_paper_details(paper)
                st.button('Open Workspace', key='workspace_open_'+paper['id'],
                          on_click=choose_reader, args=(paper, 'Workspace'))


def open_manual_from_picker():
    open_manual_reader()
    st.session_state.manual_picker = True


def page_workspace_picker():
    state = st.session_state
    target = state.picker_target
    action = PICKER_ACTIONS[target]
    multiple = target in ("Guided reading", "Learning Assistant")
    st.header("Choose papers" if multiple else "Choose a paper")
    st.button("← Back", on_click=go, args=(state.workspace_picker_return,))
    if target == "Guided reading":
        st.button("Read your own abstract", on_click=open_manual_from_picker)
    papers = library_catalog()
    if not papers:
        st.info("Your Library has no saved papers yet.")
        st.button("Discover Papers", on_click=go, args=("Question",))
        return
    query = st.text_input("Search saved papers", key="workspace_query").strip().casefold()
    selected = [key for key in state.picker_selection if key in papers]
    state.picker_selection = selected

    if multiple:
        st.caption(f"{len(selected)} selected for learning")
        if st.button("Start Learning" if len(selected) > 1 else action,
                     key="start_learning", type="primary", disabled=not selected):
            state.setdefault("study_queues", {})[target] = {"papers": [papers[key] for key in selected]}
            activate_study_paper(target, 0)
            st.rerun()

    matches = [paper for paper in papers.values() if query in ' '.join([
        paper['title'], ' '.join(paper.get('authors') or []), paper.get('source_name') or '',
    ]).casefold()]
    if not matches:
        st.info("No saved papers match your search.")
    for paper in matches:
        paper_id = paper["id"]
        if multiple:
            usable = (paper.get("paper_type") not in ("Background article", "Source link")
                      and not validate_paper_input(paper["title"], paper.get("abstract")))
            widget = "study_select_" + paper_id
            state[widget] = paper_id in selected
            st.checkbox(paper["title"], key=widget, disabled=not usable,
                        on_change=pick_study_paper, args=(paper_id, widget))
            if not usable:
                st.caption("Requires a research record with a usable abstract.")
        else:
            with st.container(horizontal=True, vertical_alignment="center"):
                st.text(paper["title"])
                if st.button(action, key="workspace_pick_" + paper_id, help=paper["title"]):
                    if target == "Read paper":
                        choose_reader(paper, "Workspace picker")
                    else:
                        state.setdefault("paper_tools", {})[target] = (paper, "Workspace picker")
                        go(target)
                    st.rerun()


def render_ai_guidance(paper, ai_key, enabled, model, provider):
    configs = coach_configs()
    team_ai_ready = any(config.free_plan_confirmed for config in configs)
    if not paper.get('abstract'):
        st.info('An abstract is needed before we can explain it.')
    elif not enabled:
        st.caption('Enable live AI guidance in Settings to request an explanation.')
    elif not team_ai_ready and not ai_key:
        st.caption('Connect a provider in Settings to request an explanation.')
    elif st.button('Explain this abstract simply',key='explain_'+paper['id']):
        if team_ai_ready:
            try:
                with st.spinner('Checking the abstract with Learning Coach…'):
                    generated=generate_explanations(paper['title'],paper['abstract'],configs,
                        session_usage=st.session_state.setdefault('coach_usage',{}))
                if generated.pack:
                    st.session_state.setdefault('abstract_help_by_paper', {})[paper['id']]={'source':'learning_coach','result':generated.pack}
                else:
                    st.warning(generated.fair_use_notice or next((attempt.message for attempt in reversed(generated.attempts)), 'Learning Coach is unavailable.'))
            except ValueError as exc:
                st.warning(str(exc))
        else:
            try:
                if not reserve_demo_ai_call(provider):
                    st.warning('Hugging Face demo limit reached for this session. The free reading guide is available above.')
                else:
                    with st.spinner('Explaining the abstract with its source passage…'):
                        result=explain_abstract(paper,st.session_state.get('topic',''),ai_key,model,provider)
                    st.session_state.setdefault('abstract_help_by_paper', {})[paper['id']]={'source':provider,'result':result}
            except AIUnavailable as exc:
                st.warning(str(exc))
    help_result=st.session_state.get('abstract_help_by_paper', {}).get(paper['id'])
    if help_result:
        with st.container(height=330,border=True):
            if help_result.get('source')=='learning_coach':
                for name,title in CARD_TITLES.items():
                    card=help_result['result'][name]
                    st.write('**'+title+'**')
                    st.write(card['explanation'])
                    if card['supporting_excerpt']:
                        st.caption('From abstract: '+card['supporting_excerpt'])
            else:
                st.write(help_result['result']['orientation'])
                st.caption('AI explanation based on the retrieved abstract. Check the original source.')
                st.text(help_result['result']['evidence_quote'])
                st.write(help_result['result']['reading_tip'])


def open_guided():
    st.session_state.nav_panel_open = False
    go("Guided reading")


def open_tool(target):
    state = st.session_state
    origin = state.ui_step
    if origin == "Workspace picker":
        origin = state.workspace_picker_return
    state.nav_panel_open = False
    if origin == target:
        go(target)
        return
    if origin in ("Notes", "Learning Assistant"):
        previous = state.get("paper_tools", {}).get(origin)
        from_queue = origin == "Learning Assistant" and state.get("assistant_picker")
        if not from_queue and previous and previous[1] == target:
            go(target)
            return
    if target == "Guided reading":
        open_workspace_picker(origin, target)
        return
    if origin == "Read paper":
        paper = current_reader_paper(True)
    elif origin == "Guided reading":
        active = state.get("paper_reader", {}).get("paper")
        paper = asdict(active) if active else None
    elif origin == "Learning Assistant":
        paper = current_tool_paper()
    elif origin == "Notes":
        note = state.get("paper_tools", {}).get("Notes")
        paper = note[0] if note else None
    else:
        paper = None
    if paper:
        state.setdefault("paper_tools", {})[target] = (paper, origin)
        if target == "Learning Assistant":
            state.assistant_picker = False
        go(target)
    elif target == "Notes":
        go(target)
    else:
        open_workspace_picker(origin, target)


def current_tool_paper():
    state = st.session_state
    if state.get("assistant_picker"):
        queue = state.study_queues["Learning Assistant"]
        return queue["papers"][queue["index"]]
    return state.paper_tools["Learning Assistant"][0]


def paper_tool_heading(step, paper):
    state = st.session_state
    if step == "Learning Assistant" and state.get("assistant_picker"):
        study_navigation(step)
    else:
        origin = state.paper_tools[step][1]
        if origin == "Workspace picker":
            st.button("← Back to paper picker", on_click=return_to_picker, args=(step,))
        else:
            st.button("← Back", on_click=go, args=(origin,))
    st.button("Choose Paper from Library", on_click=open_workspace_picker, args=(step, step))
    st.subheader(paper["title"])
    workspace_paper_details(paper)
    if paper.get("doi"):
        st.caption(f"DOI · {paper['doi']}")


def page_notes():
    st.title("Notes")
    section = st.radio("Notes section", ("My Notes", "Research Matrix"), horizontal=True,
                       label_visibility="collapsed", key="notes_section")
    if section == "Research Matrix":
        render_research_matrix()
        return
    note = st.session_state.get("paper_tools", {}).get("Notes")
    if note is None:
        st.button("Choose Paper from Library", on_click=open_workspace_picker, args=("Notes", "Notes"))
        return
    paper = note[0]
    paper_tool_heading("Notes", paper)
    reading_workspace(paper, {})


def page_paper_tool(step, ai_key, enabled, model, provider):
    paper = current_tool_paper()
    st.title(step)
    paper_tool_heading(step, paper)
    with st.container(horizontal=True):
        st.button("Knowledge Check", on_click=open_knowledge_check, args=(paper,))
        st.button("Prerequisite Lessons", on_click=open_knowledge_check, args=(paper, True))
    if paper.get("abstract"):
        with st.expander("Paper abstract"):
            st.text(paper["abstract"])
    st.subheader("AI Guided Learning")
    st.write("What question do the authors ask? Which passage describes their method or result?")
    if (paper["id"].startswith("manual:") or paper.get("paper_type") in ("Background article", "Source link")
            or validate_paper_input(paper["title"], paper.get("abstract"))):
        st.caption("Live explanations require a retrieved research record with a usable abstract.")
    else:
        render_ai_guidance(paper, ai_key, enabled, model, provider)


def page_guided_reading(ai_key, enabled, model, provider):
    from screens.paper_reader import render_journal_reader

    journal_header("Guided Reading", "Read closely, make connections, and put ideas into your own words.",
                   "Guided Reading", guided=True)
    if st.session_state.get("guided_picker"):
        study_navigation("Guided reading")
    st.button("Choose Paper from Library", on_click=open_workspace_picker,
              args=("Guided reading", "Guided reading"))
    render_journal_reader(lambda record: render_ai_guidance(record, ai_key, enabled, model, provider))
    if st.session_state.get('guided_picker'):
        return
    if st.session_state.get("manual_picker"):
        st.button("← Back to paper picker", on_click=return_to_picker, args=("Guided reading",))
    elif st.session_state.get('guided_standalone'):
        st.button('← Back to My Library', on_click=go, args=('My Library',))
    elif st.session_state.get('reader_id'):
        st.button('← Back to paper', on_click=go, args=('Read paper',))


def show_source_warnings(papers, *, details=False):
    first=papers[0] if papers else {}
    for notice in getattr(papers,'notices',first.get('search_notices',[])):
        st.warning(notice)
    excluded=[paper for paper in papers if is_retracted_or_notice(paper)]
    if excluded and details:
        st.subheader('Excluded retractions and notices')
        for paper in excluded:
            status='Retracted paper' if paper.get('is_retracted') is True else 'Retraction notice'
            st.warning(f"{status} · {paper['title']}")
    elif excluded:
        st.warning(f'{len(excluded)} retracted papers or notices were excluded. See Sources & transparency.')


def page_sources():
    st.header('Sources & transparency')
    papers=st.session_state.get('papers',[])
    sample_notice(papers)
    st.write('Titles, authors, dates and links come from scholarly source records. The app shows retrieved abstracts and leaves missing metadata unknown.')
    st.caption('Citation counts vary by provider and measure attention. Check the paper’s methods before relying on its findings.')
    if failure:=st.session_state.get('search_failure'):
        query,message=failure
        st.write(f'Latest search · {query}')
        st.error(message)
    if query:=st.session_state.get('searched_query'):
        st.write(f'Search details · {query}')
        if papers and papers[0].get('retrieved_at'):
            st.caption('Originally retrieved · '+papers[0]['retrieved_at'])
        providers=getattr(papers,'sources',papers[0].get('search_sources',[]) if papers else [])
        if providers:
            st.write('Providers that responded · '+', '.join(providers))
        if not papers:
            st.info('This search returned no paper records.')
        show_source_warnings(papers,details=True)
    elif not failure:
        st.info('Search for papers to see which providers responded, search warnings, and records excluded for retraction.')


def render():
    initialize_vault()
    if error:=st.session_state.get('vault_error'):
        st.error(error)
    # Keep editable values when Streamlit removes widgets on inactive steps.
    for key in ('question','query','plan_direction','year_filter','paper_goal','board_mode','map_view','map_topic','gemini_session_key','hf_session_key','ai_provider','ai_guidance_opt_in','workspace_query','library_search','library_sort','library_unassigned'):
        if key in st.session_state:
            st.session_state[key]=st.session_state[key]
    st.session_state.setdefault('ui_step','Question')
    st.session_state.setdefault('nav_panel_open',False)
    st.html(Path(__file__).with_name("workspace.css"))
    with st.container(key="journal_page"):
        ai_key, enabled, provider, model = sidebar()
        if not st.session_state.nav_panel_open:
            render_destination(ai_key, enabled, model, provider)


def render_destination(ai_key, enabled, model, provider):
    step = st.session_state.ui_step
    if step=='Question' or (step=='Direction' and 'discovery_plan' not in st.session_state):
        st.header('Discover Papers')
        page_question(ai_key,enabled,model,provider)
        if 'discovery_plan' in st.session_state:
            st.button('Resume topic exploration', key='rail_Direction', type='tertiary', on_click=go, args=('Direction',))
        if st.session_state.get('papers'):
            st.button('Return to your results', key='rail_Papers', type='tertiary', on_click=go, args=('Papers',))
        with st.expander('Previous research'):
            searches = st.session_state.get('saved_combos', [])
            if searches:
                st.caption(f"{len(searches)} saved · Most recent: {searches[-1]['name']}")
                st.button('Browse saved searches', key='saved_searches', on_click=go, args=('Vault',))
            else:
                st.caption('Searches you save while exploring a question will appear here.')
    elif step=='Direction' and 'discovery_plan' in st.session_state:
        page_direction(secret('OPENALEX_API_KEY'),ai_key,enabled,model,provider)
    elif step=='Papers' and st.session_state.get('papers'):
        if 'discovery_plan' in st.session_state:
            st.button('← Refine this search', key='rail_Direction', type='tertiary', on_click=go,args=('Direction',))
        else:
            st.button('← Discover Papers', type='tertiary', on_click=go, args=('Question',))
        page_papers(ai_key,enabled,model,provider)
    elif step=='Read paper':
        page_reader(ai_key,enabled,model,provider)
    elif step in ('Workspaces', 'Learning Workspace'):
        page_workspaces()
    elif step=='Workspace picker':
        page_workspace_picker()
    elif step=='Knowledge check':
        from screens.knowledge_check import render_knowledge_check
        paper = st.session_state.get('knowledge_check_paper')
        origin = st.session_state.get("knowledge_return")
        if origin:
            st.button("← Back to paper" if origin == "Read paper" else "← Back",
                      on_click=go, args=(origin,))
        render_knowledge_check(paper, lessons_only=st.session_state.get('knowledge_lessons_only', False))
    elif step=='Guided reading':
        page_guided_reading(ai_key,enabled,model,provider)
    elif step == "Notes":
        page_notes()
    elif step == "Learning Assistant":
        page_paper_tool(step, ai_key, enabled, model, provider)
    elif step=='Combo reading':
        page_combo_reading(ai_key,enabled,model,provider)
    elif step=='Vault':
        page_vault()
    elif step in ('My Library','Saved'):
        with st.container(key="library_page", gap="small"):
            render_library(go, open_guided)
    elif step=='Sources':
        page_sources()
    else:
        st.session_state.ui_step='Question'
        st.rerun()
