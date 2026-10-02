# Boxoffice application on Azure Kubernetes Service

This project converts the supplied Boxoffice application from an EC2 Docker Compose deployment to **AKS + Azure Container Registry + GitHub Actions using Azure OIDC**. The existing movie form, search, API paths and MongoDB document fields are preserved.

The default deployment includes **Apache, Node.js and one authenticated MongoDB instance inside AKS**. MongoDB stores its data on an Azure Disk persistent volume. This is a hands-on learning deployment: the single database instance is not highly available, and the website has no user authentication or HTTPS. Its public load balancer is therefore restricted to an IPv4 CIDR you supply.

No Azure resources are created by downloading this project. Run the setup steps below in your own subscription. No credentials are embedded in the project.

## Contents

1. [Architecture](#architecture)
2. [What changed](#what-changed)
3. [Project files](#project-files)
4. [Prerequisites](#prerequisites)
5. [Create Azure resources](#create-azure-resources)
6. [Bootstrap the namespace and database credentials](#bootstrap-the-namespace-and-database-credentials)
7. [Deploy manually first](#deploy-manually-first)
8. [Set up GitHub OIDC](#set-up-github-oidc)
9. [Configure GitHub and run the pipeline](#configure-github-and-run-the-pipeline)
10. [Verify the application](#verify-the-application)
11. [Troubleshooting](#troubleshooting)
12. [Updates and rollback](#updates-and-rollback)
13. [Database operations](#database-operations)
14. [Cleanup and cost control](#cleanup-and-cost-control)
15. [Production improvements](#production-improvements)
16. [Validation and references](#validation-and-references)

## Architecture

| Component | Kubernetes resource | Port and purpose |
|---|---|---|
| Browser entry point | `boxoffice-web` LoadBalancer Service | Public port 80, restricted to `CLIENT_CIDR` |
| Apache reverse proxy | `boxoffice-apache` Deployment, 2 replicas | Container port 8080; forwards to `http://app:3000` |
| Application endpoint | `app` ClusterIP Service | Internal port 3000 |
| Node.js / Express | `boxoffice-app` Deployment, 2 replicas | Serves `/`, `/api/movies` and health endpoints |
| Database endpoint | `mongo` headless Service | Internal port 27017; no public database port |
| MongoDB | `mongo` StatefulSet, 1 replica | `mongo:8.0`, authentication enabled |
| Database storage | `data-mongo-0` PVC | 8 GiB request, `managed-csi`, Azure Disk |
| App configuration | `boxoffice-config` ConfigMap | Port, DB name and credential-free connection URL |
| Application credentials | `mongo-app` Secret | Read/write access to `demo_boxoffice` only |
| Administrative credentials | `mongo-admin` Secret | Mounted only into MongoDB, not into Node.js |

Request path: browser → Azure Load Balancer → Apache pod → `app` Service → Node.js pod → `mongo` Service → MongoDB pod → Azure Disk.

All workloads are in the `boxoffice` namespace. Kubernetes DNS resolves the short names `app` and `mongo` because they are in that same namespace. Apache serves as a reverse proxy; the HTML itself is served by Express. These are three workload components, not three independent business microservices.

GitHub Actions builds the two application images and pushes them to ACR. AKS pulls those images using its kubelet managed identity. MongoDB is pulled from the official Docker Hub image; mirror it into ACR if your environment restricts Docker Hub or encounters pull limits.

## What changed

| Original file or behavior | New behavior |
|---|---|
| EC2/Render workflow | Replaced by `.github/workflows/deploy-aks.yml` |
| `docker-compose.yml`, `render.yaml` | Removed from this AKS package |
| Docker Compose named volume | MongoDB StatefulSet volume claim using Azure Disk |
| `node:20-alpine` | `node:24-alpine`, running as nonroot user `node` |
| Static serving of the project root | Only `public/` is served; source files are no longer web assets |
| HTTP listener starts before DB connection finishes | Initial DB connection is retried before starting HTTP |
| No explicit health contract | Independent `/health/live` and database-aware `/health/ready` |
| Immediate pod shutdown | SIGTERM/SIGINT close HTTP and MongoDB connections |
| User input used as a regular expression | Search text is escaped and results are limited to 100 |
| Movie values interpolated into HTML | Cells use `textContent` to avoid executing stored markup |
| Apache on container port 80 | Nonroot Apache on 8080, Service exposes port 80 |
| Local `node_modules` and `.git` bundled in ZIP | Excluded from the delivery; install from the preserved lockfile |

The API still supports POST and GET `/api/movies`. Database name remains `demo_boxoffice`, collection remains `movies`. `collection` must now be a nonnegative finite number. Empty fields and strings longer than 200 characters are rejected. The original form values `running` and `left` continue to work.

## Project files

| Path | Purpose |
|---|---|
| `server.js` | API, static serving, startup retry and graceful shutdown |
| `public/index.html` | Existing UI, with safe table rendering |
| `Dockerfile` | Node.js image |
| `Dockerfile.httpd`, `httpd.conf` | Apache image and reverse proxy |
| `k8s/namespace.yaml` | One-time namespace bootstrap |
| `k8s/config.yaml` | App configuration and first-boot MongoDB user script |
| `k8s/mongo.yaml` | Headless Service, StatefulSet and storage claim template |
| `k8s/app.yaml`, `k8s/apache.yaml` | Deployments and Services |
| `scripts/bootstrap-secrets.py` | Generates random credentials directly into Kubernetes |
| `scripts/render.py` | Replaces registry, image tag and client CIDR placeholders |
| `scripts/deploy.sh` | Applies resources and waits for each rollout |
| `tests/app.test.js` | HTTP/API tests with a fake DB, using Node's built-in test runner |
| `.github/workflows/deploy-aks.yml` | Test, build, push, authenticate and deploy |

The files containing `__REGISTRY__`, `__TAG__` and `__CLIENT_CIDR__` are templates. **Do not run `kubectl apply -f k8s/` on the whole directory.** Use `scripts/deploy.sh`, which renders them first. Namespace creation is a separate administrator step.

## Prerequisites

Use **Bash in WSL Ubuntu or your Linux VM** for the commands below. They are not PowerShell syntax. Run from the extracted project root. Keep `.sh` files in LF format; `.gitattributes` enforces this for Git checkouts.

Tools:

- Current Azure CLI, logged into the intended tenant/subscription.
- `kubectl` compatible with your cluster and Azure `kubelogin`.
- Python 3, Git and Node.js 24 for local tests.
- Docker Engine/Desktop for the manual image-build path. Docker is already available on the GitHub-hosted runner; you do not need local Docker for the GitHub-only path.

Permissions:

- Resource creation requires suitable Azure permissions and available AKS/VM quota.
- Role assignments require Owner, Role Based Access Control Administrator, or User Access Administrator as appropriate. **Contributor alone cannot assign roles.** Ask your subscription administrator to perform these assignments if needed.
- Creating a Microsoft Entra application/service principal requires permission in the tenant. Azure resource Contributor does not automatically grant this directory permission.
- The documented pipeline expects managed Entra integration and Azure RBAC for Kubernetes authorization.

This walkthrough creates a dedicated lab resource group. It uses a public AKS API endpoint protected by Entra authentication, and an ACR public endpoint. A private cluster/private ACR needs a runner with private network access; standard GitHub-hosted runners will not automatically reach it.

## Create Azure resources

Skip resource creation if you already have suitable AKS and ACR resources; set the same shell variables and verify the identity/network/storage assumptions instead.

```bash
az login
az account set --subscription '<YOUR_SUBSCRIPTION_ID>'
az account show --query '{subscription:id,tenant:tenantId,name:name}' -o table

export AZURE_RESOURCE_GROUP=rg-boxoffice-aks-lab
export LOCATION=centralindia
export AKS_NAME=aks-boxoffice-lab
export ACR_NAME='<globallyuniquealphanumericname>'
export CLIENT_CIDR='<YOUR_PUBLIC_IPV4>/32'
```

`CLIENT_CIDR` is the public address your browser connects from, not your VM's private address or your laptop's `192.168.x.x` address. The renderer deliberately rejects `0.0.0.0/0`. Update this value and redeploy if your ISP changes your public IP.

```bash
az group create --name "$AZURE_RESOURCE_GROUP" --location "$LOCATION"
az acr create --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$ACR_NAME" --sku Basic --admin-enabled false \
  --role-assignment-mode rbac

az aks create --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AKS_NAME" --location "$LOCATION" \
  --tier free --node-count 1 --node-vm-size Standard_D4s_v5 \
  --enable-managed-identity --enable-aad --enable-azure-rbac \
  --network-plugin azure --network-plugin-mode overlay \
  --generate-ssh-keys

export AKS_ID=$(az aks show -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME" --query id -o tsv)
export ACR_ID=$(az acr show -n "$ACR_NAME" --query id -o tsv)
export ACR_LOGIN_SERVER=$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)
az aks update -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME" --attach-acr "$ACR_ID"
```

The one-node example is for a lab, not availability. Choose a supported system-pool VM size available in your region/quota if that SKU is unavailable. Two app replicas on one node do not survive a node outage. The free AKS tier does not make nodes, disks, load balancers, public IPs or ACR free.

This explicitly uses ACR's standard RBAC mode. For an existing **ABAC-enabled** registry, do not use `--attach-acr`: assign **Container Registry Repository Reader** to the kubelet identity and **Container Registry Repository Writer** to your image-pushing identity. Do not change an existing registry's authorization mode casually.

Grant your setup user cluster administration for this dedicated lab (an administrator must run the role command):

```bash
export SETUP_USER_ID=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --assignee-object-id "$SETUP_USER_ID" \
  --assignee-principal-type User \
  --role 'Azure Kubernetes Service RBAC Cluster Admin' --scope "$AKS_ID"
```

Install tools and connect. If your account cannot list user credentials, an administrator must also assign **Azure Kubernetes Service Cluster User Role** on the AKS resource.

```bash
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
AKS_VERSION=$(az aks show -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME" --query currentKubernetesVersion -o tsv)
az aks install-cli --client-version "$AKS_VERSION" \
  --install-location "$HOME/.local/bin/kubectl" \
  --kubelogin-install-location "$HOME/.local/bin/kubelogin"
az aks get-credentials -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
kubectl config current-context
kubectl get nodes
kubectl get storageclass managed-csi
```

Allow a few minutes for role propagation if you initially see `Forbidden`. Verify the context before applying anything. `managed-csi` must exist and Azure Disk CSI must be enabled. The PVC uses delayed binding, so it can be Pending until a database pod is scheduled.

## Bootstrap the namespace and database credentials

Run once, before the first manual or pipeline deployment:

```bash
kubectl apply -f k8s/namespace.yaml
python3 scripts/bootstrap-secrets.py
kubectl -n boxoffice get secrets
```

The script generates independent random admin and app passwords. It sends the Secret objects to `kubectl` through stdin; it never prints passwords or writes them into a project file. No database password needs to be stored in GitHub.

It refuses to overwrite either existing Secret. If you already have both, skip the script. If only one exists, investigate the failed bootstrap before proceeding. Only on a fresh lab with **no database PVC/data** may you delete the partial Secrets and regenerate. Never generate new credentials over an existing database and assume MongoDB will pick them up.

The official MongoDB image creates users only when initializing an empty data directory. Updating Kubernetes Secrets alone does not rotate users in an initialized database. Keep database data and corresponding credentials together when planning recovery. Kubernetes Secret values are base64 representations, not encryption provided by this project; control RBAC access and use an appropriate secret-management system for production.

## Deploy manually first

This section is useful for seeing each step. Alternatively, skip to GitHub OIDC after bootstrap and let the pipeline build and deploy.

First test the app locally without requiring a database:

```bash
npm ci
npm run check
npm test
```

The tests inject a fake database. For a real local app run, set `MONGO_URL`, `MONGO_USERNAME`, `MONGO_PASSWORD` and `DB_NAME` for an accessible database, then `npm start`. The URI below in the cluster is intentionally credential-free; username and password come separately from the Secret.

```bash
export IMAGE_TAG=lab-v1
az acr login --name "$ACR_NAME"
docker build -t "$ACR_LOGIN_SERVER/boxoffice-app:$IMAGE_TAG" .
docker build -f Dockerfile.httpd \
  -t "$ACR_LOGIN_SERVER/boxoffice-apache:$IMAGE_TAG" .
docker run --rm "$ACR_LOGIN_SERVER/boxoffice-apache:$IMAGE_TAG" httpd -t

docker push "$ACR_LOGIN_SERVER/boxoffice-app:$IMAGE_TAG"
docker push "$ACR_LOGIN_SERVER/boxoffice-apache:$IMAGE_TAG"
bash scripts/deploy.sh
```

Your manual build identity needs ACR push rights. For the standard RBAC registry, an administrator can grant you `AcrPush` on `$ACR_ID`. Use Linux/amd64 images for the example x86 node pool; on an ARM build machine use buildx with `--platform linux/amd64`.

The deploy script applies config and MongoDB first, waits for MongoDB, then deploys Node.js and Apache. This replaces Compose `depends_on`; Node.js also retries its initial database connection. Images use your explicit tag; GitHub deployment uses the immutable-by-convention commit SHA. Do not overwrite a tag that is already deployed.

## Set up GitHub OIDC

Do this once for your repository. The workflow uses the GitHub environment **`aks-lab`**, so the federated subject must match that environment exactly, including case.

Create the Entra application and service principal without a client secret:

```bash
export GITHUB_OWNER='<your-GitHub-user-or-organization>'
export GITHUB_REPO='<your-repository-name>'
export AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
export AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)
export AZURE_CLIENT_ID=$(az ad app create \
  --display-name boxoffice-aks-github --query appId -o tsv)
export PIPELINE_OBJECT_ID=$(az ad sp create --id "$AZURE_CLIENT_ID" --query id -o tsv)

FEDERATED_FILE=$(mktemp)
cat > "$FEDERATED_FILE" <<EOF
{
  "name": "github-aks-lab",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${GITHUB_OWNER}/${GITHUB_REPO}:environment:aks-lab",
  "description": "Boxoffice AKS lab deployment",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
az ad app federated-credential create --id "$AZURE_CLIENT_ID" \
  --parameters "$FEDERATED_FILE"
rm -- "$FEDERATED_FILE"
```

Save the application ID for later reuse. Do not rerun `az ad app create` for every deployment. Grant these roles to the service principal object ID:

```bash
az role assignment create --assignee-object-id "$PIPELINE_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal --role AcrPush --scope "$ACR_ID"
az role assignment create --assignee-object-id "$PIPELINE_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal --role Reader --scope "$ACR_ID"
az role assignment create --assignee-object-id "$PIPELINE_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role 'Azure Kubernetes Service Cluster User Role' --scope "$AKS_ID"
az role assignment create --assignee-object-id "$PIPELINE_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role 'Azure Kubernetes Service RBAC Writer' \
  --scope "$AKS_ID/namespaces/boxoffice"
```

| Identity | Permission and purpose |
|---|---|
| GitHub Entra service principal | ACR push and registry metadata read |
| GitHub Entra service principal | AKS user credentials and workload updates in `boxoffice` |
| AKS kubelet managed identity | ACR image pull through the earlier `--attach-acr` step |
| Your setup user | Bootstrap namespace, Secrets and administrative troubleshooting |

Namespace-scoped AKS RBAC Writer can access Secrets and create pods in that namespace. It is limited to this dedicated namespace, but it is not a secret-blind role. Use a custom least-privilege role and stronger workload isolation if required in production. The workflow does not create namespaces or rotate database credentials.

GitHub OIDC authenticates the CI runner to Azure. It is separate from AKS Workload Identity for pods; this application does not need Azure API credentials inside its pods.

## Configure GitHub and run the pipeline

Create **Settings → Environments → `aks-lab`**. Restrict deployment branches to `main`; add reviewers if appropriate. Define these **seven environment variables**:

| Variable | Example / source |
|---|---|
| `AZURE_CLIENT_ID` | Entra application ID created above |
| `AZURE_TENANT_ID` | Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Subscription ID |
| `AZURE_RESOURCE_GROUP` | `rg-boxoffice-aks-lab` |
| `AKS_NAME` | `aks-boxoffice-lab` |
| `ACR_NAME` | Your ACR resource name, not its URL |
| `CLIENT_CIDR` | Your browser's public IPv4 `/32` |

**Required GitHub secrets: zero.** Azure client/tenant/subscription IDs are identifiers; OIDC avoids a long-lived Azure client secret. MongoDB credentials are bootstrapped in the cluster.

Put the contents of this project at the root of your repository, including `.github`. Remove the old `.github/workflows/deploy.yml`, `docker-compose.yml` and `render.yaml` if you are replacing files in an existing checkout; they are absent from this ZIP but copying files alone does not delete old files. Ensure no old EC2/Render deployment workflow remains enabled.

```bash
git add .
git commit -m "Migrate Boxoffice deployment to AKS"
git push origin main
```

If creating a brand-new repository, initialize Git, set `main`, and add your own remote first. This ZIP intentionally does not contain the old `.git` history.

Workflow behavior:

- Pull requests to `main`: install dependencies, run API tests, render a sample manifest set, build both images and check Apache configuration. No Azure login or deployment.
- Push to `main` or manual dispatch on `main`: run those checks, authenticate with OIDC, push both images with the commit SHA, get non-admin AKS context, deploy, and wait for readiness.
- Deployments are serialized per branch. A failed rollout fails the job and prints resource/event diagnostics; there is no automatic rollback.
- GitHub-hosted runners need public network access to AKS, ACR and image/package registries. API authorized IP ranges can block these runners even when the cluster is public. Use a runner with known allowed egress or private network access instead of repeatedly opening the API broadly.
- Your browser CIDR applies to the application LoadBalancer, not to the AKS API. The workflow checks readiness inside the cluster and does not need to browse your restricted frontend.

## Verify the application

```bash
kubectl -n boxoffice get pods,svc,pvc
kubectl -n boxoffice rollout status deployment/boxoffice-app
kubectl -n boxoffice rollout status deployment/boxoffice-apache
kubectl -n boxoffice rollout status statefulset/mongo
kubectl -n boxoffice get svc boxoffice-web --watch
```

Wait for `EXTERNAL-IP` to become available. From your allowed public address open `http://<EXTERNAL-IP>`. Add a movie, list all movies and search for it. HTTP is intentional for this restricted lab; do not submit sensitive information.

```bash
WEB_IP=$(kubectl -n boxoffice get svc boxoffice-web \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl --fail --max-time 15 "http://$WEB_IP/health/live"
curl --fail --max-time 15 "http://$WEB_IP/health/ready"
curl --fail --max-time 15 "http://$WEB_IP/api/movies"
```

To verify without using the public load balancer, run this in one terminal and browse `http://127.0.0.1:8080` on that same computer:

```bash
kubectl -n boxoffice port-forward svc/boxoffice-web 8080:80
```

Container logs go to stdout/stderr:

```bash
kubectl -n boxoffice logs deployment/boxoffice-app --all-pods=true --tail=100
kubectl -n boxoffice logs deployment/boxoffice-apache --all-pods=true --tail=100
kubectl -n boxoffice logs mongo-0 --tail=100
```

The app's liveness check does not depend on MongoDB. Readiness does. A database outage should make app pods unready rather than restart healthy Node.js processes continuously. Startup probes allow for the initial bounded connection retry period. Apache readiness checks Node.js through the proxy.

## Troubleshooting

| Symptom | Check and resolution |
|---|---|
| `ImagePullBackOff` on app/Apache | Describe the pod; verify ACR loginServer, image tag, and kubelet pull role. The runner's push role is separate from kubelet pull permission. |
| Mongo image pull failure | Check Docker Hub access/rate limits. Mirror the image to ACR if required. |
| `CreateContainerConfigError` | Verify `mongo-admin`, `mongo-app`, and `boxoffice-config` exist in `boxoffice`. Never print Secret YAML in CI logs. |
| Mongo authentication failure after changing Secrets | Existing users were not changed. Restore matching credentials or rotate users in MongoDB first. |
| Mongo PVC Pending | Check pod scheduling, `managed-csi`, Azure Disk CSI, quota and events. Delayed binding waits for a consumer. |
| `Multi-Attach` during node recovery | Azure Disk is attached to one node for this workload. Allow detach/reattach; do not scale this standalone database to multiple replicas. |
| Node.js `CrashLoopBackOff` | Inspect previous logs, database readiness, DNS and credential configuration. It exits after bounded startup retries. |
| Node.js readiness 503 | MongoDB is unavailable or authentication/configuration is wrong. Liveness 200 can still be correct. |
| Apache 503 | Check `app` Service endpoints and Node readiness. Apache forwards to `app:3000`, not localhost. |
| External page times out | Check LoadBalancer external IP and `CLIENT_CIDR`; your current public IP may have changed. Test with port-forward. |
| OIDC login fails | Check tenant/client IDs and exact `repo:OWNER/REPO:environment:aks-lab` federated subject. |
| AKS `Forbidden` in CI | Verify namespace-scoped RBAC Writer and allow propagation. Credential retrieval and Kubernetes permissions are different roles. |
| ACR push denied | Check the service principal's push role and whether the registry uses RBAC or ABAC. |
| `exec format error` | Image architecture differs from AKS node architecture. Build the correct Linux platform. |
| `Insufficient cpu` / `Insufficient memory` | Check pod requests, node allocatable resources and node count. Increase capacity or deliberately reduce lab replicas. |

Useful commands:

```bash
kubectl -n boxoffice get events --sort-by=.lastTimestamp
kubectl -n boxoffice describe pod <POD_NAME>
kubectl -n boxoffice logs <POD_NAME> --previous
kubectl -n boxoffice describe pvc data-mongo-0
kubectl -n boxoffice get endpointslices -l kubernetes.io/service-name=app
kubectl -n boxoffice get deployment boxoffice-app -o jsonpath='{.spec.template.spec.containers[0].image}'
```

`kubectl top` requires the cluster metrics API. It is useful for tuning the initial resource requests/limits; the supplied values are lab starting points, not measured production capacity.

## Updates and rollback

Rebuild and push a new unique image tag for code changes. The GitHub workflow does this automatically using each commit SHA. Apache configuration is baked into its image, so changes require rebuilding the Apache image.

ConfigMap and Secret values injected as environment variables are read when a container starts. After an appropriate configuration change, restart the app rollout:

```bash
kubectl -n boxoffice rollout restart deployment/boxoffice-app
kubectl -n boxoffice rollout status deployment/boxoffice-app
```

This does not rotate MongoDB users. Changing `DB_NAME` alone also does not create permissions for a new database; the init script creates a user for `demo_boxoffice` on first initialization only.

For an application image regression, prefer reverting the code commit and redeploying through GitHub. Emergency rollback:

```bash
kubectl -n boxoffice rollout history deployment/boxoffice-app
kubectl -n boxoffice rollout undo deployment/boxoffice-app
kubectl -n boxoffice rollout status deployment/boxoffice-app
```

Roll back Apache separately if required. A Deployment rollback does not revert ConfigMaps, Secrets, database writes or the MongoDB image. Never roll back the database major version by simply changing its container tag. A later pipeline run can reapply the repository's current desired state.

## Database operations

### Persistence and scaling

Restarting/replacing `mongo-0` should retain data because the StatefulSet reuses `data-mongo-0`. Test by inserting a sample movie, deleting **only the pod**, waiting for recovery, and checking the movie again:

```bash
kubectl -n boxoffice delete pod mongo-0
kubectl -n boxoffice rollout status statefulset/mongo --timeout=600s
```

This causes a temporary outage in the lab. Do not delete the PVC for this test. The database is a standalone server; changing replicas from 1 to 3 creates separate databases, not a MongoDB replica set. Use Atlas or a properly managed replica-set deployment for high availability.

### Backup and restore

A PVC is persistence, not a backup. The deployment does not schedule database backups. For a small lab logical backup, briefly stop writes and run `mongodump` using a protected credentials configuration; store the output off-cluster and prove a restore into a separate database. For production, establish recovery-point/recovery-time targets and tested automated backups before storing important data.

Your original Compose setup used MongoDB 6. This package initializes a **fresh MongoDB 8** database. The ZIP contains application source, not the contents of the Docker named volume. Do not attach a MongoDB 6 data directory directly to MongoDB 8. Export data with supported database tools from the old system, follow MongoDB's version compatibility/upgrade guidance, and restore into a separate validated target. Migrate only the application database and create target users deliberately rather than blindly importing old administrative users.

### Credentials and rotation

Use a password manager/secret manager and an approved recovery procedure for the generated credentials. Administrators can export Secrets to a file with restrictive permissions if needed, but those exports contain recoverable passwords and must not enter Git or build artifacts.

To rotate credentials on an existing database: authenticate with the current administrator account, change the user's password in MongoDB, update the matching Kubernetes Secret, then restart affected workloads and verify readiness. Coordinate this operation to avoid an outage; prefer staged credentials in production. Do not rerun the bootstrap script against initialized storage.

### Switching to Atlas later

The delivered configuration uses in-cluster MongoDB. To switch, provision an Atlas database user, set `MONGO_URL` to the Atlas URI without embedding a password, put the Atlas username/password into `mongo-app`, and update `DB_NAME` and `authSource` appropriately. Allow the actual AKS egress IPs or use private connectivity. Remove MongoDB initialization/deployment steps from `scripts/deploy.sh` only after the application has been tested against Atlas. Back up data before removing the old PVC. Atlas billing, network setup and data migration are separate work.

## Cleanup and cost control

AKS nodes, ACR, disks and networking resources cost money. This is not designed to fit a tiny always-on monthly lab budget. Use short practice sessions and review your Azure cost dashboard.

For a pause, AKS supports stop/start for supported cluster configurations:

```bash
az aks stop -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME"
# Resume later:
az aks start -g "$AZURE_RESOURCE_GROUP" -n "$AKS_NAME"
```

Stopping compute does not remove disk, registry or other retained-resource charges. Check service availability and your current public IP when resuming.

**Destructive cleanup of the entire dedicated lab:** first export any data and retain required credentials. Verify that the resource group contains only this lab, then run:

```bash
az group delete --name "$AZURE_RESOURCE_GROUP"
```

The command asks for confirmation. Deleting the lab can permanently delete database storage. Inspect the AKS-managed node resource group and any retained disks afterward; do not assume removing application Deployments eliminates all Azure charges.

Deleting the `boxoffice` namespace deletes its Secrets and PVCs. With the built-in storage class's usual Delete reclaim policy, deleting a claim can delete the underlying disk. Do not use namespace deletion as a harmless restart.

The Entra application/service principal is a directory object and is not removed by deleting the Azure resource group. If it was created solely for this lab and is no longer used, delete that specific Entra application and remove obsolete GitHub environment variables/federation. Preserve identifiers so you do not accidentally delete another application's identity.

## Production improvements

Before using this beyond the restricted lab:

- Add HTTPS and user authentication/authorization. An allowed source IP can currently create movie records without logging in.
- Use a supported managed database or a monitored, backed-up replica set. Add MongoDB TLS where appropriate; cluster-internal database traffic here is not TLS-encrypted.
- Add network policies after choosing an AKS network-policy-capable dataplane. Internal Services prevent direct public exposure but do not isolate pods from other cluster workloads.
- Add availability zones/multiple nodes, topology spread, disruption budgets and autoscaling appropriate to measured traffic.
- Adopt Key Vault with an appropriate integration, planned rotation and narrower deployment privileges.
- Pin container images by digest and GitHub Actions to reviewed commit SHAs; the supplied version tags support straightforward lab setup but are mutable.
- Scan dependencies and images, define a patch policy, and test changes to the preserved dependency lockfile.
- Add centralized logs, metrics, alerting, an API smoke test and database backup/restore drills.

Helm and Terraform are not required to run this package. You can later package these manifests into a chart and provision the Azure prerequisites with Terraform; keep database credentials and infrastructure lifecycle handling deliberate.

## Validation and references

Checks performed while preparing this package:

- Node.js syntax check and five HTTP/API tests covering health behavior, source-file exposure, input validation, literal search and database failures.
- Bash syntax check, Python helper parsing, YAML parsing and rendered-manifest consistency checks.
- Tests used dependency files from the supplied archive; CI reruns them with a clean `npm ci` using the lockfile.

**Not performed here:** Docker builds, Apache runtime startup, live MongoDB initialization, Azure resource creation or a real AKS rollout. No Docker daemon, kubectl or Azure subscription session was available in the preparation environment. CI includes Docker builds and Apache `httpd -t`; complete the first live deployment and persistence test in your lab before relying on the deployment.

Primary references checked during preparation:

- [AKS and ACR integration](https://learn.microsoft.com/en-us/azure/aks/cluster-container-registry-integration)
- [Azure Disk persistent volumes](https://learn.microsoft.com/en-us/azure/aks/create-volume-azure-disk)
- [Azure RBAC for Kubernetes authorization](https://learn.microsoft.com/en-us/azure/aks/entra-id-authorization)
- [GitHub OIDC with Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure)
- [Azure Login action](https://github.com/Azure/login)
- [AKS context action](https://github.com/Azure/aks-set-context)
- [Official MongoDB container initialization](https://hub.docker.com/_/mongo)
- [Kubernetes probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Node.js release schedule](https://github.com/nodejs/Release)
