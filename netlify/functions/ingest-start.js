exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
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
    // Build absolute URL using Netlify env vars; avoid localhost fallback in production
    const baseUrl = process.env.DEPLOY_URL || process.env.URL || 'http://localhost:8888';
    const targetUrl = `${baseUrl}/api/background/ingest`;
    const ingestResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ doc_id, tenant_id })
    });

    // Safely parse response
    const contentType = ingestResponse.headers.get('content-type') || '';
    let ingestResult;
    if (contentType.includes('application/json')) {
      ingestResult = await ingestResponse.json();
    } else {
      const text = await ingestResponse.text();
      throw new Error(`Unexpected response from background ingest (status ${ingestResponse.status}, type ${contentType}): ${text.slice(0, 200)}`);
    }

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
