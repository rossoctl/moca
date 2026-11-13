import { describe, it, expect } from 'vitest';
import { handler } from '../src/server.js';
import * as pkg from '../src/index.js';

describe('handler export surface', () => {
  it('is importable from server.js as a 2-arg request listener', () => {
    expect(typeof handler).toBe('function');
    // (req, res) — anything else means the signature drifted from http.RequestListener.
    expect(handler.length).toBe(2);
  });

  it('is NOT part of the package public API', () => {
    // Spec §9: the supervisor forks src/worker.js directly. Re-exporting handler from
    // index.ts would advertise it as supported surface and invite an in-process embedding
    // that defeats the whole point of separate worker processes.
    expect('handler' in pkg).toBe(false);
    expect(Object.keys(pkg)).toEqual(['startServer']);
  });
});
