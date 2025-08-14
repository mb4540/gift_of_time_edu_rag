import { Handler } from '@netlify/functions';
import { Client } from 'pg';
import OpenAI from 'openai';

interface QueryInput {
  prompt: string;
  doc_id?: string;
  top_k?: number;
}

interface ChunkResult {
  id: number;
  content: string;
  chunk_index: number;
  similarity: number;
  document_title?: string;
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Get embedding for query
async function getQueryEmbedding(query: string): Promise<number[]> {
  const response = await openai.embeddings.create({
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

  try {
    const input: QueryInput = JSON.parse(event.body || '{}');
    const { prompt, doc_id, top_k = 5 } = input;
    
    if (!prompt?.trim()) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Missing prompt' })
      };
    }

    console.log(`RAG query: "${prompt}" ${doc_id ? `for doc ${doc_id}` : 'across all documents'}`);

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
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            chunks: [],
            answer: "No relevant information found in the knowledge base.",
            streaming: false
          })
        };
      }
      
      // Pack context with citations
      const contextWithCitations = packContextWithCitations(chunks);
      
      console.log(`Found ${chunks.length} relevant chunks, generating response...`);
      
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
          body: await streamChatCompletion(contextWithCitations, prompt, chunks)
        };
      } else {
        // Return regular JSON response with non-streaming completion
        const completion = await openai.chat.completions.create({
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
            chunks: chunks.map(chunk => ({
              id: chunk.id,
              content: chunk.content.substring(0, 200) + '...', // Truncate for display
              chunk_index: chunk.chunk_index,
              similarity: chunk.similarity,
              document_title: chunk.document_title
            })),
            answer,
            streaming: false
          })
        };
      }
      
    } finally {
      await client.end();
    }

  } catch (error) {
    console.error('RAG query error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'RAG query failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};

// Stream chat completion as SSE
async function streamChatCompletion(
  context: string, 
  prompt: string, 
  chunks: ChunkResult[]
): Promise<string> {
  try {
    const stream = await openai.chat.completions.create({
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
    
    // Send chunks first
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
