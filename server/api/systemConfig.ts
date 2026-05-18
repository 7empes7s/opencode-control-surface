import { ok, type ApiEnvelope, type SystemConfig, type SystemConfigHistory } from './types.ts';

// Get current system configuration
export async function getSystemConfig(_req: Request): Promise<Response> {
  try {
    // Default configuration
    const defaultConfig: SystemConfig = {
      config: {
        financeAgent: {
          enabled: true,
          modelOverride: '',
          processingTimeout: 300000
        },
        pipelineStages: {
          research: {
            model: 'editorial-cloud-heavy',
            enabled: true,
            timeout: 600000
          },
          write: {
            model: 'editorial-cloud-heavy',
            enabled: true,
            timeout: 600000
          },
          publishPrep: {
            model: 'editorial-cloud-fast',
            enabled: true,
            timeout: 300000
          },
          verify: {
            model: 'editorial-heavy',
            enabled: true,
            timeout: 600000
          },
          scout: {
            model: 'editorial-fast',
            enabled: true,
            timeout: 300000
          },
          rank: {
            model: 'editorial-fast',
            enabled: true,
            timeout: 300000
          }
        },
        alertThresholds: {
          pipelineFailureRate: 0.1,
          modelResponseTimeMs: 30000,
          gpuUtilization: 0.8
        },
        autoPublish: {
          enabled: true,
          verticals: [
            'ai', 'trends', 'science', 'finance', 'global-politics', 
            'healthcare', 'culture', 'energy', 'climate', 'cybersecurity', 
            'economy', 'crypto'
          ],
          approvalRequired: [
            'world', 'politics', 'business', 'technology'
          ]
        },
        approvalWorkflows: {
          enabled: true,
          requiredVerticals: ['world', 'politics', 'sensitive'],
          maxArticlesPerDay: 10
        }
      }
    };

    const envelope: ApiEnvelope<SystemConfig> = ok(defaultConfig, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error fetching system config:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch system config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Update system configuration
export async function updateSystemConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { config } = body;

    // In a real implementation, this would save to a database
    // For now, just validate and return success
    
    // TODO: Actually persist the config in a database
    console.log('Updating system config:', config);

    const envelope: ApiEnvelope<any> = ok({ 
      success: true, 
      config,
      message: 'Configuration updated successfully' 
    }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error updating system config:', error);
    return new Response(JSON.stringify({ error: 'Failed to update system config' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get system configuration history
export async function getSystemConfigHistory(_req: Request): Promise<Response> {
  try {
    // Return mock history data
    const history: SystemConfigHistory[] = [
      {
        id: 'config-history-1',
        timestamp: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        changedBy: 'system',
        changes: ['Updated pipeline timeouts'],
        configSnapshot: {}
      },
      {
        id: 'config-history-2',
        timestamp: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
        changedBy: 'admin',
        changes: ['Changed model routing for research stage'],
        configSnapshot: {}
      },
      {
        id: 'config-history-3',
        timestamp: new Date(Date.now() - 259200000).toISOString(), // 3 days ago
        changedBy: 'system',
        changes: ['Auto-adjusted alert thresholds'],
        configSnapshot: {}
      }
    ];

    const envelope: ApiEnvelope<{ history: SystemConfigHistory[] }> = ok({ history }, {});
    return new Response(JSON.stringify(envelope), { 
      headers: { "Content-Type": "application/json" } 
    });
  } catch (error) {
    console.error('Error fetching system config history:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch system config history' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}