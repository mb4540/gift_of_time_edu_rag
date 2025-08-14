import { Handler } from '@netlify/functions';
import { Client } from 'pg';

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'GET') {
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
    const doc_id = event.queryStringParameters?.doc_id;
    
    if (!doc_id) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Missing doc_id parameter' })
      };
    }

    const client = new Client({
      connectionString: process.env.NETLIFY_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    await client.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          id,
          title,
          metadata,
          created_at,
          updated_at,
          (SELECT COUNT(*) FROM rag.embeddings WHERE document_id = rag.documents.id) as chunks_count
        FROM rag.documents 
        WHERE metadata->>'doc_id' = $1
      `, [doc_id]);

      if (result.rows.length === 0) {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ error: 'Document not found' })
        };
      }

      const document = result.rows[0];
      const metadata = document.metadata;
      
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          doc_id,
          db_id: document.id,
          title: document.title,
          status: metadata.status || 'UNKNOWN',
          chunks_count: parseInt(document.chunks_count) || 0,
          total_tokens: metadata.total_tokens || 0,
          file_size: metadata.file_size || 0,
          original_filename: metadata.original_filename,
          document_type: metadata.document_type || 'unknown',
          tenant_id: metadata.tenant_id,
          created_at: document.created_at,
          updated_at: document.updated_at,
          processed_at: metadata.processed_at
        })
      };

    } finally {
      await client.end();
    }

  } catch (error) {
    console.error('Doc status error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Failed to get document status',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
