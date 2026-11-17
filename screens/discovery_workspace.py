"""Explore source-backed material with a bubble lens and a linked reading list."""
import re
import streamlit as st
from components.bubble_board import bubble_board
from services.papers import safe_url
from services.ranking import matches, shortlist, relevance_details
from services.research_map import VIEWS, map_data
from services.background_articles import article_full_text
from services.vault_session import persist_vault


LENSES={
    'Topics':'Topic volume', 'Authors':'Authors', 'Countries':'Countries',
    'Institutions':'Institutions', 'Venues':'Publication venues',
    'Citations':'Citation attention', 'Reviews':'Reviews', 'Years':'Publication years',
}
TYPES=['All','Papers & reports','Reviews','Background articles','Source links','My reading list']


def source_links(papers):
    links=[]
    for paper in papers:
        if paper.get('is_retracted') is True:
            continue
        for kind,url in [('Original source',paper.get('paper_url')),('Free text',paper.get('oa_url'))]:
            url=safe_url(url)
            if not url or any(item['paper_url']==url for item in links):
                continue
            links.append({**paper,'id':paper['id']+'::'+kind,'title':kind+': '+paper['title'],
                'paper_type':'Source link','paper_url':url,'oa_url':url,'parent_id':paper['id'],
                'abstract':paper.get('abstract')})
    return links


def reading_ids():
    active=st.session_state.get('active_combo_id')
    combos=st.session_state.get('saved_combos',[])
    if isinstance(active,int) and 0<=active<len(combos):
        return combos[active].setdefault('reading_ids',[])
    return st.session_state.setdefault('loose_reading_ids',[])


def add_to_reading(item):
    ids=reading_ids()
    if item['id'] not in ids:
        ids.append(item['id'])
    st.session_state.setdefault('saved_papers',{})[item['id']]=item
    persist_vault()


def remove_from_reading(item):
    ids=reading_ids()
    if item['id'] in ids:
        ids.remove(item['id'])
    elsewhere=any(item['id'] in combo.get('reading_ids',[])
        for combo in st.session_state.get('saved_combos',[])) or item['id'] in st.session_state.get('loose_reading_ids',[])
    if not elsewhere:
        st.session_state.get('saved_papers',{}).pop(item['id'],None)
    persist_vault()


def choose_reader(item):
    st.session_state.setdefault('reading_catalog',{})[item['id']]=item
    st.session_state.reader_id=item['id']
    st.session_state.ui_step='Read paper'
    st.session_state.nav_panel_open=False


def open_reader(item):
    choose_reader(item)
    st.rerun()


@st.dialog('Quick preview',width='large')
def quick_preview(item):
    st.subheader(item['title'])
    st.caption(' · '.join(filter(None,[item.get('paper_type'),item.get('source_name'),item.get('publication_date')])))
    content=item.get('abstract')
    if item.get('paper_type')=='Background article':
        try:
            with st.spinner('Opening article text…'):
                content=full_article(item['title']) or content
        except Exception:
            pass
    expanded={**item,'abstract':content}
    with st.container(height=350,border=True):
        st.write(content or 'No preview text came with this source. Open its original page to inspect it.')
    if item.get('paper_type')=='Background article':
        st.caption('Text: Wikipedia contributors · CC BY-SA 4.0. Open the original page for authors and history.')
    else:
        st.caption('This preview shows the retrieved abstract, not the complete paper.')
    url=safe_url(item.get('paper_url'))
    left,right=st.columns(2)
    if url:
        left.link_button('Original page ↗',url,width='stretch')
    right.button('Open reading mode ⤢',key='preview_read',type='primary',width='stretch',
        on_click=choose_reader,args=(expanded,))


@st.cache_data(ttl=1800,show_spinner=False,max_entries=40)
def full_article(title):
    return article_full_text(title)


def short_explanation(item):
    abstract=item.get('abstract') or ''
    if not abstract:
        return 'No summary text was supplied by the source. Use Preview or open the original page.'
    sentences=re.split(r'(?<=[.!?])\s+',abstract.strip())
    return ' '.join(sentences[:2])[:520]


def item_card(item,index,query,on_explain=None):
    source=item.get('provenance',{}).get('source','Source')
    with st.container(border=True):
        meta=list(filter(None,[item.get('paper_type') or 'Research record',source,item.get('publication_date')]))
        if item.get('paper_type') not in ('Background article','Source link'):
            if isinstance(item.get('cited_by_count'),int):
                meta.append(f"{item['cited_by_count']} citations reported")
            if item.get('oa_url'):
                meta.append('free text link')
        st.caption(' · '.join(meta))
        st.markdown('**'+item['title']+'**')
        if item.get('paper_type')=='Background article':
            st.caption('A starting explanation from Wikipedia, not research evidence.')
        elif item.get('paper_type')=='Source link':
            st.caption('Opens an original page linked to a research record.')
        else:
            _,hits=relevance_details(item,query)
            st.caption(('Matches your words: '+', '.join(hits[:5])) if hits else
                'A broader result. Check the abstract to decide if it fits.')
        actions=st.container(horizontal=True,gap='small')
        added=item['id'] in reading_ids()
        if actions.button('− Remove' if added else '＋ Add',key=f'reading_add_{index}',
                help='Remove from this combination’s reading list' if added else 'Add to this combination’s reading list',width='content'):
            remove_from_reading(item) if added else add_to_reading(item)
            st.rerun()
        if actions.button('▾ About',key=f'reading_about_{index}',width='content'):
            current=st.session_state.get('expanded_reading_id')
            st.session_state.expanded_reading_id=None if current==item['id'] else item['id']
            st.rerun()
        if actions.button('◉ Preview',key=f'reading_preview_{index}',width='content'):
            quick_preview(item)
        if item['id']==st.session_state.get('expanded_reading_id'):
            st.write(short_explanation(item))
            st.caption('From the retrieved abstract or article introduction. Open Preview to read more.')
            if on_explain and item.get('abstract') and item.get('paper_type') not in ('Background article','Source link'):
                if st.button('Explain simply with AI',key=f'reading_explain_{index}'):
                    with st.spinner('Checking the source text…'):
                        result=on_explain(item)
                    if result:
                        st.session_state.setdefault('reading_explanations',{})[item['id']]=result
                result=st.session_state.get('reading_explanations',{}).get(item['id'])
                if result:
                    st.write(result['simple'])
                    st.caption('From abstract: '+result['excerpt'])
        if item['id'] in reading_ids():
            st.caption('✓ In this combo’s reading list')


def render_discovery_workspace(papers,articles,query,weights,on_explain=None):
    st.header('Research workspace')
    left,right=st.columns([5,7],gap='medium')
    with left:
        kind=st.selectbox('Type',TYPES,key='reading_type')
        st.caption('GROUP RESULTS BY')
        label=st.selectbox('Lens',list(LENSES),key='bubble_lens',label_visibility='collapsed')
        view=LENSES[label]
        st.session_state.map_view=view
        data=map_data(papers,view)
        positive={key:item for key,item in data['groups'].items() if item['value']>0}
        by_id={paper['id']:paper for paper in data['records']}
        recurring=[(key,item) for key,item in positive.items() if item['value']>=2]
        candidates=recurring if view=='Topic volume' and recurring else list(positive.items())
        shown={key:{**item,'unit':'citations' if view=='Citation attention' else 'papers','relevance':sum(relevance_details(by_id[paper_id],query)[0]
            for paper_id in item['paper_ids'] if paper_id in by_id)/max(len(item['paper_ids']),1)}
            for key,item in candidates[:10]}
        signature=(query,view)
        if st.session_state.get('map_signature')!=signature:
            st.session_state.pop('map_selected',None)
            st.session_state.map_signature=signature
        if shown:
            selected=bubble_board({key:1 for key in shown},metrics=shown,namespace='result_bubbles')
            if selected:
                st.session_state.map_selected=selected
        else:
            st.info('No matching source metadata for this lens. Try another.')
        key=st.session_state.get('map_selected')
        if key in data['groups']:
            item=data['groups'][key]
            st.caption(f"{item['label']} · {len(item['paper_ids'])} matching papers")
            if st.button('Show all results',key='clear_map_selection'):
                st.session_state.pop('map_selected',None)
                st.rerun()
        with st.popover('ⓘ Map',width='content'):
            st.write(VIEWS[view])
            st.caption('Size follows the displayed count. Teal means the supporting records match more of your search words; purple is a looser wording match. Neither measures trust or scientific agreement.')
            if data['missing']:
                st.caption(f"{data['missing']} records lack metadata for this view.")
    with right:
        order=st.selectbox('Order',['Start here','Best match','Newest','Free text'],key='result_order')
        valid=[p for p in papers if p.get('is_retracted') is not True]
        goal={'Start here':'Help me start','Best match':'Best matches',
            'Newest':'Recent research','Free text':'Free to read'}[order]
        ranked=shortlist(valid,query,weights,goal)
        with st.popover('ⓘ Guide',width='content'):
            if articles:
                st.write('**Learn the words:** '+articles[0]['title'])
            review=next((paper for paper in ranked if paper.get('paper_type')=='review'),None)
            if review:
                st.write('**See an overview:** '+review['title'])
            study=next((paper for paper in ranked if paper.get('paper_type')!='review'),None)
            if study:
                st.write('**Inspect a study:** '+study['title'])
            st.caption('Check the original source and its methods before trusting a claim. Citation counts show attention, not correctness.')
        links=source_links(ranked)
        if kind=='Papers & reports':
            items=[p for p in ranked if p.get('paper_type')!='review']
        elif kind=='Reviews':
            items=[p for p in ranked if p.get('paper_type')=='review']
        elif kind=='Background articles':
            items=articles
        elif kind=='Source links':
            items=links
        elif kind=='My reading list':
            ids=reading_ids()
            all_items=[*ranked,*articles,*links]
            by_item_id={**st.session_state.get('saved_papers',{}),
                **{item['id']:item for item in all_items}}
            items=[by_item_id[item_id] for item_id in ids if item_id in by_item_id]
        else:
            items=[*ranked[:2],*articles[:1],*links[:1],*ranked[2:],*articles[1:4],*links[1:3]]
        key=st.session_state.get('map_selected')
        if key in data['groups']:
            paper_ids=set(data['groups'][key]['paper_ids'])
            items=[item for item in items if item.get('parent_id',item['id']) in paper_ids or
                (view=='Topic volume' and matches(item,data['groups'][key]['label']))]
        st.caption(f'{len(items)} results')
        if not items:
            st.info('No items in this view. Try another type or bubble.')
            return
        page=min(st.session_state.get('reading_page',0),max((len(items)-1)//4,0))
        st.session_state.reading_page=page
        with st.container(height=520,border=False):
            for index,item in enumerate(items[page*4:page*4+4],start=page*4):
                item_card(item,index,query,on_explain)
        controls=st.columns([1,2,1])
        controls[0].button('←',key='reading_previous',disabled=page==0,on_click=set_page,args=(page-1,))
        controls[1].caption(f'{page*4+1}–{min(page*4+4,len(items))} of {len(items)}')
        controls[2].button('→',key='reading_next',disabled=(page+1)*4>=len(items),on_click=set_page,args=(page+1,))


def set_page(page):
    st.session_state.reading_page=page
