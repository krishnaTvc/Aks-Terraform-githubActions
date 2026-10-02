#!/usr/bin/env python3
"""Run once per NEW database. Never overwrite existing credentials."""
import base64, json, secrets, subprocess

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)
run(['kubectl', 'get', 'namespace', 'boxoffice'], stdout=subprocess.DEVNULL)
existing = subprocess.check_output([
    'kubectl', '-n', 'boxoffice', 'get', 'secrets', '-o', 'json'])
names = {s['metadata']['name'] for s in json.loads(existing)['items']}
if names & {'mongo-admin', 'mongo-app'}:
    raise SystemExit('A database Secret already exists. Refusing to change credentials. See README.')
def make(name, values):
    return {'apiVersion': 'v1', 'kind': 'Secret',
            'metadata': {'name': name, 'namespace': 'boxoffice'},
            'type': 'Opaque', 'data': {
                k: base64.b64encode(v.encode()).decode() for k, v in values.items()}}
items = [make('mongo-admin', {
    'MONGO_INITDB_ROOT_USERNAME': 'boxoffice_admin',
    'MONGO_INITDB_ROOT_PASSWORD': secrets.token_urlsafe(36)}),
    make('mongo-app', {'MONGO_USERNAME': 'boxoffice_app',
                       'MONGO_PASSWORD': secrets.token_urlsafe(36)})]
run(['kubectl', 'create', '-f', '-'], input=json.dumps({
    'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True)
print('Created credentials without printing or writing passwords to disk.')
