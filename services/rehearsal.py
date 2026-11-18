"""Load transparently labelled, previously retrieved records for offline rehearsal."""
import json
from pathlib import Path

SNAPSHOTS=Path(__file__).resolve().parents[1]/'sample_data'/'verified_searches.json'


def saved_searches():
    try:
        data=json.loads(SNAPSHOTS.read_text(encoding='utf-8'))
    except (OSError,ValueError):
        return []
    if not isinstance(data,list):
        return []
    for item in data:
        if (not isinstance(item,dict) or not isinstance(item.get('label'),str)
                or not isinstance(item.get('query'),str) or not isinstance(item.get('papers'),list)):
            return []
        for paper in item['papers']:
            if (not isinstance(paper,dict) or not isinstance(paper.get('id'),str)
                    or not isinstance(paper.get('title'),str)):
                return []
            paper['rehearsal_snapshot']=True
    return data
