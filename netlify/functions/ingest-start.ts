import { HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';

export const handler = async (event: HandlerEvent, context: HandlerContext): Promise<HandlerResponse> => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { doc_id, tenant_id } = JSON.parse(event.body || '{}');
    
    if (!doc_id || !tenant_id) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Missing doc_id or tenant_id' })
      };
    }

    // Trigger background ingestion function
    // Note: In a real implementation, this would use a queue system
    // For now, we'll make a direct call to the background function
    const ingestResponse = await fetch(`${process.env.URL || 'http://localhost:8888'}/.netlify/functions/background/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ doc_id, tenant_id })
    });

    const ingestResult = await ingestResponse.json();

    if (!ingestResponse.ok) {
      throw new Error(`Ingestion failed: ${ingestResult.error || 'Unknown error'}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        message: 'Ingestion started',
        doc_id,
        result: ingestResult
      })
    };

  } catch (error) {
    console.error('Ingest start error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Failed to start ingestion',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
