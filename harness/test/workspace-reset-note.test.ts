import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type Context,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  WORKSPACE_RESET_MESSAGE,
  WORKSPACE_RESET_NOTE,
  workspaceResetNoteExtension,
} from '../src/workspace-marker.js';

/**
 * The reset note against REAL Pi (PR #895 review): the note must not touch the user's prompt,
 * because Pi expands `/skill:` and prompt templates, and runs extension commands, only for text
 * that starts with `/`. A faux provider stands in for the model and records what it was sent.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function text(m: { content: unknown }): string {
  const c = m.content as string | Array<{ type: string; text?: string }>;
  return typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('');
}

async function piSession(withNote: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'reset-note-'));
  const skills = join(dir, 'skills', 'review');
  mkdirSync(skills, { recursive: true });
  writeFileSync(
    join(skills, 'SKILL.md'),
    '---\nname: review\ndescription: Review a change.\n---\nSKILL BODY: review carefully.\n',
  );
  const faux: FauxProviderRegistration = registerFauxProvider();
  cleanups.push(() => {
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
  });
  const model = faux.getModel();
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, 'faux-key');
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: 'faux-key',
    api: faux.api,
    models: faux.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      baseUrl: m.baseUrl,
    })),
  });
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    extensionFactories: withNote ? [workspaceResetNoteExtension()] : [],
    additionalSkillPaths: [join(dir, 'skills')],
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    authStorage,
    modelRegistry,
    model,
    resourceLoader,
    sessionManager,
    settingsManager,
    noTools: 'all',
  });
  const sent: Context[] = [];
  faux.setResponses([
    (context) => {
      sent.push(context);
      return fauxAssistantMessage('ok');
    },
  ]);
  return { session, sessionManager, sent };
}

describe('the workspace reset note, through real Pi', () => {
  it('a /skill: prompt on a reset turn still expands, and the note goes beside it', async () => {
    const { session, sessionManager, sent } = await piSession(true);
    await session.prompt('/skill:review the diff');
    const messages = sent[0]!.messages;
    const user = messages.filter((m) => m.role === 'user').map((m) => text(m));
    // The skill expanded: its body is in the user's message, and the note is not.
    expect(user[0]).toContain('SKILL BODY: review carefully.');
    expect(user[0]).toContain('the diff');
    expect(user[0]).not.toContain(WORKSPACE_RESET_NOTE);
    // The note reached the model as its own message.
    expect(user.slice(1)).toEqual([WORKSPACE_RESET_NOTE]);
    // And the log keeps it apart from the user's words.
    const custom = sessionManager.getEntries().filter((e) => e.type === 'custom_message') as Array<{
      customType: string;
      display: boolean;
    }>;
    expect(custom.map((e) => [e.customType, e.display])).toEqual([
      [WORKSPACE_RESET_MESSAGE, false],
    ]);
  });

  it('a plain prompt is sent as typed, with the note as a separate message', async () => {
    const { session, sent } = await piSession(true);
    await session.prompt('do the work');
    const user = sent[0]!.messages.filter((m) => m.role === 'user').map((m) => text(m));
    expect(user).toEqual(['do the work', WORKSPACE_RESET_NOTE]);
  });

  it('without a reset there is no note', async () => {
    const { session, sent } = await piSession(false);
    await session.prompt('/skill:review the diff');
    const user = sent[0]!.messages.filter((m) => m.role === 'user').map((m) => text(m));
    expect(user).toHaveLength(1);
    expect(user[0]).toContain('SKILL BODY');
  });
});
