"""Beginner-first discovery: express a question, choose a direction, open real research."""
import os
import streamlit as st
from services.papers import DiscoveryError, search_papers
from services.ranking import query_from_question, suggest_directions, starter_directions, shortlist
from services.discovery_ai import AIUnavailable, DEFAULT_MODEL, guided_plan, interpret_question, explain_abstract
from components.paper_card import paper_card
from components.bubble_board import bubble_board
from screens.research_insights import render_insights
from services.demo_map import demo_papers

EXAMPLES = ['How long can a banana and apple smoothie stay in the fridge?',
    'Could my phone help me tell when a plant is getting sick?', 'Why do I forget things I studied yesterday?']


def secret(name, default=''):
    value=os.getenv(name,default)
    try:
        return st.secrets.get(name,value)
    except st.errors.StreamlitSecretNotFoundError:
        return value


@st.cache_data(ttl=900, show_spinner=False, max_entries=40)
def retrieve(query, year, key, extra_queries=()):
    return search_papers(query,year,key,extra_queries)


def forget_session_key():
    st.session_state.gemini_session_key=''
    st.session_state.ai_enabled=False


def change_direction():
    directions=st.session_state.discovery_plan['directions']
    choice=st.session_state.plan_direction
    st.session_state.query=next(d['query'] for d in directions if d['label']==choice)


def load_results(query, year_value, year_label, openalex_key, extra_queries=()):
    with st.spinner('Finding real papers and checking their source records…'):
        papers=retrieve(query,year_value,openalex_key,extra_queries)
    st.session_state.papers=papers
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
    return papers


STEPS = ['Question', 'Direction', 'Papers', 'Bubble map', 'Saved', 'Sources']


def go(step):
    st.session_state.ui_step=step


def sidebar():
    with st.sidebar:
        st.title('ResearchBridge AI')
        st.caption('A little curiosity goes a long way.')
        st.markdown('**YOUR WORKSPACE**')
        ready={'Question':True,'Direction':'discovery_plan' in st.session_state,
            'Papers':bool(st.session_state.get('papers')),'Bubble map':bool(st.session_state.get('papers')),
            'Saved':True,'Sources':bool(st.session_state.get('papers'))}
        current=st.session_state.ui_step
        for i,name in enumerate(STEPS):
            suffix=f" · {len(st.session_state.get('saved_papers',{}))}" if name=='Saved' else ''
            st.button(f'{i+1:02d}  {name}{suffix}',key='nav_'+name,width='stretch',
                type='primary' if current==name else 'secondary',disabled=not ready[name],on_click=go,args=(name,))
        st.divider()
        topic=st.session_state.get('topic') or st.session_state.get('searched_query')
        if topic:
            st.caption('YOUR QUESTION')
            st.write(topic[:180])
        configured=secret('GEMINI_API_KEY')
        with st.expander('AI & connection settings'):
            if configured:
                st.caption('A key is configured privately on the server.')
            session_key=st.text_input('Gemini key (optional, this session only)',type='password',key='gemini_session_key')
            ai_key=session_key or configured
            enabled=st.checkbox('Use live AI guidance',value=bool(ai_key),key='ai_enabled')
            st.link_button('Get a Gemini API key ↗','https://aistudio.google.com/api-keys')
            st.caption('Free-tier content may help improve Google’s products. Use public study questions. Search also works without AI.')
            st.button('Forget session key',on_click=forget_session_key)
        st.caption('AI guidance: '+('on' if enabled and ai_key else 'off · guided search ready'))
        with st.expander('Rehearsal & example tools'):
            if st.button('Try an example research map',key='try_map_demo'):
                install_search(demo_papers(),'Illustrative research-map demo','Illustrative years','Bubble map')
                st.session_state.board_mode='Explore research activity'
                st.rerun()
            from services.rehearsal import saved_searches
            for item in saved_searches():
                if st.button('Load saved real search: '+item['label'],key='saved_'+item['label']):
                    install_search(item['papers'],item['query'],'Saved search; original timestamps preserved','Papers')
                    st.rerun()
        st.caption('Use the arrow at the top of this panel to tuck it away while you read.')
    return ai_key, enabled


def install_search(papers,query,year,step):
    st.session_state.update(papers=papers,query=query,discovery_plan=guided_plan(query),
        weights={term:1 for term in suggest_directions(papers)},searched_query=query,
        searched_year=year,ui_step=step,result_page=0)
    for key in ('map_selected','reader_id','abstract_help'):
        st.session_state.pop(key,None)


def choose_example(question):
    st.session_state.question=question


def page_question(ai_key,enabled,model):
    st.header('What are you curious about?')
    st.write('Start in your own words. We’ll find the research direction together.')
    question=st.text_area('What are you wondering about?',key='question',height=140,
        placeholder='For example: I keep forgetting what I studied. What could help?',max_chars=700)
    if st.button('Turn my question into a search →',type='primary',disabled=not question.strip()):
        plan=guided_plan(question)
        if enabled:
            try:
                with st.spinner('Finding possible research directions…'):
                    plan=interpret_question(question,ai_key,model)
            except AIUnavailable as exc:
                st.session_state.ai_notice=str(exc)
        st.session_state.update(topic=question,research_goal='Help me start',discovery_plan=plan,
            query=plan['directions'][0]['query'],ui_step='Direction',result_page=0)
        for name in ('plan_direction','papers','weights','searched_query','selected_paper','abstract_help','map_selected','reader_id'):
            st.session_state.pop(name,None)
        st.rerun()
    with st.expander('Need a starting point?'):
        for i,example in enumerate(EXAMPLES):
            st.button(example,key=f'example_{i}',on_click=choose_example,args=(example,))
    st.info('One step at a time: your question → a direction → a few real papers.')


def page_direction(openalex_key):
    plan=st.session_state.discovery_plan
    st.header('Am I understanding you?')
    st.write(plan['understanding'])
    if st.session_state.pop('ai_notice',None):
        st.warning('Live AI was unavailable. You can still edit and search this direction.')
    st.caption(plan['origin'])
    choices=list(dict.fromkeys(d['label'] for d in plan['directions']))
    if len(choices)>1:
        st.radio(plan['clarifying_question'],choices,key='plan_direction',on_change=change_direction)
    left,right=st.columns([3,2])
    with left:
        query=st.text_input('Search wording — you are in control',key='query',max_chars=500)
    with right:
        year=st.selectbox('Publication window',['Any year','Since 2024','Since 2020','Since 2015'],key='year_filter')
    if plan['concepts']:
        with st.expander('Meet a few useful research words'):
            st.caption('General background to help you search.')
            for concept in plan['concepts']:
                st.write('**'+concept['term']+'** — '+concept['meaning'])
    if st.button('Find real papers →',type='primary',disabled=not query.strip()):
        try:
            papers=load_results(query,None if year=='Any year' else int(year[-4:]),year,openalex_key)
            if papers:
                st.session_state.ui_step='Papers'
                st.session_state.result_page=0
                st.rerun()
            else:
                st.warning('No records found. Try a shorter phrase, a different direction, or Any year.')
        except DiscoveryError as exc:
            st.error(str(exc))


def sample_notice(papers):
    if any(p.get('provenance',{}).get('source')=='Illustrative interface demo' for p in papers):
        st.warning('Example data: invented records for trying the interface.')
    elif any(p.get('rehearsal_snapshot') for p in papers):
        st.info('Saved real-paper search for rehearsal · original timestamps preserved')


def page_papers():
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


def page_reader(ai_key,enabled,model):
    paper=next((p for p in st.session_state.get('papers',[]) if p['id']==st.session_state.get('reader_id')),None)
    if paper is None:
        paper=st.session_state.get('saved_papers',{}).get(st.session_state.get('reader_id'))
    if paper is None:
        st.info('Choose a paper from your results or reading tray.')
        st.button('Back to papers',on_click=go,args=('Papers',))
        return
    st.button('← Back to papers',on_click=go,args=('Papers',))
    st.subheader(paper['title'])
    st.caption(' · '.join(filter(None,[paper.get('publication_date'),paper.get('source_name')])))
    abstract_tab,help_tab,details_tab=st.tabs(['Abstract','Simple explanation','Source details'])
    with abstract_tab:
        st.caption('Retrieved abstract only; the full paper has not been reviewed.')
        with st.container(height=330,border=True):
            st.write(paper.get('abstract') or 'Abstract unavailable. Open the original source to inspect the paper.')
    with help_tab:
        if not enabled or not ai_key:
            st.info('Enable live AI in the sidebar settings for a simple explanation. You can read the source abstract now.')
        elif not paper.get('abstract'):
            st.info('An abstract is needed before we can explain it.')
        elif st.button('Explain this abstract simply',key='explain_'+paper['id']):
            try:
                with st.spinner('Explaining the abstract with its source passage…'):
                    result=explain_abstract(paper,st.session_state.get('topic',''),ai_key,model)
                st.session_state.abstract_help={'paper_id':paper['id'],'result':result}
            except AIUnavailable as exc:
                st.warning(str(exc))
        help_result=st.session_state.get('abstract_help')
        if help_result and help_result['paper_id']==paper['id']:
            with st.container(height=330,border=True):
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
    actions=st.columns(3)
    if paper.get('paper_url'):
        actions[0].link_button('Original source ↗',paper['paper_url'],width='stretch')
    if paper.get('oa_url'):
        actions[1].link_button('Free text ↗',paper['oa_url'],width='stretch')
    saved=st.session_state.setdefault('saved_papers',{})
    if actions[2].button('Remove saved' if paper['id'] in saved else 'Save for later',key='reader_save_'+paper['id'],width='stretch'):
        if paper['id'] in saved:
            del saved[paper['id']]
        else:
            saved[paper['id']]=paper
        st.rerun()
    if st.button('Learn this paper →',key='learn_'+paper['id']):
        st.session_state.selected_paper=paper
        st.info('Selected for Ru’s learning coach. The classroom connection is the next integration step.')


def page_map(openalex_key):
    papers=st.session_state.papers
    st.header('Shape your research direction')
    sample_notice(papers)
    weights=st.session_state.weights
    board_mode=st.radio('Use the bubble board to…',['Set my interests','Explore research activity'],horizontal=True,key='board_mode')
    if board_mode=='Explore research activity':
        render_insights(papers,weights)
        return
    st.caption('Tap to cycle Explore → Important → Main focus → Set aside. Size means your interest.')
    bubble_board(weights)
    with st.expander('Add a direction'):
        with st.form('add_direction',clear_on_submit=True):
            term=st.text_input('Missing a direction? Add your own term',max_chars=70)
            if st.form_submit_button('Add a bubble') and term.strip() and term.strip().casefold() not in [t.casefold() for t in weights]:
                if len(weights)<12:
                    weights[term.strip()]=1
                    st.rerun()
                else:
                    st.warning('Keep the board to 12 directions for now.')
    if st.button('Find more papers with my focus',key='search_focus',type='primary'):
        focus=[term for term,w in sorted(weights.items(),key=lambda item:-item[1]) if w>=2][:2]
        query=st.session_state.query
        year=st.session_state.get('year_filter','Any year')
        try:
            found=load_results(query,None if year=='Any year' else int(year[-4:]),year,openalex_key,(query+' '+' '.join(focus),) if focus else ())
            if found:
                st.session_state.ui_step='Papers'
                st.session_state.result_page=0
                st.rerun()
            st.warning('No matching records. Try another direction.')
        except DiscoveryError as exc:
            st.error(str(exc))


def page_saved():
    st.header('Your reading tray')
    saved=list(st.session_state.get('saved_papers',{}).values())
    if not saved:
        st.info('Save a paper from your results and it will be waiting here. Saved for this session only.')
        return
    maximum=max((len(saved)+2)//3,1)
    if 'saved_page' in st.session_state:
        st.session_state.saved_page=min(st.session_state.saved_page,maximum)
    page=st.number_input('Page',1,maximum,1,key='saved_page')
    for paper in saved[(page-1)*3:page*3]:
        paper_card(paper,st.session_state.get('weights',{}),key_prefix='tray_',compact=True)


def page_sources():
    st.header('Sources & what we could check')
    papers=st.session_state.papers
    sample_notice(papers)
    st.write('Titles, authors, dates and links come from scholarly source records. Abstracts are not full papers; missing metadata stays unknown.')
    st.write('Search: '+st.session_state.searched_query)
    st.caption('Originally retrieved: '+papers[0]['retrieved_at'])
    st.caption('Citation counts have different coverage between providers. Counts do not establish scientific agreement.')
    for notice in papers[0].get('search_notices',[]):
        st.info(notice)
    retracted=[p['title'] for p in papers if p.get('is_retracted')]
    if retracted:
        with st.expander('Excluded retracted records'):
            for title in retracted:
                st.warning(title)


def render():
    # Keep editable values when Streamlit removes widgets on inactive steps.
    for key in ('question','query','plan_direction','year_filter','paper_goal','board_mode','map_view','map_topic','gemini_session_key','ai_enabled'):
        if key in st.session_state:
            st.session_state[key]=st.session_state[key]
    st.session_state.setdefault('ui_step','Question')
    st.markdown('''<style>
      .block-container {padding-top:3.5rem; padding-bottom:1.2rem; max-width:1160px;}
      [data-testid="stSidebar"] button {min-height:44px;}
      [data-testid="stSidebarCollapseButton"] {display:flex!important;opacity:1!important;visibility:visible!important;}
      [data-testid="stMain"] button {min-height:44px;}
      h1 {font-size:1.65rem!important;} h2 {font-size:1.8rem!important;}
      .st-key-packed_board {max-width:440px!important;}
      @media (max-width:640px) {.block-container {padding:1rem;} h2 {font-size:1.4rem!important;}}
    </style>''',unsafe_allow_html=True)
    ai_key,enabled=sidebar()
    step=st.session_state.ui_step
    st.caption('YOUR WORKSPACE / '+step.upper())
    if step=='Question':
        page_question(ai_key,enabled,secret('GEMINI_MODEL',DEFAULT_MODEL))
    elif step=='Direction' and 'discovery_plan' in st.session_state:
        page_direction(secret('OPENALEX_API_KEY'))
    elif step=='Papers' and st.session_state.get('papers'):
        page_papers()
    elif step=='Read paper':
        page_reader(ai_key,enabled,secret('GEMINI_MODEL',DEFAULT_MODEL))
    elif step=='Bubble map' and st.session_state.get('papers'):
        page_map(secret('OPENALEX_API_KEY'))
    elif step=='Saved':
        page_saved()
    elif step=='Sources' and st.session_state.get('papers'):
        page_sources()
    else:
        st.session_state.ui_step='Question'
        st.rerun()
