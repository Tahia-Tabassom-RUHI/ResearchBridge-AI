import json
from io import BytesIO
from itertools import permutations
from urllib.parse import urlparse

import pytest

from services.papers import DiscoveryError, normalize
from services.ranking import rank_papers, shortlist
from services.research_map import map_data
from services.scholarly import crossref_record, discover, europe_record, merge_records


def test_invalid_doi_does_not_supply_a_resolver_link():
    assert crossref_record({'DOI':'10.1/invalid','title':['Title']}) is None
    europe=europe_record({'id':'123','title':'Title','doi':'not a DOI'})
    assert europe['doi'] is None
    assert europe['paper_url']=='https://europepmc.org/article/MED/123'
    openalex=normalize({'id':'https://openalex.org/W1','title':'Title',
        'doi':'https://example.org/10.1234/real'})
    assert openalex['doi'] is None
    assert openalex['paper_url']==openalex['id']


def test_equivalent_doi_formats_merge_without_collapsing_distinct_suffixes():
    crossref=crossref_record({'DOI':'10.1234/ABC(1)','title':['Title']})
    europe=europe_record({'id':'123','title':'Title','doi':'doi:10.1234/abc(1)'})
    openalex=normalize({'id':'https://openalex.org/W1','title':'Title',
        'doi':'http://dx.doi.org/10.1234/abc%281%29'})
    distinct=crossref_record({'DOI':'10.1234/abc(1)/','title':['Different work']})
    merged=merge_records([crossref,europe,openalex,distinct])
    assert [p['doi'] for p in merged]==['https://doi.org/10.1234/abc(1)',
        'https://doi.org/10.1234/abc(1)/']
    assert merged[0]['provenance']['sources']==['Crossref','Europe PMC','OpenAlex']
    assert len(map_data(merged,'Authors')['records'])==2


def test_merge_retains_authors_specific_type_date_precision_and_access_provenance():
    crossref=crossref_record({'DOI':'10.1234/review','title':['Title'],
        'type':'journal-article','published':{'date-parts':[[2025]]}})
    europe=europe_record({'id':'123','title':'Title','doi':'10.1234/review',
        'firstPublicationDate':'2025-03-15','pubTypeList':{'pubType':['Systematic Review']},
        'authorList':{'author':[{'fullName':'Ada Lee'}]},'abstractText':'Source text.',
        'isOpenAccess':'Y','pmcid':'PMC123'})
    [paper]=merge_records([crossref,europe])
    assert paper['authors']==['Ada Lee']
    assert paper['author_details'][0]['name']=='Ada Lee'
    assert paper['paper_type']=='review'
    assert paper['publication_date']=='2025-03-15'
    assert paper['is_oa'] is True
    assert paper['oa_url']=='https://europepmc.org/articles/PMC123'
    assert paper['provenance']['field_sources']['abstract']=='Europe PMC'
    assert paper['provenance']['field_sources']['publication_date']=='Europe PMC'
    assert crossref['authors']==[]


def test_retraction_notice_flags_its_target_by_doi_and_excludes_both_from_ranking():
    original=crossref_record({'DOI':'10.1234/original','title':['Original']})
    notice=crossref_record({'DOI':'10.1234/notice','title':['Notice'],
        'update-to':[{'type':'retraction','DOI':'https://dx.doi.org/10.1234/ORIGINAL'}]})
    unrelated=crossref_record({'DOI':'10.1234/unrelated','title':['Other']})
    records=merge_records([notice,unrelated,original])
    assert records[2]['is_retracted'] is True
    assert records[1]['is_retracted'] is None
    assert [p['id'] for p in shortlist(records,'paper',{})]==[unrelated['id']]
    assert [p['id'] for p in rank_papers(records,{})]==[unrelated['id']]
    assert [p['id'] for p in map_data(records,'Authors')['records']]==[unrelated['id']]


def test_doi_less_records_merge_on_shared_provider_identifier_only():
    europe=europe_record({'id':'123','source':'MED','title':'Shared title',
        'abstractText':'Source text.'})
    openalex=normalize({'id':'https://openalex.org/W1','title':'Shared title',
        'doi':'https://doi.org/10.1234/real','ids':{'pmid':'https://pubmed.ncbi.nlm.nih.gov/123'}})
    unrelated=europe_record({'id':'456','source':'MED','title':'Shared title'})
    merged=merge_records([europe,unrelated,openalex])
    assert len(merged)==2
    assert merged[0]['doi']=='https://doi.org/10.1234/real'
    assert merged[0]['abstract']=='Source text.'
    assert merged[1]['id']==unrelated['id']
    assert merged[1]['doi'] is None


def test_identifier_shared_by_conflicting_dois_does_not_merge_their_records():
    europe=europe_record({'id':'123','source':'MED','title':'Shared title'})
    openalex=[normalize({'id':f'https://openalex.org/W{i}','title':'Shared title',
        'doi':f'10.1234/{i}','ids':{'pmid':'123'}}) for i in (1,2)]
    assert len(merge_records([europe,*openalex]))==3


def test_two_doi_less_records_can_merge_on_verified_pmcid():
    europe=europe_record({'id':'123','source':'MED','title':'Title','pmcid':'PMC121'})
    openalex=normalize({'id':'https://openalex.org/W1','title':'Title',
        'ids':{'pmcid':'https://pmc.ncbi.nlm.nih.gov/articles/PMC121/'}})
    [paper]=merge_records([europe,openalex])
    assert paper['doi'] is None
    assert paper['provenance']['sources']==['Europe PMC','OpenAlex']


@pytest.mark.parametrize('doi',[None,'10.1234/shared'])
def test_pmid_pmcid_bridge_merges_regardless_of_provider_order(doi):
    pmid=normalize({'id':'https://openalex.org/W1','title':'Shared title',
        'doi':doi,'ids':{'pmid':'123'}})
    bridge=europe_record({'id':'123','source':'MED','title':'Shared title','pmcid':'PMC456'})
    pmcid=europe_record({'id':'PMC456','source':'PMC','title':'Shared title'})
    unrelated=europe_record({'id':'789','source':'MED','title':'Shared title'})
    for records in permutations([pmid,bridge,pmcid]):
        merged=merge_records([*records,unrelated])
        shared,other=shortlist(merged,'Shared title',{})
        assert len(map_data(merged,'Authors')['records'])==2
        assert shared['identifiers']==['pmcid:PMC456','pmid:123']
        assert shared['doi']==('https://doi.org/'+doi if doi else None)
        assert other['id']==unrelated['id']


def test_pmid_pmcid_bridge_does_not_join_conflicting_dois():
    pmid=normalize({'id':'https://openalex.org/W1','title':'Title',
        'doi':'10.1234/first','ids':{'pmid':'123'}})
    bridge=europe_record({'id':'123','source':'MED','title':'Title','pmcid':'PMC456'})
    pmcid=europe_record({'id':'PMC456','source':'PMC','title':'Title','doi':'10.1234/second'})
    for records in permutations([pmid,bridge,pmcid]):
        merged=merge_records(records)
        assert {record['doi'] for record in merged}=={pmid['doi'],None,pmcid['doi']}
        assert len(merged)==3


def test_unknown_type_and_invalid_dates_do_not_override_reported_metadata():
    crossref=crossref_record({'DOI':'10.1234/work','title':['Title'],'type':'book-chapter',
        'published':{'date-parts':[[2024,2,29]]},'is-referenced-by-count':0})
    europe=europe_record({'id':'123','title':'Title','doi':'10.1234/work',
        'firstPublicationDate':'2025-02-29','pubYear':2025,'isOpenAccess':'N','citedByCount':3})
    assert europe['paper_type'] is None
    assert europe['publication_date']=='2025'
    [paper]=merge_records([crossref,europe])
    assert paper['paper_type']=='book-chapter'
    assert paper['publication_date']=='2024-02-29'
    assert paper['cited_by_count']==0
    assert paper['is_oa'] is False
    assert paper['oa_url'] is None


def mock_search_payloads(monkeypatch,*,crossref=None,europe=None,openalex=None):
    payloads={
        'api.crossref.org':{'message':{'items':crossref if crossref is not None else []}},
        'www.ebi.ac.uk':{'resultList':{'result':europe if europe is not None else []}},
        'api.openalex.org':{'results':openalex if openalex is not None else []},
    }

    def reply(request,**kwargs):
        return BytesIO(json.dumps(payloads[urlparse(request.full_url).hostname]).encode())

    monkeypatch.setattr('services.scholarly.urlopen',reply)
    monkeypatch.setattr('services.papers.urlopen',reply)


@pytest.mark.parametrize('provider,rows',[
    ('crossref',[
        {'DOI':'10.1234/first','title':['First']},
        {'DOI':'10.1234/broken','title':['Broken'],'author':[None]},
        {'DOI':'10.1234/last','title':['Last']},
    ]),
    ('europe',[
        {'id':'123','title':'First'},
        {'id':'456','title':'Broken','authorList':{'author':[None]}},
        {'id':'789','title':'Last'},
    ]),
    ('openalex',[
        {'id':'https://openalex.org/W1','title':'First'},
        {'id':'https://openalex.org/W2','title':'Broken','authorships':[None]},
        {'id':'https://openalex.org/W3','title':'Last'},
    ]),
])
def test_malformed_provider_row_preserves_its_valid_siblings(monkeypatch,provider,rows):
    mock_search_payloads(monkeypatch,**{provider:rows})
    assert [record['title'] for record in discover('topic',api_key='fixture')]==['First','Last']


def test_malformed_filter_dates_keep_usable_provider_dates(monkeypatch):
    mock_search_payloads(monkeypatch,crossref=[
        {'DOI':'10.1234/recent','title':['Recent'],
         'published':{'date-parts':[2025]},'published-online':{'date-parts':[[2025,3]]}},
        {'DOI':'10.1234/unknown','title':['Unknown'],'published':{'date-parts':[[2025,2,30]]}},
        {'DOI':'10.1234/old','title':['Old'],'published':{'date-parts':[[2019]]}},
    ],openalex=[{'id':'https://openalex.org/W1','title':'Invalid date','publication_date':42}])
    assert [(paper['title'],paper['publication_date'])
        for paper in discover('topic',year=2024,api_key='fixture')]==[('Recent','2025-03')]


def test_malformed_keywords_in_duplicate_do_not_break_merge(monkeypatch):
    mock_search_payloads(monkeypatch,
        crossref=[{'DOI':'10.1234/shared','title':['Shared'],'subject':'invalid collection'}],
        europe=[{'id':'123','title':'Shared','doi':'10.1234/shared',
                 'keywordList':{'keyword':['Verified topic',{'unexpected':'object'}]}}])
    [paper]=discover('topic')
    assert paper['keywords']==['Verified topic']
    assert paper['provenance']['sources']==['Crossref','Europe PMC']


def test_malformed_result_collection_is_a_provider_failure(monkeypatch):
    mock_search_payloads(monkeypatch,crossref={},europe=[{'id':'123','title':'Valid result'}])
    [paper]=discover('topic')
    assert paper['search_sources']==['Europe PMC']
    assert any('Crossref' in notice for notice in paper['search_notices'])


def test_all_malformed_provider_responses_raise_a_discovery_error(monkeypatch):
    mock_search_payloads(monkeypatch,crossref={},europe=[None])
    with pytest.raises(DiscoveryError,match='paper services'):
        discover('topic')


def test_invalid_publication_filter_is_reported_before_requests(monkeypatch):
    def unexpected_request(*args,**kwargs):
        pytest.fail('An invalid filter must not reach a provider')

    monkeypatch.setattr('services.scholarly.urlopen',unexpected_request)
    with pytest.raises(DiscoveryError,match='publication year'):
        discover('topic',year='not a year')
