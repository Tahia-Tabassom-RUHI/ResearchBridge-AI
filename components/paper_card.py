"""Source-grounded results and a session-only handoff to the learning feature."""
import streamlit as st
from services.ranking import matches, relevance_details

def paper_card(paper, weights, key_prefix="", query="", allow_explanation=False, compact=False):
    if compact:
        with st.container(border=True):
            title=paper['title']
            st.markdown('**'+(title if len(title)<=110 else title[:107].rstrip()+'…')+'**')
            st.caption(' · '.join(filter(None,[paper.get('publication_date'),paper.get('paper_type'), 'Free text' if paper.get('oa_url') else 'Access unknown'])))
            buttons=st.columns([2,1])
            if buttons[0].button('Open paper →',key=key_prefix+'open_'+paper['id'],width='stretch'):
                st.session_state.reader_id=paper['id']
                st.session_state.ui_step='Read paper'
                st.rerun()
            saved=st.session_state.setdefault('saved_papers',{})
            if buttons[1].button('Remove saved' if paper['id'] in saved else 'Save for later',key=key_prefix+'save_'+paper['id'],width='stretch'):
                if paper['id'] in saved:
                    del saved[paper['id']]
                else:
                    saved[paper['id']]=paper
                st.rerun()
        return
    with st.container(border=True):
        if paper.get('provenance', {}).get('source') == 'Illustrative interface demo':
            st.caption('ILLUSTRATIVE RECORD — invented for interface testing; no scientific claim or citation.')
        st.caption(f"{paper.get('publication_date') or 'Date unknown'} · {paper.get('paper_type') or 'Type unknown'} · {'Free full text link' if paper.get('oa_url') else 'Access unknown / publisher page'}")
        st.subheader(paper['title'])
        st.caption('Record source: '+', '.join(paper.get('provenance',{}).get('sources',[paper.get('provenance',{}).get('source','Unknown')])))
        st.write(', '.join((paper.get('authors') or [])[:3]) or 'Authors unavailable')
        st.caption(paper.get('source_name') or 'Venue unknown')
        matched = [term for term, weight in weights.items() if weight > 1 and matches(paper, term)]
        _, query_hits = relevance_details(paper, query)
        if query_hits:
            st.write('**Connects to your search:** '+', '.join(query_hits))
        elif query:
            st.caption('Exploratory result: a close match to your wording has not been established.')
        st.write('**Why this appears:** ' + ('Matches your focus: ' + ', '.join(matched) if matched else ('Illustrative demo record.' if paper.get('provenance', {}).get('source') == 'Illustrative interface demo' else 'Returned by a scholarly source for this search; check its abstract for fit.')))
        with st.expander('Peek at the abstract'):
            st.write(paper.get('abstract') or 'Abstract unavailable. No findings have been generated.')
            st.caption('Retrieved abstract only. The full paper has not been reviewed. Relevance is not a quality assessment.')
        cols = st.columns(3)
        if paper.get('paper_url'):
            cols[0].link_button('Original source ↗', paper['paper_url'])
        if paper.get('oa_url'):
            cols[1].link_button('Free text ↗', paper['oa_url'])
        saved = st.session_state.setdefault('saved_papers', {})
        if cols[2].button('Remove saved' if paper['id'] in saved else 'Save for later', key=key_prefix+'save_'+paper['id']):
            if paper['id'] in saved:
                del saved[paper['id']]
            else:
                saved[paper['id']] = paper
            st.rerun()
        if allow_explanation and paper.get('abstract'):
            if st.button('Explain this abstract simply',key=key_prefix+'explain_'+paper['id']):
                st.session_state.explain_paper_id=paper['id']
        if st.button('Learn this paper →', key=key_prefix+'learn_'+paper['id']):
            st.session_state.selected_paper = paper
            st.info('Paper selected for the learning coach. The classroom connection is the next integration step with Ru.')
