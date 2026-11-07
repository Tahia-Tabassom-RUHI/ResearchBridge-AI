"""Switchable maps with source-record drilldown and explicit sample scope."""
import streamlit as st
from components.bubble_board import bubble_board
from components.paper_card import paper_card
from services.research_map import VIEWS, map_data, unique_papers


def render_insights(papers, weights):
    st.caption('Switch what the bubbles show. Tap a bubble to open its supporting records.')
    terms = sorted({term for p in unique_papers(papers) for term in p.get('topics', []) + p.get('keywords', [])})
    view = st.selectbox('What should the bubbles show?', list(VIEWS), key='map_view')
    scope = st.selectbox('Explore within a topic', ['All retrieved topics'] + terms, key='map_topic')
    data = map_data(papers, view, None if scope == 'All retrieved topics' else scope)
    count = len(data['records'])
    illustrative = any(p.get('provenance', {}).get('source') == 'Illustrative interface demo' for p in papers)
    st.caption(('ILLUSTRATIVE DATA · ' if illustrative else '') + f'{count} retrieved records · sample only, not the whole scientific community')
    with st.expander('What bubble size means'):
        st.write(VIEWS[view])
        st.caption('Area uses a logarithmic scale; numbers show exact values. Research volume and citations cannot establish how well a claim is supported.')
    positive = {key: item for key, item in data['groups'].items() if item['value'] > 0}
    shown = dict(list(positive.items())[:12])
    signature = (st.session_state.get('searched_query'), st.session_state.get('searched_year'), view, scope)
    if st.session_state.get('map_signature') != signature:
        st.session_state.pop('map_selected', None)
        st.session_state.map_signature = signature
    if shown:
        selected = bubble_board({key: 1 for key in shown}, metrics=shown)
        if selected:
            st.session_state.map_selected = selected
        st.caption(f'{len(shown)} of {len(positive)} groups · tap a bubble to inspect records')
    elif data['groups']:
        st.info('Available records report zero citations for these groups. No sized bubbles are drawn; exact zero values are listed below.')
    else:
        st.warning('No records with the necessary metadata for this view and topic. Try another view or broaden the topic. Missing data does not mean no research exists.')
    if data['groups']:
        with st.expander('Exact values for every group'):
            st.dataframe([{'Group': item['label'], 'Value': item['value'], 'Supporting records': len(item['paper_ids'])} for item in data['groups'].values()], hide_index=True, width='stretch')
    if data['missing']:
        st.caption(f"{data['missing']} records have missing metadata relevant to this view. Unknown values are not treated as zero; totals include only available metadata.")
    key = st.session_state.get('map_selected')
    if key in data['groups']:
        item = data['groups'][key]
        st.subheader(item['label'])
        st.write(f"**{item['value']} {'citations received (summed)' if view == 'Citation attention' else 'records'}** · {len(item['paper_ids'])} supporting records")
        if item.get('url'):
            st.link_button('Open source profile ↗', item['url'])
        if st.button('Clear selection', key='clear_map_selection'):
            st.session_state.pop('map_selected', None)
            st.rerun()
        matching=[p for p in data['records'] if p['id'] in item['paper_ids']]
        maximum=max((len(matching)+2)//3,1)
        if 'insight_records_page' in st.session_state:
            st.session_state.insight_records_page=min(st.session_state.insight_records_page,maximum)
        page=st.number_input('Supporting records page',1,maximum,1,key='insight_records_page')
        for paper in matching[(page-1)*3:page*3]:
            paper_card(paper, weights, key_prefix='insight_',compact=True)
