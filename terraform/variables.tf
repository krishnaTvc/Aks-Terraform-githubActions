variable "subscription_id" { type = string }
variable "resource_group_name" {
  type    = string
  default = "rg-boxoffice-terraform-lab"
}
variable "location" {
  type    = string
  default = "eastus"
}
variable "aks_name" {
  type    = string
  default = "aks-boxoffice-tf"
}
variable "acr_name" {
  type        = string
  description = "Globally unique, alphanumeric ACR name"
}
variable "node_vm_size" {
  type    = string
  default = "Standard_D2as_v4"
}
variable "node_count" {
  type    = number
  default = 2
}
variable "min_node_count" {
  type    = number
  default = 2
}
variable "max_node_count" {
  type    = number
  default = 3
}
variable "tags" {
  type    = map(string)
  default = { project = "boxoffice", managed_by = "terraform", environment = "lab" }
}
variable "client_id" {
  type = string
}

variable "tenant_id" {
  type = string
}