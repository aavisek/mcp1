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
        sharedKey: logAnalytics.listKeys().primarySharedKey
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
              value: azureMcpCollectTelemetry
            }
            {
              name: 'AzureAd__Instance'
              value: azureAdInstance
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
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
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
