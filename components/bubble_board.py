"""Compact circle packing with native, keyboard-accessible Streamlit buttons."""
import math
import streamlit as st

COLORS = ['#4fb9c1', '#74a8c9', '#72d2c3', '#b5a4d4', '#90c5dc', '#8db8bc', '#66b0a9', '#b7bfdb', '#a0d6c4', '#84acd1', '#7dd0d1', '#9abbd0']
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


def bubble_board(weights, metrics=None, on_select=None, namespace='packed_board', descriptions=None, button_prefix=None, show_descriptions=True):
    # Metric mode uses logarithmic area to keep extreme citation counts readable.
    radii = None
    if metrics:
        maximum = max(item['value'] for item in metrics.values())
        radii = {key: 100 * math.sqrt(math.log1p(item['value']) / math.log1p(maximum)) for key, item in metrics.items()}
    nodes = pack_circles(weights, radii)
    selected = None
    board_class = f'.st-key-{namespace}'
    orb_class = f'{namespace}_orb_'
    board_bg = '#fff8eb'
    board_border = '#c6b79d'
    css = f'''<style>
    {board_class} {{position:relative!important; width:100%!important; max-width:340px; aspect-ratio:1; margin:auto; background:{board_bg}; border:1px solid {board_border}; border-radius:28px; overflow:hidden; display:block!important; container-type:inline-size;}}
    {board_class} > [data-testid="stLayoutWrapper"] {{position:static!important;}}
    {board_class} [class*="st-key-{orb_class}"] {{position:absolute!important; margin:0!important; padding:0!important; gap:0!important;}}
    {board_class} button {{width:100%!important; height:100%!important; min-height:0!important; aspect-ratio:1!important; border-radius:50%!important; border:2px solid {board_bg}!important; padding:5px!important; color:#08232d!important; box-shadow:none!important; transition:filter .2s;}}
    {board_class} [class*="st-key-{orb_class}"] > div {{height:100%!important; width:100%!important;}}
    {board_class} .stButton, {board_class} .stButton > div {{height:100%!important;width:100%!important;}}
    {board_class} button:hover {{filter:brightness(1.08); outline:2px solid #a8f1ef; outline-offset:1px;}}
    {board_class} button:focus-visible {{outline:3px solid #a8f1ef!important; outline-offset:2px;}}
    {board_class} button p {{font-size:clamp(.75rem,1.5vw,.875rem); line-height:1.2; overflow-wrap:anywhere;}}
    </style>'''
    rules = []
    for n in nodes:
        rules.append(f'.st-key-{orb_class}{n["index"]} {{left:{n["left"]:.4f}%;top:{n["top"]:.4f}%;width:{n["size"]:.4f}%!important;height:{n["size"]:.4f}cqw!important;aspect-ratio:1!important;}}')
        relevance=metrics.get(n['term'],{}).get('relevance') if metrics else None
        color=(f'hsl({round(280-150*min(relevance,.7))} 65% 65%)' if relevance is not None
            else COLORS[n['index']%len(COLORS)])
        rules.append(f'{board_class} .st-key-{orb_class}{n["index"]} button {{background:{color}!important;opacity:{0.55 if n["weight"] == 0 else 1};}}')
    st.markdown(css + '<style>' + ''.join(rules) + '</style>', unsafe_allow_html=True)
    with st.container(key=namespace):
        for node in nodes:
            with st.container(key=f'{orb_class}{node["index"]}'):
                metric_label=metrics[node['term']]['label'] if metrics else ''
                short_label=metric_label.replace(' (name match, unverified)','')
                short_label=(short_label[:27]+'…') if len(short_label)>28 else short_label
                unit=metrics[node['term']].get('unit','items') if metrics else ''
                label = (short_label + '\n\n' + str(metrics[node['term']]['value'])+' '+unit) if metrics else node['term']
                description = (descriptions or {}).get(node['term'], '')
                if description and not metrics and show_descriptions:
                    label += '\n\n' + description[:52] + ('…' if len(description)>52 else '')
                if on_select is not None:
                    st.button(label, key=(button_prefix or 'direction_')+node['term'], help=description or None, on_click=on_select, args=(node['term'],))
                elif st.button(label, key=('metric_' if metrics else 'bubble_')+node['term'],
                    help=None):
                    if metrics:
                        selected = node['term']
                    else:
                        weights[node['term']] = (node['weight']+1)%4
                        st.rerun()
    if not metrics and on_select is None:
        st.caption(' · '.join(f'{term}: {STATES[weight]}' for term, weight in weights.items()))
    return selected


def combination_board(directions, selected, on_select, namespace='topic', signals=None):
    """Keep every direction in one stable slot; selection slides it across the divider."""
    labels=[item['label'] for item in directions]
    signals=signals or {}
    maximum=max((signals.get(label,{}).get('count',0) for label in labels),default=0)
    radii={label:35+25*math.sqrt(signals.get(label,{}).get('count',0)/maximum)
        if maximum else 48 for label in labels}
    nodes=pack_circles({label:1 for label in labels}, radii)
    board=f'{namespace}_composition'
    background='#fff8eb'
    border='#c6b79d'
    rules=[f'''<style>
      .st-key-{board} {{position:relative!important; width:100%; max-width:520px; aspect-ratio:2; container-type:inline-size; background:{background}; border:1px solid {border}; border-radius:12px; overflow:hidden;}}
      .st-key-{board}:after {{content:"";position:absolute;left:50%;top:7%;bottom:7%;border-left:2px dashed #4b8a96;pointer-events:none;}}
      .st-key-{board} > [data-testid="stLayoutWrapper"] {{position:static!important;}}
      .st-key-{board} [class*="st-key-{board}_orb_"] {{position:absolute!important;margin:0!important;padding:0!important;transition:left .48s cubic-bezier(.2,.8,.2,1), top .48s cubic-bezier(.2,.8,.2,1);}}
      .st-key-{board} [class*="st-key-{board}_orb_"] > div,
      .st-key-{board} .stButton, .st-key-{board} .stButton > div {{height:100%!important;width:100%!important;}}
      .st-key-{board} button {{height:100%!important;width:100%!important;min-height:0!important;aspect-ratio:1!important;border-radius:50%!important;border:2px solid {background}!important;padding:5px!important;color:#092531!important;box-shadow:0 5px 16px #071a2430!important;}}
      .st-key-{board} button:hover {{filter:brightness(1.08);outline:2px solid #a8f1ef;outline-offset:1px;}}
      .st-key-{board} button p {{font-size:clamp(.75rem,1.65vw,.875rem);line-height:1.2;overflow-wrap:anywhere;}}
    </style>''']
    for node in nodes:
        size=node['size']/2
        left=node['left']/2+(50 if node['term'] in selected else 0)
        relevance=signals.get(node['term'],{}).get('relevance',.4)
        hue=round(280-150*min(relevance,.7))
        color=f'hsl({hue} 65% {68-7*relevance:.0f}%)'
        rules.append(f'<style>.st-key-{board}_orb_{node["index"]} {{left:{left:.4f}%;top:{node["top"]:.4f}%;width:{size:.4f}%!important;height:{size:.4f}cqw!important;aspect-ratio:1!important;}}'
            f'.st-key-{board} .st-key-{board}_orb_{node["index"]} button {{background:{color}!important;}}</style>')
    st.markdown(''.join(rules),unsafe_allow_html=True)
    meanings={item['label']:item.get('meaning','') for item in directions}
    with st.container(key=board):
        for node in nodes:
            with st.container(key=f'{board}_orb_{node["index"]}'):
                count=signals.get(node['term'],{}).get('count')
                help_text=(meanings[node['term']]+'\n\n' if meanings[node['term']] else '')+(f'{count} matching items in the preview search. Tap to add or remove this topic.' if count is not None else 'Tap to add or remove this topic.')
                label=node['term']
                st.button(label,key=f'{namespace}_bubble_{node["index"]}',
                    help=help_text,on_click=on_select,args=(node['term'],))
