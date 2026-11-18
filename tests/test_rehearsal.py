import json
from pathlib import Path

import pytest

from services import rehearsal


def test_rehearsal_loads_all_records_with_a_windows_default(monkeypatch):
    read_text=Path.read_text
    expected=json.loads(read_text(rehearsal.SNAPSHOTS,encoding='utf-8'))

    def read_with_windows_default(path,encoding=None,**kwargs):
        return read_text(path,encoding=encoding or 'cp1252',**kwargs)

    monkeypatch.setattr(Path,'read_text',read_with_windows_default)
    actual=rehearsal.saved_searches()
    assert len(actual)==3
    assert sum(len(search['papers']) for search in actual)==45
    for search in expected:
        for paper in search['papers']:
            paper['rehearsal_snapshot']=True
    assert actual==expected


@pytest.mark.parametrize('payload',[b'{broken',b'\xff',b'{}',
    b'[{"papers":[]}]',b'[{"label":"Demo","query":"topic","papers":[{}]}]'])
def test_corrupted_rehearsal_file_returns_no_searches(monkeypatch,tmp_path,payload):
    snapshot=tmp_path/'rehearsal.json'
    snapshot.write_bytes(payload)
    monkeypatch.setattr(rehearsal,'SNAPSHOTS',snapshot)
    assert rehearsal.saved_searches()==[]


def test_missing_or_unreadable_rehearsal_file_returns_no_searches(monkeypatch,tmp_path):
    monkeypatch.setattr(rehearsal,'SNAPSHOTS',tmp_path/'missing.json')
    assert rehearsal.saved_searches()==[]
    monkeypatch.setattr(rehearsal,'SNAPSHOTS',tmp_path)
    assert rehearsal.saved_searches()==[]
