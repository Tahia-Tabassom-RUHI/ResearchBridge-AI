"""Load transparently labelled, previously retrieved records for offline rehearsal."""
import json
from pathlib import Path

SNAPSHOTS=Path(__file__).resolve().parents[1]/'sample_data'/'verified_searches.json'


def saved_searches():
    if not SNAPSHOTS.exists():
        return []
    try:
        data=json.loads(SNAPSHOTS.read_text())
        for item in data:
            for paper in item['papers']:
                paper['rehearsal_snapshot']=True
        return data
    except (ValueError,KeyError,TypeError):
        return []
