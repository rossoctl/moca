import type { Command } from './registry.js';

export type OverlayName =
  | 'sessions'
  | 'credentials'
  | 'new-session'
  | 'palette'
  | 'help'
  | 'doctor'
  | 'login'
  | 'onboarding'
  | 'leave-turn';

/** What commands may ask of the app. Implemented by app.tsx. */
export interface CommandHost {
  hasSession(): boolean;
  openOverlay(name: OverlayName): void;
  newSession(): void;
  renameSession(title: string): void;
  prefillInput(text: string): void;
  toggleDetails(): void;
  toggleThinking(): void;
  copyLastReply(): void | Promise<void>;
  exportTranscript(): void | Promise<void>;
  composeInEditor(): void | Promise<void>;
  cycleTheme(): void;
  notify(message: string): void;
  promoteBundle(arg: string): void | Promise<void>;
  quit(): void;
}

const inSession = (h: CommandHost) => h.hasSession();

export const BUILTIN_COMMANDS: Command<CommandHost>[] = [
  {
    id: 'session.list',
    title: 'Sessions',
    slash: ['sessions', 'resume'],
    keybind: 'ctrl+x l',
    run: (h) => h.openOverlay('sessions'),
  },
  {
    id: 'session.new',
    title: 'New session',
    slash: ['new'],
    keybind: 'ctrl+x n',
    run: (h) => h.newSession(),
  },
  {
    id: 'session.promote',
    title: 'Promote a skills directory for the next session',
    slash: ['promote'],
    run: (h, arg) => (arg ? h.promoteBundle(arg) : h.prefillInput('/promote ')),
  },
  {
    id: 'session.rename',
    title: 'Rename session',
    slash: ['rename'],
    keybind: 'ctrl+x r',
    when: inSession,
    run: (h, arg) => (arg ? h.renameSession(arg) : h.prefillInput('/rename ')),
  },
  {
    id: 'credentials',
    title: 'Credentials',
    slash: ['credentials'],
    keybind: 'ctrl+x k',
    run: (h) => h.openOverlay('credentials'),
  },
  {
    id: 'view.details',
    title: 'Toggle tool details',
    slash: ['details'],
    keybind: 'ctrl+x d',
    run: (h) => h.toggleDetails(),
  },
  {
    id: 'view.thinking',
    title: 'Toggle thinking',
    slash: ['thinking'],
    keybind: 'ctrl+x t',
    run: (h) => h.toggleThinking(),
  },
  {
    id: 'reply.copy',
    title: 'Copy last reply',
    slash: ['copy'],
    keybind: 'ctrl+x y',
    when: inSession,
    run: (h) => h.copyLastReply(),
  },
  {
    id: 'transcript.export',
    title: 'Export transcript to Markdown',
    slash: ['export'],
    keybind: 'ctrl+x x',
    when: inSession,
    run: (h) => h.exportTranscript(),
  },
  {
    id: 'input.editor',
    title: 'Compose in $EDITOR',
    slash: ['editor'],
    keybind: 'ctrl+x e',
    run: (h) => h.composeInEditor(),
  },
  {
    id: 'view.theme',
    title: 'Switch theme',
    slash: ['theme'],
    run: (h) => h.cycleTheme(),
  },
  {
    id: 'doctor',
    title: 'Diagnose setup',
    slash: ['doctor'],
    run: (h) => h.openOverlay('doctor'),
  },
  {
    id: 'help',
    title: 'Help',
    slash: ['help'],
    run: (h) => h.openOverlay('help'),
  },
  {
    id: 'palette',
    title: 'Command palette',
    keybind: 'ctrl+p',
    run: (h) => h.openOverlay('palette'),
  },
  {
    id: 'quit',
    title: 'Quit',
    slash: ['quit', 'exit', 'q'],
    keybind: 'ctrl+x q',
    run: (h) => h.quit(),
  },
];
