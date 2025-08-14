import { z } from 'zod';

// Structured error response
export interface ApiError {
  error: string;
  code: string;
  details?: any;
}

// Error codes
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_API_ERROR: 'EXTERNAL_API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD'
} as const;

// Create structured error response
export function createErrorResponse(
  statusCode: number,
  error: string,
  code: string,
  details?: any
): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify({
      error,
      code,
      ...(details && { details })
    })
  };
}

// Validate request body with zod
export function validateRequestBody<T>(
  body: string | null,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: ApiError } {
  try {
    if (!body) {
      return {
        success: false,
        error: {
          error: 'Request body is required',
          code: ErrorCodes.MISSING_REQUIRED_FIELD
        }
      };
    }

    const parsed = JSON.parse(body);
    const result = schema.safeParse(parsed);
    
    if (!result.success) {
      return {
        success: false,
        error: {
          error: 'Validation failed',
          code: ErrorCodes.VALIDATION_ERROR,
          details: result.error.issues
        }
      };
    }

    return { success: true, data: result.data };
  } catch (parseError) {
    return {
      success: false,
      error: {
        error: 'Invalid JSON in request body',
        code: ErrorCodes.VALIDATION_ERROR,
        details: parseError instanceof Error ? parseError.message : 'Unknown parse error'
      }
    };
  }
}

// In-memory rate limiting (dev only - TODO: move to DB/edge for production)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute

export function checkRateLimit(ip: string): { allowed: true } | { allowed: false; error: ApiError } {
  const now = Date.now();
  const key = ip;
  
  // Clean up expired entries
  for (const [k, v] of rateLimitMap.entries()) {
    if (v.resetTime < now) {
      rateLimitMap.delete(k);
    }
  }
  
  const current = rateLimitMap.get(key);
  
  if (!current) {
    // First request from this IP
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  
  if (current.resetTime < now) {
    // Window expired, reset
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    // Rate limit exceeded
    return {
      allowed: false,
      error: {
        error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX_REQUESTS} requests per minute.`,
        code: ErrorCodes.RATE_LIMITED,
        details: {
          resetTime: current.resetTime,
          maxRequests: RATE_LIMIT_MAX_REQUESTS,
          windowMs: RATE_LIMIT_WINDOW
        }
      }
    };
  }
  
  // Increment counter
  current.count++;
  return { allowed: true };
}

// Get client IP from event
export function getClientIP(event: any): string {
  return event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         event.headers['x-real-ip'] || 
         event.headers['cf-connecting-ip'] || 
         'unknown';
}
