"""Small private local store for study sets, keyed by an unguessable URL token."""
from contextlib import closing
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3


DEFAULT_DB=Path(__file__).resolve().parents[1]/'.researchbridge'/'vaults.sqlite3'
TOKEN=re.compile(r'^[A-Za-z0-9_-]{20,64}$')
MAX_VAULT_SIZE=8_000_000


class VaultError(Exception):
    """An operation could not safely read or save the vault."""


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
        with closing(_connect(_path(path))) as connection:
            return _read(connection,token)
    except (OSError,sqlite3.Error,ValueError,TypeError) as exc:
        raise VaultError('Vault storage could not be read. Reload the page to retry.') from exc


def _read(connection,token):
    row=connection.execute('SELECT data FROM vaults WHERE id=?',(token,)).fetchone()
    if row is None:
        return None
    data=json.loads(row[0])
    if not isinstance(data,dict):
        raise ValueError('Invalid vault data')
    return data


def update_vault(token,update,path=None):
    """Read and update under one SQLite write transaction."""
    if not valid_token(token):
        raise VaultError('The Vault link is invalid. Reload the page to retry.')
    try:
        with closing(_connect(_path(path))) as connection, connection:
            connection.execute('BEGIN IMMEDIATE')
            current=_read(connection,token)
            data=update(current)
            if data!=current:
                text=json.dumps(data,ensure_ascii=False,separators=(',',':'))
                if len(text)>MAX_VAULT_SIZE:
                    raise VaultError('Vault storage limit reached. Remove saved items or study sets and try again.')
                connection.execute(
                    'INSERT INTO vaults(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
                    (token,text),
                )
        return data
    except (OSError,sqlite3.Error,ValueError,TypeError) as exc:
        raise VaultError('Vault storage is unavailable. Try again.') from exc


def save_vault(token,data,path=None):
    try:
        update_vault(token,lambda current:data,path)
        return True
    except VaultError:
        return False
