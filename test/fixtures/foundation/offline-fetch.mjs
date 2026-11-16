// Install before the CLI entry so its HTTP setup preserves this offline test replacement.
import { installHttpStack } from '../../../dist/http/fetch.js';
installHttpStack();
globalThis.fetch = async url => {
  if (String(url).endsWith('/api/tags') && process.env.ROUNDTABLE_TEST_OLLAMA_TAGS) {
    return new Response(process.env.ROUNDTABLE_TEST_OLLAMA_TAGS, { headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline fixture: no HTTP requests');
};
