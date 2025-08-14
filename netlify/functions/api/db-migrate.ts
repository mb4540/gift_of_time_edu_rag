import { Handler } from '@netlify/functions';
import { Client } from 'pg';

export const handler: Handler = async (event, context) => {
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

  const client = new Client({
    connectionString: process.env.NETLIFY_DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();

    // Create schemas if they don't exist
    await client.query('CREATE SCHEMA IF NOT EXISTS core');
    await client.query('CREATE SCHEMA IF NOT EXISTS rag');

    // Enable vector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create core.users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS core.users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'student',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create rag.documents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag.documents (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        content TEXT NOT NULL,
        embedding VECTOR(1536),
        metadata JSONB DEFAULT '{}',
        source_url VARCHAR(1000),
        document_type VARCHAR(100) DEFAULT 'text',
        created_by INTEGER REFERENCES core.users(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create rag.embeddings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag.embeddings (
        id SERIAL PRIMARY KEY,
        document_id INTEGER REFERENCES rag.documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash VARCHAR(64) UNIQUE,
        embedding VECTOR(1536),
        token_count INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create rag.retrieval_logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rag.retrieval_logs (
        id SERIAL PRIMARY KEY,
        request_id VARCHAR(36) UNIQUE NOT NULL,
        query_text TEXT NOT NULL,
        chunk_ids INTEGER[] NOT NULL,
        latency_ms INTEGER NOT NULL,
        doc_id VARCHAR(255),
        top_k INTEGER DEFAULT 5,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_document_id 
      ON rag.embeddings(document_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_embedding 
      ON rag.embeddings USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_content_hash 
      ON rag.embeddings(content_hash)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_created_by 
      ON rag.documents(created_by)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_document_type 
      ON rag.documents(document_type)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_request_id 
      ON rag.retrieval_logs(request_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created_at 
      ON rag.retrieval_logs(created_at)
    `);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: JSON.stringify({ 
        migrated: true,
        message: 'Database migration completed successfully',
        tables: ['core.users', 'rag.documents', 'rag.embeddings', 'rag.retrieval_logs']
      })
    };

  } catch (error) {
    console.error('Migration error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: JSON.stringify({ 
        error: 'Migration failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  } finally {
    await client.end();
  }
};
