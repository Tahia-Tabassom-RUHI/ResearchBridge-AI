"""Beginner-first discovery: express a question, choose a direction, open real research."""
import os
from urllib.parse import urlencode
import streamlit as st
from services.papers import DiscoveryError, is_retracted_or_notice, search_papers, safe_url
from services.ranking import query_from_question, suggest_directions, shortlist
from services.discovery_ai import AIUnavailable, DEFAULT_MODEL, DEFAULT_HF_MODEL, guided_plan, interpret_question, explain_abstract
from components.paper_card import paper_card
from components.bubble_board import combination_board
from components.reading_workspace import reading_workspace
from services.demo_map import demo_papers
from screens.paper_reader import load_retrieved_paper, render_paper_reader
from services.ai_explainer import CARD_TITLES, generate_explanations, load_provider_configs
from services.topic_signals import topic_signals, expand_directions_from_sample
from services.background_articles import search_background_articles
from screens.discovery_workspace import render_discovery_workspace, add_to_reading, remove_from_reading, reading_ids
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
    from screens.discovery_workspace import choose_reader
    index=st.session_state.get('active_combo_id')
    combos=st.session_state.get('saved_combos',[])
    if not isinstance(index,int) or index>=len(combos):
        st.session_state.ui_step='Vault'
        st.rerun()
    combo=combos[index]
    st.header(combo['name'])
    with st.container(horizontal=True):
        st.button('← Vault',on_click=go,args=('Vault',))
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
            reading_workspace(paper,{p['id']:p for p in items},st.session_state.get('light_mode',False))

        with coach:
            st.session_state.reader_id=paper['id']
            st.session_state.setdefault('reading_catalog',{})[paper['id']]=paper
            page_reader(ai_key,enabled,model,provider)
        with foundations:
            from screens.knowledge_check import render_knowledge_check
            render_knowledge_check()


def page_vault():
    st.header('Vault')
    combos=st.session_state.get('saved_combos',[])
    if not combos:
        st.caption('No saved combinations.')
        return
    rows=[{'Combination':c['name'],'Topics':' + '.join(c.get('selected',[])),
        'Results':len(c.get('papers',[])), 'Reading list':len(c.get('reading_ids',[]))} for c in combos]
    import streamlit.components.v1 as components
    from pathlib import Path
    table=components.declare_component('vault_double_click',path=str(Path(__file__).resolve().parents[1]/'components'/'vault_table'))
    event=table(rows=rows,light=st.session_state.get('light_mode',False),key='vault_table',default=None)
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
            st.button('Open study set',on_click=open_combo_reading,args=(index,),key='vault_open')
            with st.popover('Rename'):
                st.text_input('Name',value=combos[index]['name'],key=f'combo_name_{index}',max_chars=75)
                st.button('Save',on_click=rename_combo,args=(index,))
            st.button('Remove',on_click=remove_combo,args=(index,))
    if st.session_state.get('deleted_combo'):
        st.button('Undo remove',on_click=undo_remove_combo)


STEPS = ['Question', 'Direction', 'Papers', 'Saved', 'Sources']


def go(step):
    st.session_state.ui_step=step


def open_nav(step):
    st.session_state.nav_panel_open=step in ('Settings',) and not (st.session_state.get('nav_panel_open') and st.session_state.get('nav_panel_step')==step)
    st.session_state.nav_panel_step=step
    if step in STEPS or step=='Vault':
        st.session_state.ui_step=step


def close_nav():
    st.session_state.nav_panel_open=False


def toggle_theme():
    st.session_state.light_mode=not st.session_state.get('light_mode',False)
    persist_vault()


def sidebar():
    st.session_state.setdefault('nav_panel_open',False)
    st.session_state.setdefault('nav_panel_step','Question')
    with st.sidebar:
        st.subheader('ResearchBridge')
        for name,label in (
            ('Question','Research question'),('Direction','Search topics'),('Papers','Paper results'),
            ('Vault','Vault · Study sets'),('Sources','Sources & transparency'),
        ):
            st.button(label,key='rail_'+name,width='stretch',
                type='primary' if st.session_state.ui_step==name else 'secondary',
                disabled=(name=='Papers' and not st.session_state.get('papers'))
                    or (name=='Direction' and 'discovery_plan' not in st.session_state),
                on_click=open_nav,args=(name,))
        st.button('Settings',key='rail_Settings',width='stretch',
            on_click=open_nav,args=('Settings',))
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
                st.button('Knowledge check & learning cards',on_click=go,args=('Knowledge check',))
                st.button('Guided reader · paste an abstract',on_click=go,args=('Guided reading',))
            st.toggle('Light mode',key='light_mode',on_change=persist_vault)
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
    for key in ('map_selected','reader_id','abstract_help','plan_direction','search_failure'):
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
        for name in ('plan_direction','papers','weights','searched_query','selected_paper','abstract_help','map_selected','reader_id','search_failure'):
            st.session_state.pop(name,None)
        st.rerun()


def page_direction(openalex_key,ai_key='',enabled=False,model='',provider='huggingface'):
    plan=st.session_state.discovery_plan
    st.header('Topic workspace')
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
        st.button('Save study set',key='save_combo',on_click=save_current_combo,
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


def page_reader(ai_key,enabled,model,provider):
    paper=next((p for p in st.session_state.get('papers',[]) if p['id']==st.session_state.get('reader_id')),None)
    if paper is None:
        paper=st.session_state.get('saved_papers',{}).get(st.session_state.get('reader_id'))
    if paper is None:
        paper=st.session_state.get('reading_catalog',{}).get(st.session_state.get('reader_id'))
    if paper is None:
        st.info('Choose a paper from your results or reading tray.')
        st.button('Back to papers',on_click=go,args=('Papers',))
        return
    is_background=paper.get('paper_type')=='Background article'
    is_source_link=paper.get('paper_type')=='Source link'
    st.button('← Back to papers',on_click=go,args=('Papers',))
    st.subheader(paper['title'])
    st.caption(' · '.join(filter(None,[paper.get('publication_date'),paper.get('source_name')])))
    if is_background:
        st.caption('Text: Wikipedia contributors · CC BY-SA 4.0. Original page links to its authors and history.')
    workspace_tab,abstract_tab,help_tab,details_tab,source_tab=st.tabs(
        ['Workspace','Abstract','Simple explanation','Source details','Original page'])
    with workspace_tab:
        st.caption(('Read this background article, group items, connect notes, and draw.' if is_background else
            'Read the retrieved abstract, group saved items, connect notes, and draw. The full paper opens at its source.'))
        reading_workspace(paper,st.session_state.get('saved_papers',{}),st.session_state.get('light_mode',False))
    with abstract_tab:
        st.caption('Background article text; use research records for evidence.' if is_background else
            'Retrieved abstract only; the full paper has not been reviewed.')
        with st.container(height=330,border=True):
            st.write(paper.get('abstract') or 'Abstract unavailable. Open the original source to inspect the paper.')
    with help_tab:
        configs=coach_configs()
        team_ai_ready=any(config.free_plan_confirmed for config in configs)
        if is_background or is_source_link:
            st.info('This item helps you explore. The research paper explanation is available on research records.')
        else:
          if paper.get('abstract'):
            st.caption('Free reading guide · based on the abstract text')
            for prompt in ('What question are the authors investigating?', 'How did they study it?', 'Which result is actually stated?'):
                st.write('• '+prompt)
            st.caption('Use “Learn this paper” below to save your own answers.')
          if not paper.get('abstract'):
            st.info('An abstract is needed before we can explain it.')
          elif not team_ai_ready and (not enabled or not ai_key):
            st.caption('For an AI explanation, add a free provider token in the sidebar.')
          elif st.button('Explain this abstract simply',key='explain_'+paper['id']):
            if team_ai_ready:
                try:
                    with st.spinner('Checking the abstract with Learning Coach…'):
                        generated=generate_explanations(paper['title'],paper['abstract'],configs,
                            session_usage=st.session_state.setdefault('coach_usage',{}))
                    if generated.pack:
                        st.session_state.abstract_help={'paper_id':paper['id'],'source':'learning_coach','result':generated.pack}
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
                        st.session_state.abstract_help={'paper_id':paper['id'],'source':provider,'result':result}
                except AIUnavailable as exc:
                    st.warning(str(exc))
          help_result=st.session_state.get('abstract_help')
          if help_result and help_result['paper_id']==paper['id']:
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
    with details_tab:
        with st.container(height=330,border=True):
            st.write('**Authors:** '+(', '.join(paper.get('authors') or []) or 'Unavailable'))
            st.write('**Record source:** '+paper.get('provenance',{}).get('source','Unknown'))
            st.write('**Type:** '+(paper.get('paper_type') or 'Unknown'))
            st.caption('Originally retrieved: '+paper.get('retrieved_at','Unknown'))
            st.caption('Publication type does not establish peer review. Relevance is not a quality assessment.')
    with source_tab:
        source_url=safe_url(paper.get('oa_url')) or safe_url(paper.get('paper_url'))
        if source_url:
            st.caption('View the original page here when the publisher allows it. If it appears blank, use the link below.')
            st.iframe(source_url,height=610)
            st.link_button('Open original in a new tab ↗',source_url)
        else:
            st.info('This source record did not provide a usable original-page link.')
    actions=st.columns(3)
    if paper.get('paper_url'):
        actions[0].link_button('Original source ↗',paper['paper_url'],width='stretch')
    if paper.get('oa_url'):
        actions[1].link_button('Free text ↗',paper['oa_url'],width='stretch')
    added=paper['id'] in reading_ids()
    if actions[2].button('Remove from list' if added else 'Add to reading list',
            key='reader_save_'+paper['id'],width='stretch'):
        remove_from_reading(paper) if added else add_to_reading(paper)
        st.rerun()
    if not (is_background or is_source_link) and st.button('Learn this paper →',key='learn_'+paper['id']):
        st.session_state.selected_paper=paper
        try:
            load_retrieved_paper(paper)
            st.session_state.ui_step='Guided reading'
            st.rerun()
        except ValueError:
            st.info('This record needs a longer abstract for guided reading. You can still open the original source.')


def page_guided_reading():
    st.button('← Back to paper',on_click=go,args=('Read paper',))
    render_paper_reader()


def page_saved():
    st.header('Your reading tray')
    saved=list(st.session_state.get('saved_papers',{}).values())
    if not saved:
        st.info('Add an item from your results and it will be waiting here in your saved vault.')
        return
    maximum=max((len(saved)+2)//3,1)
    if 'saved_page' in st.session_state:
        st.session_state.saved_page=min(st.session_state.saved_page,maximum)
    page=st.number_input('Page',1,maximum,1,key='saved_page')
    for paper in saved[(page-1)*3:page*3]:
        paper_card(paper,st.session_state.get('weights',{}),key_prefix='tray_',compact=True)


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
    for key in ('question','query','plan_direction','year_filter','paper_goal','board_mode','map_view','map_topic','gemini_session_key','hf_session_key','ai_provider','ai_guidance_opt_in','light_mode'):
        if key in st.session_state:
            st.session_state[key]=st.session_state[key]
    st.session_state.setdefault('ui_step','Question')
    st.session_state.setdefault('nav_panel_open',False)
    light=st.session_state.get('light_mode',False)
    rail_bg='#dff1f3' if light else '#081c29'
    page_bg='#f8fcfd' if light else '#0b1721'
    foreground='#173946' if light else '#e7f3f4'
    line='#b5d9dc' if light else '#2c6671'
    st.markdown(f'''<style>
      [data-testid="stAppViewContainer"], [data-testid="stMain"], [data-testid="stHeader"] {{background:{page_bg}!important; color:{foreground}!important;}}
      [data-testid="stSidebar"] {{background:{rail_bg}; border-right:1px solid {line};}}
      [data-testid="stSidebar"] button {{min-height:2.75rem; text-align:left;}}
      [data-testid="stSidebar"] button p {{font-size:1rem; overflow-wrap:anywhere;}}
      .st-key-nav_panel {{max-width:44rem; padding:1rem;}}
      .block-container {{padding-top:3rem; padding-bottom:2rem; max-width:90rem;}}
      [data-testid="stMain"] p, [data-testid="stPopoverBody"] p {{font-size:1rem; line-height:1.5;}}
      [data-testid="stMain"] :is(input, textarea), [data-testid="stPopoverBody"] :is(input,textarea) {{font-size:1rem;}}
      [data-testid="stPopoverBody"] {{max-width:min(28rem, 94vw);}}
      .st-key-topic_tools {{border-bottom:1px solid {line}; padding-bottom:.75rem;}}
      [data-testid="stMain"] button:focus-visible, [data-testid="stSidebar"] button:focus-visible {{
        outline:2px solid {foreground}; outline-offset:2px;
      }}
      @media (max-width:700px) {{
        .block-container {{padding:3rem 1rem 1.5rem;}}
        .st-key-nav_panel {{padding:.75rem;}}
      }}
    </style>''',unsafe_allow_html=True)
    if light:
        st.markdown('''<style>
        [data-testid="stMain"] p, [data-testid="stMain"] h1, [data-testid="stMain"] h2, [data-testid="stMain"] h3,
        [data-testid="stMain"] label, [data-testid="stSidebar"] :is(p,h3) {color:#173946!important;}
        [data-testid="stMain"] input, [data-testid="stMain"] textarea,
        [data-testid="stMain"] [data-baseweb="select"] > div {background:#fff!important;color:#173946!important;border-color:#bad8dc!important;}
        [data-testid="stMain"] button:not([kind="primary"]), [data-testid="stSidebar"] button:not([kind="primary"]) {background:#fff!important;color:#174a59!important;border-color:#bad8dc!important;}
        [data-testid="stMain"] [data-testid="stVerticalBlockBorderWrapper"] {border-color:#c5e0e3!important;}
        </style>''',unsafe_allow_html=True)
    ai_key,enabled,provider,model=sidebar()
    step=st.session_state.ui_step
    if step=='Question' or (step=='Direction' and 'discovery_plan' not in st.session_state):
        st.header('Research question')
        page_question(ai_key,enabled,model,provider)
    elif step=='Direction' and 'discovery_plan' in st.session_state:
        page_direction(secret('OPENALEX_API_KEY'),ai_key,enabled,model,provider)
    elif step=='Papers' and st.session_state.get('papers'):
        page_papers(ai_key,enabled,model,provider)
    elif step=='Read paper':
        page_reader(ai_key,enabled,model,provider)
    elif step=='Knowledge check':
        from screens.knowledge_check import render_knowledge_check
        render_knowledge_check()
    elif step=='Guided reading':
        page_guided_reading()
    elif step=='Combo reading':
        page_combo_reading(ai_key,enabled,model,provider)
    elif step=='Vault':
        page_vault()
    elif step=='Saved':
        page_saved()
    elif step=='Sources':
        page_sources()
    else:
        st.session_state.ui_step='Question'
        st.rerun()
