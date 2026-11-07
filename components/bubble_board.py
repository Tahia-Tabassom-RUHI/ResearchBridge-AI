"""Compact circle packing with native, keyboard-accessible Streamlit buttons."""
import math
import streamlit as st

COLORS = ['#8eacd2', '#67cdb1', '#b68185', '#a784be', '#8fd1ef', '#e3d867', '#efb2d5', '#80c8cb', '#f4cd83', '#b7cce8', '#9bcbbb', '#c3cf8c']
STATES = ['Set aside', 'Explore', 'Important', 'Main focus']


def pack_circles(weights, radii=None):
    """Place large circles first at the closest collision-free spiral position."""
    nodes = []
    for index, (term, weight) in sorted(enumerate(weights.items()), key=lambda item: -item[1][1]):
        radius = radii[term] if radii is not None else [25, 48, 72, 100][weight]
        if not nodes:
            x, y = 0.0, 0.0
        else:
            for step in range(1, 30000):
                angle = step * 0.13
                distance = 0.65 * math.sqrt(step) * 3
                x, y = math.cos(angle)*distance, math.sin(angle)*distance
                if all(math.hypot(x-n['x'], y-n['y']) >= radius+n['r']+3 for n in nodes):
                    break
        nodes.append(dict(index=index, term=term, weight=weight, x=x, y=y, r=radius))
    if not nodes:
        return []
    left = min(n['x']-n['r'] for n in nodes)
    right = max(n['x']+n['r'] for n in nodes)
    top = min(n['y']-n['r'] for n in nodes)
    bottom = max(n['y']+n['r'] for n in nodes)
    side = max(right-left, bottom-top) + 24
    cx, cy = (left+right)/2, (top+bottom)/2
    for node in nodes:
        node['left'] = 50 + 100*(node['x']-node['r']-cx)/side
        node['top'] = 50 + 100*(node['y']-node['r']-cy)/side
        node['size'] = 200*node['r']/side
    return sorted(nodes, key=lambda n: n['index'])


def bubble_board(weights, metrics=None):
    # Metric mode uses logarithmic area to keep extreme citation counts readable.
    radii = None
    if metrics:
        maximum = max(item['value'] for item in metrics.values())
        radii = {key: 100 * math.sqrt(math.log1p(item['value']) / math.log1p(maximum)) for key, item in metrics.items()}
    nodes = pack_circles(weights, radii)
    selected = None
    css = '''<style>
    .st-key-packed_board {position:relative!important; width:100%!important; max-width:620px; aspect-ratio:1; margin:auto; background:#fff; border-radius:28px; overflow:hidden; display:block!important;}
    .st-key-packed_board > [data-testid="stLayoutWrapper"] {position:static!important;}
    .st-key-packed_board [class*="st-key-orb_"] {position:absolute!important; margin:0!important; padding:0!important; gap:0!important;}
    .st-key-packed_board button {width:100%!important; height:100%!important; border-radius:50%!important; border:2px solid white!important; padding:8px!important; color:#17342f!important; box-shadow:none!important; transition:filter .2s;}
    .st-key-packed_board [class*="st-key-orb_"] > div {height:100%!important; width:100%!important;}
    .st-key-packed_board .stButton, .st-key-packed_board .stButton > div {height:100%!important;width:100%!important;}
    .st-key-packed_board button:hover {filter:brightness(.94); outline:2px solid #315e56; outline-offset:1px;}
    .st-key-packed_board button:focus-visible {outline:3px solid #17342f!important; outline-offset:2px;}
    .st-key-packed_board button p {font-size:clamp(10px,1.7vw,14px); line-height:1.15; overflow-wrap:anywhere;}
    </style>'''
    rules = []
    for n in nodes:
        rules.append(f'.st-key-orb_{n["index"]} {{left:{n["left"]:.4f}%;top:{n["top"]:.4f}%;width:{n["size"]:.4f}%!important;height:{n["size"]:.4f}%!important;}}')
        rules.append(f'.st-key-orb_{n["index"]} button {{background:{COLORS[n["index"]%len(COLORS)]}!important;opacity:{0.55 if n["weight"] == 0 else 1};}}')
    st.markdown(css + '<style>' + ''.join(rules) + '</style>', unsafe_allow_html=True)
    with st.container(key='packed_board'):
        for node in nodes:
            with st.container(key=f'orb_{node["index"]}'):
                label = (metrics[node['term']]['label'] + '\n\n' + str(metrics[node['term']]['value'])) if metrics else node['term']
                if st.button(label, key=('metric_' if metrics else 'bubble_')+node['term']):
                    if metrics:
                        selected = node['term']
                    else:
                        weights[node['term']] = (node['weight']+1)%4
                        st.rerun()
    if not metrics:
        st.caption(' · '.join(f'{term}: {STATES[weight]}' for term, weight in weights.items()))
    return selected
