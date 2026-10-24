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
  // deploy/k8s/smoke.sh --tier p4 (#424): the write and the read-back, in a microVM workspace.
  'K8S-SMOKE-P4-WRITE': {
    steps: ['uname -r; echo p4-proof | tee proof.txt'],
    done: 'done-k8s-p4-write',
  },
  'K8S-SMOKE-P4-READ': { steps: ['cat proof.txt'], done: 'done-k8s-p4-read' },
  // P6.3 claim 12: which container served the turn. The pod name is the sandbox's SANDBOX_ID. The
  // first turns run concurrently, and each holds its lease for 2 s so they overlap: only then does
  // least-loaded spread them over the sandboxes. The second turns run one at a time.
  'K8S-SMOKE-WHERE-1': { steps: ['sleep 2; echo "where=$HOSTNAME"'], done: 'done-k8s-where-1' },
  'K8S-SMOKE-WHERE-2': { steps: ['echo "where=$HOSTNAME"'], done: 'done-k8s-where-2' },
  // deploy/k8s/smoke.sh, per-session models: no tool step, and the reply names the model the
  // request carried, so the smoke can see a PATCHed model reach the gateway.
  'K8S-SMOKE-MODEL': { steps: [], done: (model) => `model=${model}` },
  // skills/moca-delegate-task/demo/run.sh: a read-only and a writable run on a workload whose
  // context is demo/example_repo. READ shows the run starts in the context, that the context is
  // read-only, and that its ./test.sh runs; FIX edits the writable copy until ./test.sh passes, then
  // diffs it against the sandbox's cached revision, which must still have the bug.
  'MOCA-DEMO-READ': {
    steps: [
      'echo "cwd=$(pwd)"; ls',
      "stat -c '%a %n' test.sh src/greet.py; if (echo '# edit' >> src/greet.py) 2>/dev/null; then echo write=allowed; else echo write=refused; fi",
      './test.sh; echo "test-exit=$?"',
    ],
    done: 'done-demo-read',
  },
  'MOCA-DEMO-FIX': {
    steps: [
      'echo "cwd=$(pwd)"; ./test.sh; echo "before-exit=$?"',
      `python3 -c "import pathlib; p = pathlib.Path('src/greet.py'); p.write_text(p.read_text().replace('f\\"Hello {name}\\"', 'f\\"Hello, {name}!\\"'))"; ./test.sh; echo "after-exit=$?"`,
      'for f in /workspace/.moca-context/cache/*/workspace/src/greet.py; do echo "cached=$f"; sha256sum "$f"; git diff --no-index -- "$f" src/greet.py; done; true',
    ],
    done: 'done-demo-fix',
  },
  // skills/moca-delegate-task/demo-two-users/run.sh: Alice's and Bob's runs, each on its own
  // workload's sandboxes. Every step prints where it ran ($HOSTNAME is the pod, which is the
  // sandbox's SANDBOX_ID) and the run's working directory. WRITE leaves a note in Alice's writable
  // tree; READBACK, two at once, so least-loaded selection spreads them over her two sandboxes, reads
  // it back. PEEK tries to write the context and searches every place a run can reach for the
  // other user's SECRET- line: run.sh checks that only the caller's own one turns up.
  'MOCA-DEMO2-WHO': {
    steps: ['echo "where=$HOSTNAME"; echo "cwd=$(pwd)"; cat notes.txt 2>&1; true'],
    done: 'done-demo2-who',
  },
  'MOCA-DEMO2-WRITE': {
    steps: [
      'echo "where=$HOSTNAME"; echo "cwd=$(pwd)"; echo "written-by=$HOSTNAME" > run-note.txt; echo "write-exit=$?"',
    ],
    done: 'done-demo2-write',
  },
  'MOCA-DEMO2-READBACK': {
    steps: [
      'sleep 2; echo "where=$HOSTNAME"; echo "cwd=$(pwd)"; echo "note=$(cat run-note.txt 2>&1)"',
    ],
    done: 'done-demo2-readback',
  },
  'MOCA-DEMO2-PEEK': {
    steps: [
      'echo "where=$HOSTNAME"; echo "cwd=$(pwd)"; cat notes.txt 2>&1; if (echo probe >> notes.txt) 2>/dev/null; then echo write=allowed; else echo write=refused; fi',
      'grep -rIs "SECRET-" /workspace /home /tmp /run /mnt /var/tmp 2>/dev/null | sed "s/^/found=/"; echo "searched=done"',
    ],
    done: 'done-demo2-peek',
  },
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
        delta: {
          type: 'text_delta',
          text: [typeof s.done === 'function' ? s.done(model) : s.done, ...results].join('\n'),
        },
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
