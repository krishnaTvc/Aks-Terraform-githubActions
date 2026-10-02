#!/usr/bin/env python3
"""Render nonsecret manifest values; no third-party dependencies."""
import argparse, ipaddress, pathlib, re
parser = argparse.ArgumentParser()
parser.add_argument('--registry', required=True)
parser.add_argument('--tag', required=True)
parser.add_argument('--client-cidr', required=True)
a = parser.parse_args()
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*\.azurecr\.io', a.registry):
    parser.error('Use the ACR loginServer hostname, without https://')
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', a.tag):
    parser.error('Invalid image tag')
try:
    network = ipaddress.ip_network(a.client_cidr, strict=True)
    if network.version != 4 or network.prefixlen == 0:
        raise ValueError('Use a restricted IPv4 CIDR, normally your public IP/32')
except ValueError as exc:
    parser.error(str(exc))
root = pathlib.Path(__file__).resolve().parents[1]
out = root / '.rendered'; out.mkdir(exist_ok=True)
for name in ('config.yaml', 'mongo.yaml', 'app.yaml', 'apache.yaml'):
    text = (root / 'k8s' / name).read_text()
    text = text.replace('__REGISTRY__', a.registry).replace('__TAG__', a.tag)
    text = text.replace('__CLIENT_CIDR__', str(network))
    (out / name).write_text(text)
print('Rendered manifests in .rendered/')
