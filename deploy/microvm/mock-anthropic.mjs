// deploy/microvm/mock-anthropic.mjs
//
// A scripted, loopback-only stand-in for the Anthropic Messages API, for the P4 live run (#369).
// It lets the automated run drive REAL harness turns -- real Pi agent loop, real tool calls through
// the relay into microVMs -- without a paid model or a model's choices. Each turn is keyed on its
// own prompt marker (the last plain-text user message), and the step is the number of tool_results
// after it. Not a general mock: anything unscripted is a 400.
import { createServer } from 'node:http';

const SCRIPTS = {
  'P4-SMOKE-WRITE': {
    steps: [
      'uname -r; cat /etc/moca-rootfs-source; echo p4-proof > proof.txt; pwd',
      "git init -q repo && git -C repo status --short --branch && python3 -c 'print(6*7)' && rg --version | head -1",
    ],
    done: 'done-write',
  },
  'P4-SMOKE-READ': {
    steps: ['cat proof.txt; test -d repo/.git && echo continuity-ok || echo continuity-missing'],
    done: 'done-read',
  },
  'P4-SMOKE-SLEEP': { steps: ['sleep 90; echo slept'], done: 'done-sleep' },
  // deploy/k8s/smoke.sh (#423). Each smoke prompt ALSO spells out its command in words, so a real
  // model can run the same smoke; the mock keys on the marker alone.
  'K8S-SMOKE-WRITE': {
    steps: ['uname -s; echo k8s-proof | tee proof.txt; pwd'],
    done: 'done-k8s-write',
  },
  'K8S-SMOKE-AGAIN': { steps: ['echo second-turn'], done: 'done-k8s-again' },
  'K8S-SMOKE-RESEARCH': {
    steps: [
      'curl -sI https://example.com | head -1; echo "git-head=$(git ls-remote https://github.com/rossoctl/moca HEAD | cut -c1-12)"',
    ],
    done: 'done-k8s-research',
  },
  // Well inside the supervisor's 20s SHUTDOWN_GRACE_MS, so a drain lets it finish.
  'K8S-SMOKE-DRAIN': { steps: ['sleep 8; echo drained'], done: 'done-k8s-drain' },
};

const isToolResult = (m) =>
  m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');

function textOf(m) {
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// A tool_result's content is either a string or an array of blocks; the text is what the tool printed.
function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * { marker, step, results } for this request, or null if the prompt is unscripted. `results` are the
 * tool outputs this turn has produced so far, oldest first.
 */
export function plan(messages) {
  let i = messages.length - 1;
  let step = 0;
  const results = [];
  for (; i >= 0; i--) {
    const m = messages[i];
    if (isToolResult(m)) {
      step++;
      for (const b of m.content) if (b.type === 'tool_result') results.unshift(resultText(b));
    } else if (m.role === 'user') break;
  }
  if (i < 0) return null;
  const text = textOf(messages[i]);
  const marker = Object.keys(SCRIPTS).find((k) => text.includes(k));
  return marker ? { marker, step, results } : null;
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events)
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

let seq = 0;
function reply(res, model, { marker, step, results }) {
  const s = SCRIPTS[marker];
  const id = `msg_mock_${++seq}`;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const start = [
    'message_start',
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  ];
  const stop = (reason) => [
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  if (step < s.steps.length) {
    const input = JSON.stringify({ command: s.steps[step] });
    return sse(res, [
      start,
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_mock_${seq}`, name: 'bash', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: input },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ...stop('tool_use'),
    ]);
  }
  // The final text echoes every tool result: a non-streaming /turn returns only the last assistant
  // message's text (harness/src/run-turn.ts), so this is how the turn driver sees what ran.
  return sse(res, [
    start,
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: [s.done, ...results].join('\n') },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ...stop('end_turn'),
  ]);
}

const argPort = process.argv.indexOf('--port');
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : 18099;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return res.writeHead(404).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    const p = plan(parsed.messages ?? []);
    if (!p) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'unscripted prompt' },
        }),
      );
    }
    console.error(`step ${p.marker} ${p.step}`);
    reply(res, parsed.model ?? 'mock-p4', p);
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mock-anthropic listening on 127.0.0.1:${server.address().port}`);
});
// As a container's PID 1 (deploy/k8s kind-ci) Node gets no default SIGTERM action, so without this
// the mock ignores the stop signal and holds its pod for the whole termination grace period.
process.on('SIGTERM', () => process.exit(0));
