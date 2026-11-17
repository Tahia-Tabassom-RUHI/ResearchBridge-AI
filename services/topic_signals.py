"""Explainable topic size and relevance for a bounded preview sample."""
import re
from collections import Counter
from services.ranking import STOP
from services.ranking import relevance_details, query_from_question, suggest_directions


def words(value):
    return {word for word in re.findall(r'[\w-]+', (value or '').casefold()) if word not in STOP and len(word)>2}


def expand_directions_from_sample(question,plan,papers):
    """Make extra, labelled search directions from retrieved terms when AI is off."""
    if not papers or len(plan.get('directions',[]))!=1 or plan['directions'][0]['label']!='Search my wording':
        return plan
    counts=Counter()
    for paper in papers:
        if paper.get('is_retracted') is True:
            continue
        counts.update({term for term in paper.get('topics',[])+paper.get('keywords',[])
            if isinstance(term,str) and 3<=len(term)<=46})
    candidates=[term for term in suggest_directions(papers,limit=20)
        if counts[term]>=2 and term.casefold() not in question.casefold()]
    generic={'study','research','analysis','effect','effects','using','based','review',
        'method','methods','approach','result','results','paper','case','system','systems',
        'figure','figures','table','tables','algorithm','algorithms','comparison','experimental',
        'enhanced','conditions','short-term','production','under','windy'}
    title_counts,title_scores=Counter(),Counter()
    for paper in papers:
        score=relevance_details(paper,question)[0]
        for word in words(paper.get('title')):
            if word not in words(question) and word not in generic and len(word)>=5:
                title_counts[word]+=1
                title_scores[word]+=score
    candidates.extend(word.title() for word in sorted(title_counts,
        key=lambda term:(-title_scores[term],-title_counts[term],term))
        if title_counts[word]>=2 and word.casefold() not in {term.casefold() for term in candidates})
    selected=[]
    for term in candidates:
        if term.casefold() not in {item.casefold() for item in selected}:
            selected.append(term)
        if len(selected)==4:
            break
    if not selected:
        return plan
    base=query_from_question(question)
    expanded=dict(plan)
    generated=[{
        'label':term,'query':(base+' '+term)[:180],
        'meaning':f'Appears in retrieved source records. Explore this term to see if it helps answer your question.'}
        for term in selected]
    expanded['directions']=generated if len(generated)>=2 else [*plan['directions'],*generated]
    expanded['origin']='Guided search with terms from retrieved source records; no AI interpretation'
    return expanded


def topic_signals(question, directions, papers):
    question_words=words(question)
    signals={}
    for item in directions:
        label=item['label']
        if label=='Search my wording':
            available=[paper for paper in papers if paper.get('is_retracted') is not True]
            average=sum(relevance_details(paper,question)[0] for paper in available)/max(len(available),1)
            signals[label]={'count':len(available),'relevance':min(1.0,.18+.82*average)}
            continue
        label_words=words(label)
        direction_words=words(item.get('query'))
        distinctive=(direction_words-question_words) or label_words
        count=0
        relevance_sum=0.0
        for paper in papers:
            if paper.get('is_retracted') is True:
                continue
            text=' '.join([paper.get('title') or '',paper.get('abstract') or '',
                *paper.get('topics',[]),*paper.get('keywords',[])]).casefold()
            tokens=words(text)
            if label.casefold() in text or (distinctive and len(tokens & distinctive)>=min(2,len(distinctive))):
                count+=1
                relevance_sum+=relevance_details(paper,question)[0]
        query_overlap=len(question_words & (label_words|direction_words))/max(len(question_words),1)
        relevance=min(1.0,.18+.4*query_overlap+(.42*relevance_sum/count if count else 0))
        signals[label]={'count':count,'relevance':relevance}
    return signals
