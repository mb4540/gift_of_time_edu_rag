import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Client } from 'pg';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { createHash } from 'crypto';

interface IngestInput {
  doc_id: string;
  tenant_id: string;
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

// Generate fake embedding from SHA256 hash
function generateFakeEmbedding(text: string): number[] {
  const hash = createHash('sha256').update(text).digest('hex');
  const embedding: number[] = [];
  
  // Convert hex to 1536 dimensional vector
  for (let i = 0; i < 1536; i++) {
    const hexIndex = (i * 2) % hash.length;
    const hexPair = hash.substr(hexIndex, 2);
    const value = parseInt(hexPair, 16) / 255; // Normalize to 0-1
    embedding.push((value - 0.5) * 2); // Center around 0, range -1 to 1
  }
  
  return embedding;
}

// Extract text based on file type
async function extractText(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  try {
    if (mimetype.includes('pdf') || ext === 'pdf') {
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
    const { doc_id, tenant_id } = input;
    
    if (!doc_id || !tenant_id) {
      throw new Error('Missing doc_id or tenant_id');
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
      const docResult = await client.query(
        'SELECT id, title, metadata FROM rag.documents WHERE metadata->>\'doc_id\' = $1',
        [doc_id]
      );
      
      if (docResult.rows.length === 0) {
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
      const blobPath = metadata.blob_path;
      const fileBuffer = await store.get(blobPath);
      
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
      
      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tokenCount = estimateTokens(chunk);
        const embedding = generateFakeEmbedding(chunk);
        
        // Store embedding in database
        await client.query(`
          INSERT INTO rag.embeddings (
            document_id, 
            chunk_index, 
            content, 
            embedding, 
            token_count,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        `, [
          dbDocId,
          i,
          chunk,
          `[${embedding.join(',')}]`, // Store as array string
          tokenCount
        ]);
      }
      
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
      body: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
