@description('Location')
param location string = resourceGroup().location

@description('Container app name')
param name string = 'azure-mcp-storage-avd-server-v2'

@description('Existing managed environment resource ID')
param managedEnvironmentId string = '/subscriptions/dc9f8048-c514-41af-89f2-1c3a722e4f10/resourceGroups/AVD-LAB-RG1/providers/Microsoft.App/managedEnvironments/azure-mcp-storage-avd-server-env'

@description('User-assigned managed identity resource ID')
param userAssignedManagedIdentityId string = '/subscriptions/dc9f8048-c514-41af-89f2-1c3a722e4f10/resourcegroups/AVD-LAB-RG1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/azure-mcp-storage-avd-server-storage-managed-identity'

@description('Managed identity client ID')
param userAssignedManagedIdentityClientId string = 'f2b23d82-9791-4567-8110-c6393c90035a'

@description('Tenant ID')
param azureAdTenantId string = '01f48ee8-94f3-448d-90de-0a89fff4a6a4'

@description('Server app registration client ID')
param azureAdClientId string = 'c337bb77-e7b4-4577-bccb-44fa9af2192d'

@description('Namespaces to expose')
param namespaces array = [
  'storage'
  'virtualdesktop'
  'compute'
  'fileshares'
  'keyvault'
  'group'
]

var baseArgs = [
  '--transport'
  'http'
  '--outgoing-auth-strategy'
  'UseHostingEnvironmentIdentity'
  '--mode'
  'all'
  '--read-only'
]

var nsPairs = [
  for ns in namespaces: [
    '--namespace'
    ns
  ]
]

var finalArgs = concat(baseArgs, flatten(nsPairs))

resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedManagedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
      }
    }
    template: {
      containers: [
        {
          name: name
          image: 'mcr.microsoft.com/azure-sdk/azure-mcp:latest'
          args: finalArgs
          env: [
            {
              name: 'ASPNETCORE_ENVIRONMENT'
              value: 'Production'
            }
            {
              name: 'ASPNETCORE_URLS'
              value: 'http://+:8080'
            }
            {
              name: 'AZURE_TOKEN_CREDENTIALS'
              value: 'managedidentitycredential'
            }
            {
              name: 'AZURE_MCP_INCLUDE_PRODUCTION_CREDENTIALS'
              value: 'true'
            }
            {
              name: 'AZURE_MCP_COLLECT_TELEMETRY'
              value: 'False'
            }
            {
              name: 'AzureAd__Instance'
              value: 'https://login.microsoftonline.com/'
            }
            {
              name: 'AzureAd__TenantId'
              value: azureAdTenantId
            }
            {
              name: 'AzureAd__ClientId'
              value: azureAdClientId
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: userAssignedManagedIdentityClientId
            }
            {
              name: 'AZURE_LOG_LEVEL'
              value: 'Verbose'
            }
            {
              name: 'AZURE_MCP_DANGEROUSLY_DISABLE_HTTPS_REDIRECTION'
              value: 'true'
            }
            {
              name: 'AZURE_MCP_DANGEROUSLY_ENABLE_FORWARDED_HEADERS'
              value: 'true'
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 10
      }
    }
  }
}

output containerAppUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
