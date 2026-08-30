import assert from 'node:assert/strict';
import test from 'node:test';
import { relayOpenRouterStream } from '../src/services/openRouterStream.service.js';

const responseFrom = (...chunks) => ({
  body: new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }),
});

const responseSink = () => ({
  writableEnded: false,
  output: '',
  write(value) { this.output += value; },
});

test('OpenRouter relay preserves a final SSE line without a trailing newline', async () => {
  const sink = responseSink();
  const result = await relayOpenRouterStream(responseFrom(
    'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n',
    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}',
  ), sink);

  assert.equal(result.tokenCount, 2);
  assert.equal(result.completed, true);
  assert.equal(result.finishReason, 'stop');
  assert.match(sink.output, /Hello /);
  assert.match(sink.output, /world/);
});

test('OpenRouter relay marks a silently truncated stream as incomplete', async () => {
  const sink = responseSink();
  const result = await relayOpenRouterStream(responseFrom(
    'data: {"choices":[{"delta":{"content":"Only a few words"},"finish_reason":null}]}\n',
  ), sink);

  assert.equal(result.tokenCount, 1);
  assert.equal(result.completed, false);
  assert.equal(result.finishReason, null);
});
