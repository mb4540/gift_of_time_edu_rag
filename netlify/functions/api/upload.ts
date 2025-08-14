import { Handler } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Client } from 'pg';
import busboy from 'busboy';
import { Readable } from 'stream';

interface UploadData {
  file?: {
    buffer: Buffer;
    filename: string;
    mimetype: string;
  };
  title?: string;
  type?: string;
  tenant_id?: string;
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
    const uploadData: UploadData = {};
    
    // Parse multipart form data
    await new Promise<void>((resolve, reject) => {
      const bb = busboy({
        headers: {
          'content-type': event.headers['content-type'] || event.headers['Content-Type'] || ''
        }
      });

      bb.on('file', (name, file, info) => {
        const { filename, mimeType } = info;
        const chunks: Buffer[] = [];
        
        file.on('data', (chunk) => {
          chunks.push(chunk);
        });
        
        file.on('end', () => {
          uploadData.file = {
            buffer: Buffer.concat(chunks),
            filename: filename || 'unknown',
            mimetype: mimeType || 'application/octet-stream'
          };
        });
      });

      bb.on('field', (name, value) => {
        if (name === 'title') uploadData.title = value;
        if (name === 'type') uploadData.type = value;
        if (name === 'tenant_id') uploadData.tenant_id = value;
      });

      bb.on('close', () => {
        resolve();
      });

      bb.on('error', (err) => {
        reject(err);
      });

      // Convert base64 body to buffer and pipe to busboy
      if (event.body) {
        const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
        const readable = Readable.from(bodyBuffer);
        readable.pipe(bb);
      } else {
        reject(new Error('No body provided'));
      }
    });

    // Validate required fields
    if (!uploadData.file) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'No file provided' })
      };
    }

    if (!uploadData.title || !uploadData.type || !uploadData.tenant_id) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Missing required fields: title, type, tenant_id' })
      };
    }

    // Generate document ID
    const doc_id = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Get file extension
    const filename = uploadData.file.filename;
    const ext = filename.split('.').pop() || 'bin';
    
    // Save file to Blobs
    const store = getStore('uploads');
    const blobPath = `${uploadData.tenant_id}/${doc_id}/original.${ext}`;
    await store.set(blobPath, uploadData.file.buffer);

    // Insert into database
    const client = new Client({
      connectionString: process.env.NETLIFY_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    await client.connect();
    
    try {
      const result = await client.query(`
        INSERT INTO rag.documents (
          title, 
          content, 
          document_type, 
          metadata,
          source_url,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING id
      `, [
        uploadData.title,
        '', // Content will be extracted later
        uploadData.type,
        JSON.stringify({
          status: 'UPLOADED',
          original_filename: filename,
          mimetype: uploadData.file.mimetype,
          tenant_id: uploadData.tenant_id,
          doc_id: doc_id,
          blob_path: blobPath,
          file_size: uploadData.file.buffer.length
        }),
        blobPath
      ]);

      const dbDocId = result.rows[0].id;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          doc_id: doc_id,
          db_id: dbDocId,
          blob_path: blobPath,
          file_size: uploadData.file.buffer.length,
          status: 'UPLOADED'
        })
      };

    } finally {
      await client.end();
    }

  } catch (error) {
    console.error('Upload error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        error: 'Upload failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
