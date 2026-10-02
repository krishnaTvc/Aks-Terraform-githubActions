output "resource_group" { value = azurerm_resource_group.lab.name }
output "aks_name" { value = azurerm_kubernetes_cluster.aks.name }
output "acr_name" { value = azurerm_container_registry.acr.name }
output "acr_login_server" { value = azurerm_container_registry.acr.login_server }
output "get_credentials_command" { value = "az aks get-credentials -g ${azurerm_resource_group.lab.name} -n ${azurerm_kubernetes_cluster.aks.name} --overwrite-existing" }
