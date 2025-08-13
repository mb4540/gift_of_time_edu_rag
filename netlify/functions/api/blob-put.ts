import { getStore } from '@netlify/blobs';

export const handler = async (event: any) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }
    const data = event.body ? JSON.parse(event.body) : {};
    const key = data.key;
    const value = data.value;
    if (!key || typeof value === 'undefined') {
      return { statusCode: 400, body: 'Missing key or value' };
    }
    const store = getStore('teacher-artifacts');
    await store.set(key, value);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stored: key })
    };
  } catch (err: any) {
    return { statusCode: 500, body: 'Error: ' + err?.message };
  }
};
