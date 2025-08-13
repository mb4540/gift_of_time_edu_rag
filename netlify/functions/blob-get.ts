import { getStore } from '@netlify/blobs';

export const handler = async (event: any) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const key = event.queryStringParameters?.key;
    if (!key) {
      return { statusCode: 400, body: 'Missing key' };
    }
    const store = getStore('teacher-artifacts');
    const value = await store.get(key);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value })
    };
  } catch (err: any) {
    return { statusCode: 500, body: 'Error: ' + err?.message };
  }
};
