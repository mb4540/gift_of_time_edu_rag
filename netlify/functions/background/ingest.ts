import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Client } from 'pg';
import mammoth from 'mammoth';
import { createHash } from 'crypto';
import OpenAI from 'openai';

interface IngestInput {
  doc_id?: string;
  tenant_id?: string;
  blob_key?: string;     // optional alternative to doc_id
  blob_url?: string;     // optional alternative to doc_id
}

// Simple word-based tokenizer approximation
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3); // Rough estimate: 1.3 tokens per word
}

// Text cleaning function
function cleanText(text: string): string {
  return text
    // Remove headers/footers patterns
    .replace(/^(Page \d+|\d+\s*$)/gm, '')
    .replace(/^(Chapter \d+|Section \d+)/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

// Word-based chunking with overlap
function chunkText(text: string, maxTokens: number = 700, overlapTokens: number = 120): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  const wordsPerToken = 1 / 1.3; // Inverse of token estimation
  const maxWords = Math.floor(maxTokens * wordsPerToken);
  const overlapWords = Math.floor(overlapTokens * wordsPerToken);
  
  let start = 0;
  
  while (start < words.length) {
    const end = Math.min(start + maxWords, words.length);
    const chunk = words.slice(start, end).join(' ');
    
    if (chunk.trim()) {
      chunks.push(chunk.trim());
    }
    
    // Move start position with overlap
    start = end - overlapWords;
    if (start >= words.length) break;
  }
  
  return chunks;
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Sleep utility for retry backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate content hash for caching
function generateContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Get embeddings with retry and backoff
async function getEmbeddingWithRetry(text: string, maxRetries: number = 3): Promise<number[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        encoding_format: 'float'
      });
      
      return response.data[0].embedding;
    } catch (error) {
      console.error(`Embedding attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const backoffMs = Math.pow(2, attempt - 1) * 1000;
      await sleep(backoffMs);
    }
  }
  
  throw new Error('Max retries exceeded');
}

// Batch process embeddings with caching
async function processEmbeddingsBatch(
  chunks: string[], 
  client: Client, 
  dbDocId: number
): Promise<void> {
  const batchSize = 10; // Process 10 chunks at a time
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(`Processing embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chunks.length / batchSize)}`);
    
    // Process batch in parallel with individual retry logic
    const embeddingPromises = batch.map(async (chunk, batchIndex) => {
      const chunkIndex = i + batchIndex;
      const contentHash = generateContentHash(chunk);
      
      try {
        // Check if embedding already exists (hash-based cache)
        const existingResult = await client.query(
          'SELECT embedding FROM rag.embeddings WHERE content_hash = $1',
          [contentHash]
        );
        
        let embedding: number[];
        
        if (existingResult.rows.length > 0) {
          console.log(`Using cached embedding for chunk ${chunkIndex}`);
          embedding = existingResult.rows[0].embedding;
        } else {
          console.log(`Generating new embedding for chunk ${chunkIndex}`);
          embedding = await getEmbeddingWithRetry(chunk);
        }
        
        const tokenCount = estimateTokens(chunk);
        
        // Store embedding in database
        await client.query(`
          INSERT INTO rag.embeddings (
            document_id, 
            chunk_index, 
            content, 
            content_hash,
            embedding, 
            token_count,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
          ON CONFLICT (content_hash) DO UPDATE SET
            document_id = EXCLUDED.document_id,
            chunk_index = EXCLUDED.chunk_index,
            updated_at = CURRENT_TIMESTAMP
        `, [
          dbDocId,
          chunkIndex,
          chunk,
          contentHash,
          `[${embedding.join(',')}]`, // Store as array string
          tokenCount
        ]);
        
        return { chunkIndex, success: true };
      } catch (error) {
        console.error(`Failed to process chunk ${chunkIndex}:`, error);
        return { chunkIndex, success: false, error };
      }
    });
    
    // Wait for batch to complete
    const results = await Promise.allSettled(embeddingPromises);
    
    // Check for failures
    const failures = results
      .map((result, idx) => ({ result, idx: i + idx }))
      .filter(({ result }) => result.status === 'rejected' || 
        (result.status === 'fulfilled' && !result.value.success));
    
    if (failures.length > 0) {
      console.error(`Batch had ${failures.length} failures:`, failures);
    }
    
    // Small delay between batches to avoid rate limiting
    if (i + batchSize < chunks.length) {
      await sleep(1000); // 1 second between batches
    }
  }
}

// Extract text based on file type
export async function extractText(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  try {
    if (mimetype.includes('pdf') || ext === 'pdf') {
      // Lazy-load pdf-parse to avoid cold start evaluation issues in serverless bundlers
      const pdfModule = await import('pdf-parse');
      const pdf = (pdfModule as any).default ?? pdfModule;
      const data = await pdf(buffer);
      return data.text;
    }
    
    if (mimetype.includes('word') || ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    
    if (mimetype.includes('text') || ext === 'txt') {
      return buffer.toString('utf-8');
    }
    
    // For other formats, try to extract as text
    return buffer.toString('utf-8');
    
  } catch (error) {
    console.error('Text extraction error:', error);
    throw new Error(`Failed to extract text from ${mimetype}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export const handler: Handler = async (event, context) => {
  try {
    const input: IngestInput = JSON.parse(event.body || '{}');
    const { doc_id, tenant_id, blob_key, blob_url } = input;
    
    if (!doc_id && !blob_key && !blob_url) {
      throw new Error('Missing identifier: provide doc_id or blob_key or blob_url');
    }
    
    console.log(`Starting ingestion for doc_id: ${doc_id}, tenant_id: ${tenant_id}`);
    
    // Connect to database
    const client = new Client({
      connectionString: process.env.NETLIFY_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    
    await client.connect();
    
    try {
      // Get document metadata from database
      let docResult;
      if (doc_id) {
        docResult = await client.query(
          'SELECT id, title, metadata FROM rag.documents WHERE metadata->>"doc_id" = $1',
          [doc_id]
        );
      } else if (blob_key) {
        docResult = await client.query(
          'SELECT id, title, metadata FROM rag.documents WHERE metadata->>"blob_path" = $1',
          [blob_key]
        );
      } else if (blob_url) {
        // Best-effort: derive key from URL path (last path segment(s))
        let derivedKey = '';
        try {
          const u = new URL(blob_url);
          derivedKey = u.pathname.replace(/^\//, '');
        } catch {}
        if (!derivedKey) {
          throw new Error('Unable to derive blob_key from blob_url');
        }
        docResult = await client.query(
          'SELECT id, title, metadata FROM rag.documents WHERE metadata->>"blob_path" = $1',
          [derivedKey]
        );
      }
      
      if (!docResult || docResult.rows.length === 0) {
        throw new Error(`Document not found: ${doc_id}`);
      }
      
      const document = docResult.rows[0];
      const metadata = document.metadata;
      const dbDocId = document.id;
      
      // Update status to PROCESSING
      await client.query(
        'UPDATE rag.documents SET metadata = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [JSON.stringify({ ...metadata, status: 'PROCESSING' }), dbDocId]
      );
      
      // Fetch file from Blobs
      const store = getStore('uploads');
      const blobPath = metadata.blob_path || blob_key;
      let fileBuffer: ArrayBuffer | null = null;
      if (blobPath) {
        const blobData = await store.get(blobPath);
        if (blobData) {
          fileBuffer = blobData as unknown as ArrayBuffer;
        }
      } else if (blob_url) {
        const resp = await fetch(blob_url);
        if (!resp.ok) throw new Error(`Failed to fetch blob_url: ${resp.status}`);
        const ab = await resp.arrayBuffer();
        fileBuffer = ab;
      }
      
      if (!fileBuffer) {
        throw new Error(`File not found in blob storage: ${blobPath}`);
      }
      
      // Extract text
      const rawText = await extractText(
        Buffer.from(fileBuffer),
        metadata.original_filename,
        metadata.mimetype
      );
      
      // Clean text
      const cleanedText = cleanText(rawText);
      
      if (!cleanedText.trim()) {
        throw new Error('No text content extracted from document');
      }
      
      // Chunk text
      const chunks = chunkText(cleanedText);
      
      console.log(`Generated ${chunks.length} chunks for document ${doc_id}`);
      
      // Process embeddings in batches with caching and retry logic
      await processEmbeddingsBatch(chunks, client, dbDocId);
      
      // Update document status to READY
      await client.query(
        'UPDATE rag.documents SET content = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [
          cleanedText.substring(0, 10000), // Store first 10k chars as preview
          JSON.stringify({ 
            ...metadata, 
            status: 'READY',
            chunks_count: chunks.length,
            total_tokens: chunks.reduce((sum, chunk) => sum + estimateTokens(chunk), 0),
            processed_at: new Date().toISOString()
          }),
          dbDocId
        ]
      );
      
      console.log(`Successfully processed document ${doc_id} with ${chunks.length} chunks`);
      
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          success: true,
          doc_id,
          chunks_processed: chunks.length,
          status: 'READY'
        })
      };
      
    } finally {
      await client.end();
    }
    
  } catch (error) {
    console.error('Ingestion error:', error);
    
    // Try to update document status to ERROR if possible
    try {
      const client = new Client({
        connectionString: process.env.NETLIFY_DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });
      
      await client.connect();
      
      const input: IngestInput = JSON.parse(event.body || '{}');
      if (input.doc_id) {
        await client.query(`
          UPDATE rag.documents 
          SET metadata = jsonb_set(metadata, '{status}', '"ERROR"'),
              updated_at = CURRENT_TIMESTAMP
          WHERE metadata->>'doc_id' = $1
        `, [input.doc_id]);
      }
      
      await client.end();
    } catch (dbError) {
      console.error('Failed to update error status:', dbError);
    }
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
