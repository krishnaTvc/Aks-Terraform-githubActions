resource "azurerm_resource_group" "lab" {
  name = var.resource_group_name
  location = var.location
  tags = var.tags
}
resource "azurerm_container_registry" "acr" {
  name = var.acr_name
  resource_group_name = azurerm_resource_group.lab.name
  location = azurerm_resource_group.lab.location
  sku = "Basic"
  admin_enabled = false
  tags = var.tags
}
resource "azurerm_kubernetes_cluster" "aks" {
  name = var.aks_name
  resource_group_name = azurerm_resource_group.lab.name
  location = azurerm_resource_group.lab.location
  dns_prefix = "boxoffice-tf"
  sku_tier = "Free"
  role_based_access_control_enabled = true
  local_account_disabled = true
  oidc_issuer_enabled = true
  workload_identity_enabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
  }
  default_node_pool {
    name = "agentpool"
    vm_size = var.node_vm_size
    auto_scaling_enabled = true
    node_count = var.node_count
    min_count = var.min_node_count
    max_count = var.max_node_count
    os_disk_size_gb = 128
  }
  identity { type = "SystemAssigned" }
  network_profile {
    network_plugin = "azure"
    network_plugin_mode = "overlay"
    load_balancer_sku = "standard"
    outbound_type = "loadBalancer"
    service_cidr = "10.0.0.0/16"
    dns_service_ip = "10.0.0.10"
    pod_cidr = "10.244.0.0/16"
  }
  storage_profile {
    disk_driver_enabled = true
    file_driver_enabled = true
    snapshot_controller_enabled = true
  }
  tags = var.tags
}
resource "azurerm_role_assignment" "kubelet_acr_pull" {
  scope = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}
