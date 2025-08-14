import { describe, it, expect, vi, beforeEach } from 'vitest';

// We will dynamically import the module under test after setting up mocks

describe('extractText', () => {
  beforeEach(() => {
    vi.resetModules();
    // Mock environment variables to avoid OpenAI client initialization
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('NETLIFY_DATABASE_URL', 'postgresql://test');
  });

  it('extracts text from plain text buffers', async () => {
    const mod = await import('../netlify/functions/background/ingest');
    const { extractText } = mod as any;
    const buf = Buffer.from('Hello world');
    const out = await extractText(buf, 'note.txt', 'text/plain');
    expect(out).toBe('Hello world');
  });

  it('uses pdf-parse lazily for PDFs', async () => {
    vi.mock('pdf-parse', () => ({
      default: async (_buf: Buffer) => ({ text: 'PDF TEXT' })
    }));

    const mod = await import('../netlify/functions/background/ingest');
    const { extractText } = mod as any;

    const buf = Buffer.from('%PDF-1.4');
    const out = await extractText(buf, 'file.pdf', 'application/pdf');
    expect(out).toBe('PDF TEXT');
  });
});
