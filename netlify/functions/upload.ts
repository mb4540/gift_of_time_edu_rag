import { Handler, HandlerEvent, HandlerContext, HandlerResponse } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { Client } from 'pg';
import busboy from 'busboy';
import { Readable } from 'stream';
import { createErrorResponse, ErrorCodes, checkRateLimit, getClientIP } from './shared/utils';

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

export const handler = async (event: HandlerEvent, context: HandlerContext): Promise<HandlerResponse> => {
  if (event.httpMethod !== 'POST') {
    return createErrorResponse(405, 'Method not allowed', ErrorCodes.METHOD_NOT_ALLOWED);
  }

  // Rate limiting
  const clientIP = getClientIP(event);
  const rateLimitResult = checkRateLimit(clientIP);
  if (!rateLimitResult.allowed) {
    return createErrorResponse(429, rateLimitResult.error.error, rateLimitResult.error.code, rateLimitResult.error.details);
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
      return createErrorResponse(400, 'No file provided', ErrorCodes.MISSING_REQUIRED_FIELD);
    }

    if (!uploadData.title || !uploadData.type || !uploadData.tenant_id) {
      return createErrorResponse(400, 'Missing required fields: title, type, tenant_id', ErrorCodes.VALIDATION_ERROR, {
        missing: ['title', 'type', 'tenant_id'].filter(field => !uploadData[field as keyof UploadData])
      });
    }

    // Validate file size (10MB limit)
    if (uploadData.file.buffer.length > 10 * 1024 * 1024) {
      return createErrorResponse(400, 'File too large. Maximum size is 10MB', ErrorCodes.VALIDATION_ERROR, {
        fileSize: uploadData.file.buffer.length,
        maxSize: 10 * 1024 * 1024
      });
    }

    // Generate document ID
    const doc_id = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Get file extension
    const filename = uploadData.file.filename;
    const ext = filename.split('.').pop() || 'bin';
    
    // Save file to Blobs with proper error handling
    let blobPath = `${uploadData.tenant_id}/${doc_id}/original.${ext}`;
    let blobStorageSuccess = false;
    
    try {
      // Configure Netlify Blobs with explicit siteID and token for production
      // Use built-in Netlify environment variables that are automatically available
      const siteId = process.env.NETLIFY_SITE_ID || '88476d1e-df1f-4215-93fc-49e736b65d4e';
      const token = process.env.NETLIFY_TOKEN;
      
      let store;
      if (siteId && token) {
        // Use explicit configuration for production
        console.log('Using explicit Netlify Blobs configuration with siteID:', siteId.substring(0, 8) + '...');
        store = getStore({
          name: 'uploads',
          siteID: siteId,
          token: token
        });
      } else {
        // Try automatic configuration first (works in some Netlify environments)
        console.log('Attempting automatic Netlify Blobs configuration...');
        store = getStore('uploads');
      }
      
      await store.set(blobPath, uploadData.file.buffer as unknown as ArrayBuffer);
      blobStorageSuccess = true;
      console.log('Successfully stored file in Netlify Blobs:', blobPath);
    } catch (blobError) {
      console.error('Netlify Blobs error:', blobError);
      
      // If Netlify Blobs is not configured, provide helpful error message
      if (blobError instanceof Error && blobError.message.includes('environment has not been configured')) {
        return createErrorResponse(503, 'File storage service not configured. Please configure Netlify Blobs for this site.', ErrorCodes.EXTERNAL_API_ERROR, {
          message: 'Netlify Blobs requires site configuration. Please claim the site and run: netlify blobs:create uploads',
          blobError: blobError.message
        });
      }
      
      // For other blob storage errors
      return createErrorResponse(500, 'File storage failed', ErrorCodes.EXTERNAL_API_ERROR, {
        message: blobError instanceof Error ? blobError.message : 'Unknown blob storage error'
      });
    }

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
    
    let errorCode: string = ErrorCodes.INTERNAL_ERROR;
    let errorMessage = 'Upload failed';
    
    if (error instanceof Error) {
      if (error.message.includes('database') || error.message.includes('connection')) {
        errorCode = ErrorCodes.DATABASE_ERROR;
        errorMessage = 'Database error during upload';
      } else if (error.message.includes('blob') || error.message.includes('storage')) {
        errorCode = ErrorCodes.EXTERNAL_API_ERROR;
        errorMessage = 'File storage error';
      } else if (error.message.includes('busboy') || error.message.includes('multipart')) {
        errorCode = ErrorCodes.VALIDATION_ERROR;
        errorMessage = 'Invalid file upload format';
      }
    }
    
    return createErrorResponse(500, errorMessage, errorCode, {
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
