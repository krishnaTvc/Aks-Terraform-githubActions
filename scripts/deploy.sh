#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ACR_LOGIN_SERVER:?Set ACR_LOGIN_SERVER}"
: "${IMAGE_TAG:?Set IMAGE_TAG}"
: "${CLIENT_CIDR:?Set CLIENT_CIDR to your public IPv4/32}"
python3 scripts/render.py --registry "$ACR_LOGIN_SERVER" \
  --tag "$IMAGE_TAG" --client-cidr "$CLIENT_CIDR"
# Namespace and Secrets are administrator bootstrap prerequisites.
kubectl -n boxoffice apply -f .rendered/config.yaml
kubectl -n boxoffice apply -f .rendered/mongo.yaml
kubectl -n boxoffice rollout status statefulset/mongo --timeout=600s
kubectl -n boxoffice apply -f .rendered/app.yaml
kubectl -n boxoffice rollout status deployment/boxoffice-app --timeout=300s
kubectl -n boxoffice apply -f .rendered/apache.yaml
kubectl -n boxoffice rollout status deployment/boxoffice-apache --timeout=300s
kubectl -n boxoffice get pods,services,pvc
