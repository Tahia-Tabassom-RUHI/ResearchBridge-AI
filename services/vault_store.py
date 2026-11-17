"""Small private local store for study sets, keyed by an unguessable URL token."""
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3


DEFAULT_DB=Path(__file__).resolve().parents[1]/'.researchbridge'/'vaults.sqlite3'
TOKEN=re.compile(r'^[A-Za-z0-9_-]{20,64}$')


def valid_token(value):
    return isinstance(value,str) and bool(TOKEN.fullmatch(value))


def new_token():
    return secrets.token_urlsafe(24)


def _connect(path):
    path=Path(path)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    connection=sqlite3.connect(path,timeout=5)
    if path.exists():
        os.chmod(path,0o600)
    connection.execute('CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    return connection


def _path(path):
    return Path(path or os.getenv('RB_VAULT_DB') or DEFAULT_DB)


def load_vault(token,path=None):
    if not valid_token(token):
        return None
    try:
        with _connect(_path(path)) as connection:
            row=connection.execute('SELECT data FROM vaults WHERE id=?',(token,)).fetchone()
        return json.loads(row[0]) if row else None
    except (OSError,sqlite3.Error,ValueError,TypeError):
        return None


def save_vault(token,data,path=None):
    if not valid_token(token):
        return False
    try:
        text=json.dumps(data,ensure_ascii=False,separators=(',',':'))
        if len(text)>8_000_000:
            return False
        with _connect(_path(path)) as connection:
            connection.execute('INSERT OR REPLACE INTO vaults(id,data) VALUES (?,?)',(token,text))
        return True
    except (OSError,sqlite3.Error,ValueError,TypeError):
        return False
