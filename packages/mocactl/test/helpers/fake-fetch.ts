export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any; // parsed JSON; tests assert on it freely
  signal?: AbortSignal;
}

type Reply = Response | Error | ((c: Call) => Response);

export function scriptedFetch(...replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
