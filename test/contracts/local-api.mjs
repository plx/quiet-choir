// Local fake APIs for real-CLI envelope capture. No upstream transport exists in this server.
import { createServer } from 'node:http';

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fixture' });
  response.end(JSON.stringify(value));
}
function event(response, value) {
  response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function anthropic(response, body, scenario, requestedTool) {
  const usage = {
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const structured = body.tools?.find((tool) => /structured/iu.test(tool.name));
  const last = body.messages?.at(-1);
  const receivedToolResult =
    Array.isArray(last?.content) && last.content.some((block) => block.type === 'tool_result');
  const loop = scenario === 'claude-turn-limit';
  const tool =
    requestedTool ||
    ((loop || scenario === 'claude-structured-success') &&
      structured &&
      (!receivedToolResult || loop));
  const block = tool
    ? {
        type: 'tool_use',
        id: 'toolu_fixture',
        name: requestedTool?.name ?? structured.name,
        input: {},
      }
    : { type: 'text', text: '' };
  const text = scenario === 'claude-structured-success' ? 'done' : 'hello from captured claude';
  const input = requestedTool?.input ?? (loop ? { answer: 42 } : { answer: 'captured answer' });
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' });
  event(response, {
    type: 'message_start',
    message: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  event(response, { type: 'content_block_start', index: 0, content_block: block });
  event(response, {
    type: 'content_block_delta',
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
      : { type: 'text_delta', text },
  });
  event(response, { type: 'content_block_stop', index: 0 });
  event(response, {
    type: 'message_delta',
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  event(response, { type: 'message_stop' });
  response.end();
}
function responses(response, scenario, count) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const id = `resp_fixture_${count}`;
  event(response, { type: 'response.created', response: { id } });
  if (scenario === 'codex-reconnect-success' && count === 1) {
    event(response, {
      type: 'response.output_item.added',
      item: { type: 'message', role: 'assistant', id: 'msg_fixture', content: [] },
    });
    setTimeout(() => response.destroy(), 50);
    return;
  }
  const text =
    scenario === 'codex-structured-success'
      ? '{"answer":"captured answer"}'
      : 'hello from captured codex';
  event(response, {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      role: 'assistant',
      id: 'msg_fixture',
      content: [{ type: 'output_text', text }],
    },
  });
  event(response, {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: scenario === 'codex-usage-success' ? 100 : 10,
        input_tokens_details: {
          cached_tokens: scenario === 'codex-usage-success' ? 40 : 0,
          cache_write_tokens: scenario === 'codex-usage-success' ? 20 : 0,
        },
        output_tokens: scenario === 'codex-usage-success' ? 30 : 3,
        output_tokens_details: { reasoning_tokens: scenario === 'codex-usage-success' ? 12 : 0 },
        total_tokens: scenario === 'codex-usage-success' ? 130 : 13,
      },
    },
  });
  response.end();
}

export async function fakeApi(scenario, options = {}) {
  let count = 0;
  let claudeCalls = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const bytes of request) text += bytes;
      const body = JSON.parse(text || '{}');
      // Record only shape diagnostics, never headers or credential values.
      requests.push({ url: request.url, model: body.model ?? null, stream: body.stream ?? null });
      options.onRequest?.({ url: request.url, body });
      if (request.url.includes('count_tokens')) return json(response, 200, { input_tokens: 7 });
      if (request.url.startsWith('/v1/messages')) {
        if (scenario === 'claude-api-error')
          return json(response, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Contract fixture API error (fake)' },
          });
        if (!body.stream)
          return json(response, 200, {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'hello from captured claude' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 3 },
          });
        anthropic(response, body, scenario, claudeCalls++ === 0 ? options.tool : undefined);
      } else if (request.url.includes('/responses')) {
        if (scenario === 'codex-invalid-schema')
          return json(response, 400, {
            error: {
              type: 'invalid_request_error',
              code: 'invalid_json_schema',
              param: 'text.format.schema',
              message:
                "Invalid schema for response_format 'output': required must include every property (fake).",
            },
          });
        // Doctor probe scenarios: the server rejects the invalid effort or the unknown model first.
        if (scenario === 'codex-doctor-effort-first')
          return json(response, 400, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: null,
              message:
                "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
              param: null,
            },
            status: 400,
          });
        if (scenario === 'codex-doctor-model-first')
          return json(response, 404, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'model_not_found',
              message: `The model \`${body.model}\` does not exist or you do not have access to it.`,
              param: null,
            },
            status: 404,
          });
        responses(response, scenario, ++count);
      } else
        json(response, 404, { error: { message: 'No upstream API: local contract server only.' } });
    } catch (error) {
      json(response, 500, { error: { message: error.message } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
