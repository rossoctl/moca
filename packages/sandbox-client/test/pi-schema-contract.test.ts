import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { PI_SCHEMAS } from '../src/schemas.js';
import { sandboxTools, TOOL_NAMES } from '../src/tools.js';

// SBX0 §6.4 / §10.4: the client's tools keep Pi's names and input schemas. Pi is imported HERE only
// (a dev dependency); the package itself must stay Pi-free (ADR-0042).
const PI = [
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
].map((f) => f('/workspace'));

describe("the tools keep Pi's names and schemas", () => {
  const ours = new Map(sandboxTools({ info: async () => '' }).map((t) => [t.name, t]));

  it.each(PI.map((d) => [d.name, d] as const))('%s', (name, def) => {
    const mine = ours.get(name);
    expect(mine, `no tool named ${name}`).toBeDefined();
    expect(mine!.inputSchema).toEqual(JSON.parse(JSON.stringify(def.parameters)));
  });

  it("covers exactly Pi's seven tools, plus sandbox_info and reset", () => {
    expect(Object.keys(PI_SCHEMAS)).toEqual(PI.map((d) => d.name));
    expect(TOOL_NAMES.filter((n) => n !== 'sandbox_info' && n !== 'reset')).toEqual(
      PI.map((d) => d.name),
    );
  });
});
