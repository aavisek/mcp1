@description('Location for all resources')
param location string = resourceGroup().location

@description('Enable read-only mode for MCP server')
param readOnlyMode bool = true

@description('Name for the Azure Container App')
param acaName string

@description('Azure MCP Server namespaces to expose.')
@minLength(1)
@maxLength(6)
param mcpNamespaces array = [
  'storage'
  'virtualdesktop'
  'compute'
  'files'
  'keyvault'
]

@description('Display name for the Server Entra App')
param entraAppServerDisplayName string

@description('Display name for the Client Entra App')
param entraAppClientDisplayName string

@description('Service Management Reference')
param serviceManagementReference string = ''

@description('Application Insights connection string')
param appInsightsConnectionString string = ''

// -----------------------------
// Application Insights
// -----------------------------
var appInsightsName = '${acaName}-insights'

module appInsights 'modules/application-insights.bicep' = {
  name: 'application-insights'
  params: {
    appInsightsConnectionString: appInsightsConnectionString
    name: appInsightsName
    location: location
  }
}

// -----------------------------
// Entra Apps
// -----------------------------
var clientName = '${replace(toLower(entraAppClientDisplayName), ' ', '-')}-${uniqueString(resourceGroup().id)}'

module entraAppClient 'modules/entra-app.bicep' = {
  name: 'entra-client'
  params: {
    entraAppDisplayName: entraAppClientDisplayName
    entraAppUniqueName: clientName
    isServer: false
    serviceManagementReference: serviceManagementReference
  }
}

var serverName = '${replace(toLower(entraAppServerDisplayName), ' ', '-')}-${uniqueString(resourceGroup().id)}'

module entraAppServer 'modules/entra-app.bicep' = {
  name: 'entra-server'
  params: {
    entraAppDisplayName: entraAppServerDisplayName
    entraAppUniqueName: serverName
    isServer: true
    entraAppScopeValue: 'Mcp.Tools.ReadWrite'
    entraAppScopeDisplayName: 'Azure MCP Multi-Service Tools'
    entraAppScopeDescription: 'Access to Storage, AVD, VM, Files, Key Vault'
    knownClientAppId: entraAppClient.outputs.entraAppClientId
    serviceManagementReference: serviceManagementReference
  }
}

// -----------------------------
// Managed Identity
// -----------------------------
module identity 'modules/aca-storage-managed-identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    managedIdentityName: '${acaName}-mi'
  }
}

// -----------------------------
// ACA Infrastructure
// -----------------------------
module aca 'modules/aca-infrastructure.bicep' = {
  name: 'aca'
  params: {
    name: acaName
    location: location
    appInsightsConnectionString: appInsights.outputs.connectionString
    azureMcpCollectTelemetry: string(!empty(appInsights.outputs.connectionString))
    azureAdTenantId: tenant().tenantId
    azureAdClientId: entraAppServer.outputs.entraAppClientId
    azureAdInstance: environment().authentication.loginEndpoint
    namespaces: mcpNamespaces
    readOnlyMode: readOnlyMode
    userAssignedManagedIdentityId: identity.outputs.managedIdentityId
    userAssignedManagedIdentityClientId: identity.outputs.managedIdentityClientId
  }
}

// -----------------------------
// RBAC Roles
// -----------------------------
module vmRole 'modules/aca-role-assignment.bicep' = {
  name: 'vm-role'
  scope: subscription()
  params: {
    managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
    roleDefinitionId: 'de139f84-1756-47ae-9be6-808fbbe84772'
  }
}

module readerRole 'modules/aca-role-assignment.bicep' = {
  name: 'reader-role'
  scope: subscription()
  params: {
    managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
    roleDefinitionId: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  }
}

// =========================
// OUTPUTS
// =========================
output AZURE_RESOURCE_GROUP string = resourceGroup().name
output CONTAINER_APP_NAME string = acaName
output CONTAINER_APP_URL string = aca.outputs.containerAppUrl
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_LOCATION string = location
output APPLICATION_INSIGHTS_NAME string = appInsightsName
output CONTAINER_APP_MANAGED_IDENTITY_CLIENT_ID string = identity.outputs.managedIdentityClientId
output ENTRA_APP_SERVER_CLIENT_ID string = entraAppServer.outputs.entraAppClientId
output ENTRA_APP_CLIENT_CLIENT_ID string = entraAppClient.outputs.entraAppClientId
output ENTRA_APP_SERVER_SCOPE_ID string = entraAppServer.outputs.entraAppScopeId
output ENTRA_APP_SERVER_SCOPE_VALUE string = entraAppServer.outputs.entraAppScopeValue

module filesRole 'modules/aca-role-assignment.bicep' = {
  name: 'files-role'
  scope: subscription()
  params: {
    managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
    roleDefinitionId: '17d1049b-9a84-46fb-8f53-869881c3d3ab'
  }
}

module keyVaultRole 'modules/aca-role-assignment.bicep' = {
  name: 'kv-role'
  scope: subscription()
  params: {
    managedIdentityPrincipalId: identity.outputs.managedIdentityPrincipalId
    roleDefinitionId: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  }
}
