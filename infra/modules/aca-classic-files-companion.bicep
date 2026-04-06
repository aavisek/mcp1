@description('Location')
param location string

@description('Name')
param name string

@description('Managed environment name')
param managedEnvironmentName string

@description('Container image for companion service')
param image string

@description('App Insights')
param appInsightsConnectionString string

@description('Telemetry')
param azureMcpCollectTelemetry string

param userAssignedManagedIdentityId string
param userAssignedManagedIdentityClientId string

param cpu string = '0.25'
param memory string = '0.5Gi'

resource env 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: managedEnvironmentName
}

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
        targetPort: 8081
      }
    }

    template: {
      containers: [
        {
          name: name
          image: image

          env: [
            {
              name: 'PORT'
              value: '8081'
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
        maxReplicas: 3
      }
    }
  }
}

output containerAppUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
