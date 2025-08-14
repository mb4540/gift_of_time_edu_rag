import { Handler, HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';
import { Client } from 'pg';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { validateRequestBody, createErrorResponse, ErrorCodes, checkRateLimit, getClientIP } from './shared/utils';

// Zod schema for input validation
const QueryInputSchema = z.object({
  prompt: z.string().min(1, 'Prompt cannot be empty').max(2000, 'Prompt too long'),
  doc_id: z.string().optional(),
  top_k: z.number().int().min(1).max(20).optional().default(5)
});

type QueryInput = z.infer<typeof QueryInputSchema>;

interface QueryResponse {
  request_id: string;
  chunks: ChunkResult[];
  answer: string;
  streaming: boolean;
  latency_ms?: number;
}

interface ChunkResult {
  id: number;
  content: string;
  chunk_index: number;
  similarity: number;
  document_title?: string;
}

// Initialize OpenAI client (lazy initialization)
function getOpenAIClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Log retrieval to database
async function logRetrieval(
  client: Client,
  requestId: string,
  queryText: string,
  chunkIds: number[],
  latencyMs: number,
  docId?: string,
  topK: number = 5
): Promise<void> {
  try {
    await client.query(`
      INSERT INTO rag.retrieval_logs (request_id, query_text, chunk_ids, latency_ms, doc_id, top_k)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [requestId, queryText, chunkIds, latencyMs, docId, topK]);
  } catch (error) {
    console.error('Failed to log retrieval:', error);
    // Don't throw - logging failure shouldn't break the query
  }
}

// Get embedding for query
async function getQueryEmbedding(query: string): Promise<number[]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
    encoding_format: 'float'
  });
  
  return response.data[0].embedding;
}

// Perform vector similarity search
async function vectorSearch(
  client: Client, 
  queryEmbedding: number[], 
  docId?: string, 
  topK: number = 5
): Promise<ChunkResult[]> {
  let query = `
    SELECT 
      e.id,
      e.content,
      e.chunk_index,
      d.title as document_title,
      1 - (e.embedding <=> $1) as similarity
    FROM rag.embeddings e
    JOIN rag.documents d ON e.document_id = d.id
  `;
  
  const params: any[] = [`[${queryEmbedding.join(',')}]`];
  
  if (docId) {
    query += ` WHERE d.metadata->>'doc_id' = $2`;
    params.push(docId);
  }
  
  query += ` ORDER BY e.embedding <=> $1 LIMIT $${params.length + 1}`;
  params.push(topK);
  
  const result = await client.query(query, params);
  
  return result.rows.map(row => ({
    id: row.id,
    content: row.content,
    chunk_index: row.chunk_index,
    similarity: parseFloat(row.similarity),
    document_title: row.document_title
  }));
}

// Pack context with citations
function packContextWithCitations(chunks: ChunkResult[]): string {
  let context = "Based on the following information:\n\n";
  
  chunks.forEach((chunk, index) => {
    const citationId = index + 1;
    context += `[${citationId}] ${chunk.content}\n\n`;
  });
  
  context += "Please answer the user's question using the information above. ";
  context += "Include citations in your response using the format [1], [2], etc. ";
  context += "If the information doesn't contain relevant details to answer the question, say so clearly.";
  
  return context;
}

export const handler = async (event: HandlerEvent, context: HandlerContext): Promise<HandlerResponse> => {
  if (event.httpMethod !== 'POST') {
    return createErrorResponse(405, 'Method not allowed', ErrorCodes.METHOD_NOT_ALLOWED);
  }

  try {
    // Rate limiting
    const clientIP = getClientIP(event);
    const rateLimitResult = checkRateLimit(clientIP);
    if (!rateLimitResult.allowed) {
      return createErrorResponse(429, rateLimitResult.error.error, rateLimitResult.error.code, rateLimitResult.error.details);
    }

    // Input validation
    const validationResult = validateRequestBody(event.body, QueryInputSchema);
    if (!validationResult.success) {
      return createErrorResponse(400, validationResult.error.error, validationResult.error.code, validationResult.error.details);
    }

    const { prompt, doc_id, top_k } = validationResult.data;

    // Generate request ID and start timing
    const requestId = randomUUID();
    const startTime = Date.now();

    console.log(`RAG query [${requestId}]: "${prompt}" ${doc_id ? `for doc ${doc_id}` : 'across all documents'}`);

    // Connect to database
    const client = new Client({
      connectionString: process.env.NETLIFY_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    await client.connect();
    
    try {
      // Get query embedding
      console.log('Generating query embedding...');
      const queryEmbedding = await getQueryEmbedding(prompt);
      
      // Perform vector search
      console.log('Performing vector search...');
      const chunks = await vectorSearch(client, queryEmbedding, doc_id, top_k);
      
      if (chunks.length === 0) {
        const latencyMs = Date.now() - startTime;
        
        // Log the query even if no chunks found
        await logRetrieval(client, requestId, prompt, [], latencyMs, doc_id, top_k);
        
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            request_id: requestId,
            chunks: [],
            answer: "No relevant information found in the knowledge base.",
            streaming: false,
            latency_ms: latencyMs
          })
        };
      }
      
      // Pack context with citations
      const contextWithCitations = packContextWithCitations(chunks);
      
      console.log(`Found ${chunks.length} relevant chunks, generating response...`);
      
      // Calculate latency and log retrieval
      const latencyMs = Date.now() - startTime;
      const chunkIds = chunks.map(chunk => chunk.id);
      
      // Log the retrieval
      await logRetrieval(client, requestId, prompt, chunkIds, latencyMs, doc_id, top_k);
      
      // Check if client accepts Server-Sent Events
      const acceptsSSE = event.headers.accept?.includes('text/event-stream');
      
      if (acceptsSSE) {
        // Return SSE stream
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
          },
          body: await streamChatCompletion(contextWithCitations, prompt, chunks, requestId, latencyMs)
        };
      } else {
        // Return regular JSON response with non-streaming completion
        const client = getOpenAIClient();
        const completion = await client.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: contextWithCitations },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 1000
        });
        
        const answer = completion.choices[0]?.message?.content || 'No response generated.';
        
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            request_id: requestId,
            chunks: chunks.map(chunk => ({
              id: chunk.id,
              content: chunk.content.substring(0, 200) + '...', // Truncate for display
              chunk_index: chunk.chunk_index,
              similarity: chunk.similarity,
              document_title: chunk.document_title
            })),
            answer,
            streaming: false,
            latency_ms: latencyMs
          })
        };
      }
      
    } finally {
      await client.end();
    }

  } catch (error) {
    console.error('RAG query error:', error);
    
    // Determine error type and code
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let errorMessage = 'RAG query failed';
    
    if (error instanceof Error) {
      if (error.message.includes('database') || error.message.includes('connection')) {
        errorCode = ErrorCodes.DATABASE_ERROR;
        errorMessage = 'Database connection failed';
      } else if (error.message.includes('OpenAI') || error.message.includes('API')) {
        errorCode = ErrorCodes.EXTERNAL_API_ERROR;
        errorMessage = 'External API error';
      }
    }
    
    return createErrorResponse(500, errorMessage, errorCode, {
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Stream chat completion as SSE
async function streamChatCompletion(
  context: string, 
  prompt: string, 
  chunks: ChunkResult[],
  requestId: string,
  latencyMs: number
): Promise<string> {
  try {
    const client = getOpenAIClient();
    const stream = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: context },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 1000,
      stream: true
    });

    let sseResponse = '';
    
    // Send metadata first
    sseResponse += `data: ${JSON.stringify({
      type: 'metadata',
      request_id: requestId,
      latency_ms: latencyMs
    })}\n\n`;
    
    // Send chunks
    sseResponse += `data: ${JSON.stringify({
      type: 'chunks',
      chunks: chunks.map(chunk => ({
        id: chunk.id,
        content: chunk.content.substring(0, 200) + '...',
        chunk_index: chunk.chunk_index,
        similarity: chunk.similarity,
        document_title: chunk.document_title
      }))
    })}\n\n`;

    // Stream the completion
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        sseResponse += `data: ${JSON.stringify({
          type: 'token',
          content
        })}\n\n`;
      }
    }
    
    // Send end signal
    sseResponse += `data: ${JSON.stringify({ type: 'end' })}\n\n`;
    
    return sseResponse;
    
  } catch (error) {
    console.error('Streaming error:', error);
    return `data: ${JSON.stringify({
      type: 'error',
      error: error instanceof Error ? error.message : 'Streaming failed'
    })}\n\n`;
  }
}
