exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({ 
      message: 'Test function working',
      method: event.httpMethod,
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      url: process.env.URL
    })
  };
};
