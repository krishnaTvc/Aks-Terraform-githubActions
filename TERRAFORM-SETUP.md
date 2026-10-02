# Terraform workflow — separate AKS lab (manual deployment preserved)

## What is preserved
The original `.github/workflows/deploy-aks.yml`, all application code, `k8s/` manifests and `scripts/` are unchanged. The new `.github/workflows/terraform.yml` is an independent infrastructure workflow. The manual deployment still targets your existing `AKS` / `ACRbox` in `rg-terraform-lab` through existing `aks-lab` GitHub variables.

## Safety: existing cluster is NOT imported
Your notes describe existing `AKS`, `ACRbox`, `rg-terraform-lab` (East US), two `Standard_D2as_v4` nodes, autoscaling 2–5, Azure overlay networking, managed Entra/Azure RBAC, disabled local accounts, OIDC and workload identity. The Terraform configuration deliberately creates a DIFFERENT resource group and new AKS/ACR. Do not set TF_RESOURCE_GROUP to `rg-terraform-lab` or TF_AKS_NAME to `AKS` unless you first design and execute a careful Terraform import. Creating an identically named resource is NOT importing it. Do not run `terraform destroy` on a state containing production or imported infrastructure.

## 1. Existing identity prerequisites
The GitHub `aks-lab` environment already contains `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` for the existing OIDC-based manual workflow. Reuse these values. Ensure the federated identity on the app registration allows `repo:OWNER/REPO:environment:aks-lab`. The existing deployment identity must ALSO have permission to create resource groups, ACR and AKS, and to assign `AcrPull` (Owner or RBAC Administrator at an appropriate scope; Contributor alone cannot create role assignments). If it has only registry and AKS-specific rights, have an Azure administrator grant scoped provisioning permissions or use a separate bootstrap identity. The Terraform workflow does not create or elevate its own identity.

## 2. Create the remote backend ONCE (Bash / WSL)
Run these after `az login` and `az account set --subscription YOUR_SUBSCRIPTION_ID`. Pick a globally unique lowercase storage name. Backend is separate from the disposable lab so deleting the lab will not delete its state.

```bash
BACKEND_RG=rg-boxoffice-tfstate
BACKEND_STORAGE=replacewithuniquetfstoragename
BACKEND_CONTAINER=tfstate
az group create -n "$BACKEND_RG" -l eastus
az storage account create -g "$BACKEND_RG" -n "$BACKEND_STORAGE" -l eastus --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false
az storage container create --name "$BACKEND_CONTAINER" --account-name "$BACKEND_STORAGE" --auth-mode login
BACKEND_SCOPE=$(az storage account show -g "$BACKEND_RG" -n "$BACKEND_STORAGE" --query id -o tsv)
# Admin: assign Storage Blob Data Contributor on BACKEND_SCOPE to the Terraform OIDC service principal.
# az role assignment create --assignee-object-id <SERVICE_PRINCIPAL_OBJECT_ID> --assignee-principal-type ServicePrincipal --role 'Storage Blob Data Contributor' --scope "$BACKEND_SCOPE"
```

If `az storage container create --auth-mode login` fails, your current login needs Storage Blob Data Contributor on the storage account. Role assignment propagation can take several minutes.

## 3. GitHub environment variables
In GitHub → Settings → Environments → `aks-lab`, keep existing `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACR_NAME`, `AKS_NAME`, `AZURE_RESOURCE_GROUP`, `CLIENT_CIDR` unchanged. Add:

| Variable | Example |
|---|---|
| TF_BACKEND_RG | rg-boxoffice-tfstate |
| TF_BACKEND_STORAGE | your globally unique storage name |
| TF_BACKEND_CONTAINER | tfstate |
| TF_ACR_NAME | a globally unique NEW ACR name, lowercase alphanumeric |
| TF_RESOURCE_GROUP | rg-boxoffice-terraform-lab |
| TF_AKS_NAME | aks-boxoffice-tf |
| TF_LOCATION | eastus |

These are nonsecret identifiers; never commit credentials or Terraform state. Protect `aks-lab` with environment reviewers if using `apply`. The original workflow continues to use its original variable names.

## 4. Run the infrastructure workflow
Push the repository. Open Actions → `Terraform AKS infrastructure (separate lab)` → Run workflow → `plan`. Inspect plan in logs. Then run workflow with `apply` on main, subject to your GitHub environment approval settings. `terraform apply` consumes the plan generated in the SAME run. PRs only validate and plan; they cannot apply. The remote Azure Blob state is used by both runs. AKS creation may take time and incurs Azure charges.

## 5. Verify the new cluster (Bash)
```bash
az aks get-credentials -g rg-boxoffice-terraform-lab -n aks-boxoffice-tf --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
kubectl get nodes
az acr show -n YOUR_NEW_ACR_NAME --query loginServer -o tsv
az role assignment list --scope "$(az acr show -n YOUR_NEW_ACR_NAME --query id -o tsv)" -o table
```

## 6. Deploy application to NEW infrastructure
The preserved manual workflow targets your ORIGINAL environment and will NOT deploy to the new Terraform-created AKS automatically. To target the new environment, create a separate GitHub environment with matching OIDC federated credential and new `ACR_NAME`, `AKS_NAME`, `AZURE_RESOURCE_GROUP`, `CLIENT_CIDR`, or explicitly change the existing environment after you no longer need the old target. Before deployment, create the namespace and MongoDB secrets on the NEW cluster following the original README: `kubectl apply -f k8s/namespace.yaml` then `python3 scripts/bootstrap-secrets.py`. You must also assign the deployment principal `AcrPush` on the NEW ACR, `Azure Kubernetes Service Cluster User Role` on the NEW AKS, and the appropriate Azure Kubernetes Service RBAC role (such as Writer scoped to the boxoffice namespace) before running the preserved deploy workflow. Terraform only creates kubelet `AcrPull` in this initial safe lab; it does not silently grant your existing deployment identity new access. Use a separate environment/workflow if you want simultaneous deployments to both clusters.

## 7. Terraform locally (optional)
Copy `terraform/terraform.tfvars.example` to `terraform/terraform.tfvars`, edit placeholders, then:
```bash
cd terraform
az login
export ARM_USE_AZUREAD=true
terraform init -backend-config="resource_group_name=$BACKEND_RG" -backend-config="storage_account_name=$BACKEND_STORAGE" -backend-config="container_name=$BACKEND_CONTAINER" -backend-config="key=boxoffice-lab.tfstate" -backend-config="use_azuread_auth=true"
terraform fmt -recursive
terraform validate
terraform plan
```

## 8. Cleanup
Use `terraform destroy` only for the dedicated new lab after checking `terraform plan -destroy`; keep the backend resource group until you have safely retired the state. MongoDB PVCs and Azure Disks contain data: back them up and review retention/deletion before teardown. The GitHub workflow deliberately does not offer automated destroy.

## Limitations / next iteration
This package adds Terraform infrastructure automation while preserving your original manual/Kubernetes manifest deployment. Helm and app-registration creation are NOT included in this iteration; your existing GitHub OIDC identity is a bootstrap prerequisite. A separate Helm deployment workflow can be added later without changing the infrastructure state. Azure provider and AKS API behavior change over time; run `terraform validate` and review the plan before applying. No live Azure deployment was performed while assembling this ZIP.
