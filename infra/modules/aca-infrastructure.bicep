@description('Location')
param location string

@description('Name')
param name string

@description('App Insights')
param appInsightsConnectionString string

@description('Telemetry')
param azureMcpCollectTelemetry string

@description('Tenant ID')
param azureAdTenantId string

@description('Client ID')
param azureAdClientId string

@description('Auth endpoint')
param azureAdInstance string

@description('Namespaces')
param namespaces array

@description('Read-only mode')
param readOnlyMode bool = true

param userAssignedManagedIdentityId string
param userAssignedManagedIdentityClientId string

// Optional tuning (recommended)
param cpu string = '0.25'
param memory string = '0.5Gi'

// =========================
// ARGUMENT BUILDING
// =========================
var baseArgs = [
  '--transport'
  'http'
  '--outgoing-auth-strategy'
  'UseHostingEnvironmentIdentity'
  '--mode'
  'all'
]

var argsWithReadOnly = readOnlyMode
  ? concat(baseArgs, ['--read-only'])
  : baseArgs

var nsPairs = [
  for ns in namespaces: [
    '--namespace'
    ns
  ]
]

var nsArgs = flatten(nsPairs)

var finalArgs = concat(argsWithReadOnly, nsArgs)

// =========================
// LOG ANALYTICS
// =========================
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${name}-law'
  location: location
  properties: {}
}

// =========================
// ACA ENVIRONMENT
// =========================
resource env 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, '2022-10-01').primarySharedKey
      }
    }
  }
}

// =========================
// CONTAINER APP
// =========================
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
    managedEnvironmentId: env.id

    configuration: {
      ingress: {
        external: true
        targetPort: 5000
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
              name: 'AzureAd__TenantId'
              value: azureAdTenantId
            }
            {
              name: 'AzureAd__ClientId'
              value: azureAdClientId
            }
            {
              name: 'AzureAd__Instance'
              value: azureAdInstance
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: userAssignedManagedIdentityClientId
            }
            {
              name: 'AZURE_TOKEN_CREDENTIALS'
              value: 'ManagedIdentityCredential'
            }
            {
              name: 'ASPNETCORE_URLS'
              value: 'http://0.0.0.0:5000'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
            {
              name: 'AZURE_MCP_COLLECT_TELEMETRY'
              value: azureMcpCollectTelemetry
            }
          ]

          resources: {
            cpu: json(cpu)
            memory: memory
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

// =========================
// OUTPUT
// =========================
output containerAppUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
