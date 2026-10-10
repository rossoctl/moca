import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { homedir } from 'node:os';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, classify } from './api/errors.js';
import type { Usage } from './api/frames.js';
import type { CreateSessionRequest } from './api/types.js';
import { AppOverlay, type Overlay } from './app-overlay.js';
import type { InteractiveOptions } from './cli.js';
import { BUILTIN_COMMANDS, type CommandHost, type OverlayName } from './commands/builtin.js';
import { chordFor } from './commands/keys.js';
import { CommandRegistry } from './commands/registry.js';
import type { CachedAuth, TuiConfig } from './config.js';
import { apiTokenValid, loginExpiryMinutes } from './core/auth.js';
import { collectBannerInfo, type BannerInfo } from './core/banner.js';
import { describeError } from './core/messages.js';
import {
  describePromotion,
  promoteDirectory,
  PromoteError,
  type PromoteResult,
} from './core/promote.js';
import { sanitizeRemote } from './core/sanitize.js';
import {
  DOUBLE_ESC_MS,
  HarnessUntrustedError,
  type ActiveSession,
  type SessionEvent,
} from './core/session-manager.js';
import { deriveTitle } from './core/transcripts.js';
import { writeExport, type OsDeps } from './os.js';
import {
  EMPTY_BLOCKS,
  addNotice,
  fromTranscript,
  lastTurnState,
  splitStatic,
  type BlockState,
} from './render/blocks.js';
import { transcriptToMarkdown } from './render/export.js';
import {
  connectionOf,
  persistEndpoints,
  restoreConnection,
  saveRuntimeConfig,
  sessionManager,
  setAuth,
  type Runtime,
} from './runtime.js';
import { ThemeProvider } from './theme/context.js';
import { THEME_NAMES, resolveTheme } from './theme/tokens.js';
import { Chat } from './views/Chat.js';
import { formatUsage } from './views/format.js';
import { describeTurn, type StatusField } from './views/status.js';
import { useSession, type SessionView } from './views/useSession.js';

export const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H';
const BELL_IDLE_MS = 10_000;
const TOAST_MS = 5000;

type Toast = { text: string; tone: 'info' | 'warning' | 'error' };

/** One attached session and the snapshot its view starts from; replaced as a unit. */
interface Attached {
  session?: ActiveSession;
  initial: BlockState;
  initialUsage?: Usage;
}
const DETACHED: Attached = { initial: EMPTY_BLOCKS };

export interface AppProps {
  rt: Runtime;
  opts: InteractiveOptions;
  env: NodeJS.ProcessEnv;
  os: OsDeps;
  write: (s: string) => void;
}

export function initialOverlay(
  rt: Runtime,
  opts: InteractiveOptions,
): { name: OverlayName } | undefined {
  if (opts.setup || !rt.endpoints.controlPlaneUrl) return { name: 'onboarding' };
  if (!apiTokenValid(rt.auth, rt.now())) return { name: 'login' };
  return undefined;
}

// Stops a session that is being switched away from, so its turn cannot keep running unseen.
function retire(s: ActiveSession | undefined): void {
  s?.clearQueue();
  // A detachable turn is left running (the user chose keep, or switched sessions); anything else is
  // cancelled, as before.
  if (s?.runningDetachable) s.detach();
  else s?.cancel();
}

export function App({ rt, opts, env, os, write }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns: width } = useWindowSize();
  const [themeName, setThemeName] = useState(rt.config.theme);
  const [details, setDetails] = useState(rt.config.details);
  const [thinking, setThinking] = useState(rt.config.thinking);
  const [overlay, setOverlay] = useState<Overlay | undefined>(() => initialOverlay(rt, opts));
  const [attached, setAttached] = useState<Attached>(DETACHED);
  const [title, setTitle] = useState<string>();
  const [history, setHistory] = useState<string[]>([]);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>();
  const [staticKey, setStaticKey] = useState(0);
  const [toast, setToast] = useState<Toast>();
  const [leader, setLeader] = useState(false);
  const [now, setNow] = useState(rt.now());
  const [overlayKey, setOverlayKey] = useState(0);
  const [pendingBundle, setPendingBundle] = useState<PromoteResult>();
  const [banner, setBanner] = useState<BannerInfo>();

  // Overlays capture their callbacks at mount (Login resolves minutes later), so anything a
  // callback reads that can change meanwhile is read through a ref.
  const sessionRef = useRef<ActiveSession | undefined>(undefined);
  sessionRef.current = attached.session;
  const viewRef = useRef<SessionView | undefined>(undefined);
  const leaderRef = useRef(false);
  const lastEsc = useRef(-Infinity);
  const lastInput = useRef(rt.now());
  /** A message typed before any session existed; sent once New Session attaches one. */
  const pendingRef = useRef<string | undefined>(undefined);
  const sendOnAttach = useRef<string | undefined>(undefined);
  /** A resumed session's catch-up, started once useSession listens to it (frames are not replayed). */
  const catchUpOnAttach = useRef<
    { session: ActiveSession; lastEventId?: string; expectOpen: boolean } | undefined
  >(undefined);
  /** The prompt of the turn in flight, per session event, for replay after a re-login. */
  const runningPrompt = useRef<string | undefined>(undefined);
  const replayAfterLogin = useRef<{ session: ActiveSession; prompt: string } | undefined>(
    undefined,
  );
  const busy = useRef(false); // create/resume in flight; SelectList can fire Enter twice
  const overlayInputless = useRef(false);
  /** The endpoints and clients last known to work; onboarding restores them when abandoned. */
  const committed = useRef(connectionOf(rt));
  const pendingBundleRef = useRef<PromoteResult | undefined>(undefined);
  pendingBundleRef.current = pendingBundle;

  const theme = useMemo(
    () => resolveTheme(themeName, env, rt.config.reducedMotion || opts.noAnimation),
    [themeName],
  );
  const registry = useMemo(
    () => new CommandRegistry<CommandHost>(BUILTIN_COMMANDS, rt.config.keybinds),
    [],
  );

  const notify = useCallback(
    (text: string, tone: Toast['tone'] = 'info') => setToast({ text, tone }),
    [],
  );
  // Every change mounts a fresh overlay (the key), which starts out taking input until it says
  // otherwise through onInputless.
  const show = (o: Overlay | undefined) => {
    overlayInputless.current = false;
    setOverlayKey((k) => k + 1);
    setOverlay(o);
  };
  const open = (o: Overlay) => show(o);
  const close = () => {
    pendingRef.current = undefined;
    show(undefined);
  };
  /** What runs once the user answers the leave-turn overlay with keep or cancel. */
  const pendingLeave = useRef<(() => void) | undefined>(undefined);
  const leave = (then: () => void) => {
    if (sessionRef.current?.runningDetachable) {
      pendingLeave.current = then;
      show({ name: 'leave-turn' });
    } else then();
  };
  const leaveChoice = {
    keep: () => {
      const then = pendingLeave.current;
      pendingLeave.current = undefined;
      close();
      then?.();
    },
    cancel: () => {
      // The turn ended while the question was up: nothing is left to cancel, so just leave.
      if (!sessionRef.current?.runningDetachable) return leaveChoice.keep();
      const then = pendingLeave.current;
      void (async () => {
        const cancelled = await sessionRef.current?.cancelRemote();
        // Stay, or a keep, answered while the cancel was in flight: the question is settled, and
        // whatever is on screen now is not this overlay's to close.
        if (pendingLeave.current !== then) return;
        pendingLeave.current = undefined;
        close();
        // A failure stays; it is reported once, by the session's own notice in the chat.
        if (cancelled) then?.();
      })();
    },
    stay: () => {
      pendingLeave.current = undefined;
      close();
    },
  };
  const quitApp = () => {
    retire(sessionRef.current);
    exit();
  };
  const persist = (patch: Partial<TuiConfig>) => {
    rt.config = { ...rt.config, ...patch };
    saveRuntimeConfig(rt);
  };
  // <Static> output cannot be re-rendered in place, so a display change (or anything that took
  // over the terminal, like $EDITOR) clears the screen and re-prints history.
  const redraw = () => {
    write(CLEAR_SCREEN);
    setStaticKey((k) => k + 1);
  };

  const attach = (next: Attached, t: string | undefined, prompts: string[]) => {
    if (sessionRef.current !== next.session) retire(sessionRef.current);
    sessionRef.current = next.session;
    runningPrompt.current = undefined;
    setAttached(next);
    setTitle(t);
    setHistory(prompts);
  };
  const detach = () => attach(DETACHED, undefined, []);

  /**
   * Spec §8.1 outside a turn: an expired or missing login met by an overlay (or a resume) opens
   * Login, and a successful login reopens what the user was doing. Returns true when it did.
   */
  const loginIfExpired = (err: unknown, back: Overlay | undefined): boolean => {
    if (!(err instanceof ApiError) || classify(err).kind !== 'login') return false;
    show({ name: 'login', back: back?.name === 'login' ? back.back : back });
    return true;
  };

  const onTurnEnd = (e: Extract<SessionEvent, { kind: 'turn-end' }>) => {
    // A cancelled turn was the user's own doing; only a finished one is worth a bell.
    if (e.outcome !== 'cancelled' && rt.config.bell && rt.now() - lastInput.current > BELL_IDLE_MS)
      write('\u0007');
    if (e.outcome !== 'error' || !e.error) return;
    if (e.error instanceof HarnessUntrustedError) {
      notify('the harness does not trust this control plane — run /doctor', 'error');
      return;
    }
    if (!(e.error instanceof ApiError)) return;
    const action = classify(e.error);
    if (action.kind === 'login') {
      // Spec §8.1: log in again, then replay the prompt the expired login interrupted.
      const s = sessionRef.current;
      if (s && runningPrompt.current && !replayAfterLogin.current)
        replayAfterLogin.current = { session: s, prompt: runningPrompt.current };
      // Queued turns fail the same way; re-showing would restart the device flow under the user.
      if (overlay?.name !== 'login') show({ name: 'login' });
    } else if (action.kind === 'session-gone') {
      detach();
      notify(describeError(e.error), 'warning');
    }
  };

  const view = useSession(attached.session, {
    initial: attached.initial,
    initialUsage: attached.initialUsage,
    now: rt.now,
    onTurnEnd,
  });
  viewRef.current = view;

  useEffect(() => {
    const warnings = [rt.configWarning, ...registry.conflicts].filter(Boolean);
    if (warnings.length > 0) notify(warnings.join(' · '), 'warning');
    else if (!overlay)
      notify('type a message to start a session · ctrl+x l to resume one · ? for help');
  }, []);

  // The banner's remote halves (control plane and harness versions) are collected in the
  // background so the TUI paints immediately; the banner prints when they land or give up.
  useEffect(() => {
    // Aborted on unmount: mocactl exits via process.exitCode, so a fetch the dead UI left running
    // would hold the process alive.
    const controller = new AbortController();
    void collectBannerInfo(
      { cp: rt.cp, harness: rt.harness },
      { cwd: process.cwd(), home: homedir(), signal: controller.signal },
    ).then((info) => {
      if (controller.signal.aborted) return;
      setBanner(info);
      // <Static> prints append-only: with history already printed, PREPENDING the banner would
      // duplicate the last block instead of showing it — so clear and reprint with it on top.
      const view = viewRef.current;
      if (view && splitStatic(view.state.blocks).settled.length > 0) redraw();
    });
    return () => controller.abort();
  }, []);

  // A new snapshot means <Static> must re-print from scratch. This runs after useSession's own
  // reset effect, so the re-keyed <Static> sees the new blocks: re-keying in the same render as
  // the swap would print the OLD blocks and then treat the (shorter) new list as already printed.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) redraw();
    mounted.current = true;
  }, [attached]);

  // Every exit path (ctrl+c included, which unmounts without host.quit) stops the attached
  // session, so an in-flight turn's stream cannot keep the process alive with no UI.
  useEffect(() => () => retire(sessionRef.current), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Fast while a turn runs (its timer is on screen), slow otherwise (the login-expiry warning).
  useEffect(() => {
    setNow(rt.now());
    const i = setInterval(() => setNow(rt.now()), view.turn.phase === 'idle' ? 30_000 : 250);
    return () => clearInterval(i);
  }, [view.turn.phase]);

  useEffect(() => {
    const s = attached.session;
    if (!s) return;
    const off = s.on((e) => {
      if (e.kind === 'turn-start') runningPrompt.current = e.prompt;
    });
    const catchUp = catchUpOnAttach.current;
    catchUpOnAttach.current = undefined;
    if (catchUp?.session === s)
      s.attachExisting({ lastEventId: catchUp.lastEventId, expectOpen: catchUp.expectOpen });
    const prompt = sendOnAttach.current;
    sendOnAttach.current = undefined;
    if (prompt) view.submit(prompt);
    return off;
  }, [attached.session]);

  const create = async (req: CreateSessionRequest, values: Record<string, string>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const bundle = pendingBundleRef.current;
      const s = await sessionManager(rt).create(
        bundle ? { ...req, configRef: bundle.digest } : req,
      );
      // One-shot: a bundle silently attaching to every later session would be the surprise.
      if (bundle) setPendingBundle(undefined);
      persist({ lastUsed: { ...rt.config.lastUsed, ...values } });
      const prompt = pendingRef.current;
      sendOnAttach.current = prompt;
      attach(
        { session: s, initial: EMPTY_BLOCKS },
        prompt ? deriveTitle(prompt) : undefined,
        prompt ? [prompt] : [],
      );
      close();
    } finally {
      busy.current = false;
    }
  };

  const resume = (id: string) =>
    leave(() => {
      void (async () => {
        if (busy.current) return;
        busy.current = true;
        try {
          const s = await sessionManager(rt).resume(id);
          const t = rt.transcripts?.load(id);
          const initial = t
            ? fromTranscript(t)
            : addNotice(
                EMPTY_BLOCKS,
                "history for this session isn't available on this device — the model still has its full context",
                'info',
              );
          // Catch up on the session's last turn (turn-reattach spec §6.5): finished while away,
          // still running, or nothing -- the attach step says which. It starts from the effect
          // below, once useSession is subscribed: frames emitted before then would be lost.
          catchUpOnAttach.current = {
            session: s,
            lastEventId: t?.lastEventId,
            expectOpen: t ? lastTurnState(t) === 'open-detachable' : false,
          };
          attach({ session: s, initial, initialUsage: t?.usage }, t?.title ?? id.slice(0, 8), [
            ...(t?.prompts ?? []),
          ]);
          close();
        } catch (err) {
          if (!loginIfExpired(err, { name: 'sessions' })) notify(describeError(err), 'error');
        } finally {
          busy.current = false;
        }
      })();
    });

  const onLoggedIn = (a: CachedAuth, back?: Overlay) => {
    setAuth(rt, a);
    if (back) show(back);
    else close();
    notify(`logged in as ${a.displayName ?? a.subject}`);
    const replay = replayAfterLogin.current;
    replayAfterLogin.current = undefined;
    // The prompt is already on screen and in the transcript; only the turn runs again.
    if (replay && replay.session === sessionRef.current) viewRef.current?.resend(replay.prompt);
  };

  const submitText = (text: string) => {
    lastInput.current = rt.now();
    if (text.startsWith('/')) {
      const name = text.split(/\s/)[0];
      const hit = registry.bySlash(text);
      if (!hit) return notify(`unknown command ${name} — ctrl+p lists commands`, 'warning');
      if (hit.command.when && !hit.command.when(host))
        return notify(`${name} needs an open session`, 'warning');
      return void hit.command.run(host, hit.arg);
    }
    setHistory((h) => [...h, text]);
    if (!attached.session) {
      pendingRef.current = text;
      show({ name: 'new-session' });
      return;
    }
    if (!title) setTitle(deriveTitle(text));
    view.submit(text);
  };

  const host: CommandHost = {
    hasSession: () => !!sessionRef.current,
    openOverlay: (name) => open({ name }),
    newSession: () => open({ name: 'new-session' }),
    renameSession: (t) => {
      const s = sessionRef.current;
      if (!s) return;
      rt.transcripts?.rename(s.sessionId, t);
      setTitle(t);
      notify(`renamed to "${t}"`);
    },
    prefillInput: (text) => setPrefill((p) => ({ text, nonce: (p?.nonce ?? 0) + 1 })),
    toggleDetails: () => {
      setDetails(!details);
      persist({ details: !details });
      redraw();
    },
    toggleThinking: () => {
      setThinking(!thinking);
      persist({ thinking: !thinking });
      redraw();
    },
    copyLastReply: async () => {
      const text = view.lastReply();
      if (!text) return notify('nothing to copy yet');
      try {
        await os.copy(text);
        notify('copied the last reply');
      } catch (err) {
        notify(`copy failed: ${describeError(err)}`, 'error');
      }
    },
    exportTranscript: async () => {
      const s = sessionRef.current;
      if (!s) return;
      try {
        const file = writeExport(
          rt.paths,
          s.sessionId,
          transcriptToMarkdown(title ?? s.sessionId, view.state.blocks),
        );
        try {
          await suspendTerminal(() => os.openInEditor(file));
        } finally {
          redraw();
        }
        notify(`exported to ${file}`);
      } catch (err) {
        notify(`export failed: ${describeError(err)}`, 'error');
      }
    },
    composeInEditor: async () => {
      let text = '';
      try {
        // Ink hands the terminal (raw mode, stdin) to the editor and takes it back afterwards.
        await suspendTerminal(() => {
          text = os.editText('');
        });
      } catch (err) {
        redraw();
        return notify(describeError(err), 'error');
      }
      redraw();
      if (text.trim()) submitText(text.trim());
    },
    cycleTheme: () => {
      const next = THEME_NAMES[(THEME_NAMES.indexOf(themeName) + 1) % THEME_NAMES.length];
      setThemeName(next);
      persist({ theme: next });
      redraw();
      notify(`theme: ${next}`);
    },
    notify: (m) => notify(m),
    promoteBundle: async (arg) => {
      if (arg === '--clear') {
        setPendingBundle(undefined);
        return notify(
          pendingBundleRef.current ? 'config bundle dropped' : 'no config bundle pending',
        );
      }
      if (!rt.cp) return notify('connect to a control plane first', 'warning');
      try {
        const r = await promoteDirectory(arg, rt.cp);
        setPendingBundle(r);
        notify(describePromotion(r, arg), r.warnings ? 'warning' : undefined);
        open({ name: 'new-session' });
      } catch (err) {
        if (loginIfExpired(err, undefined))
          return notify('your login expired — log in, then run /promote again', 'warning');
        notify(err instanceof PromoteError ? err.message : describeError(err), 'error');
      }
    },
    quit: () => leave(quitApp),
  };

  // Abandoned onboarding puts back whatever was last known to work, then exits if that is nothing.
  const cancelOnboarding = () => {
    if (rt.endpoints !== committed.current.endpoints) restoreConnection(rt, committed.current);
    if (!rt.endpoints.controlPlaneUrl) return exit();
    show(initialOverlay(rt, { ...opts, setup: false }));
  };

  const setLeaderPending = (on: boolean) => {
    leaderRef.current = on;
    setLeader(on);
  };

  useInput((input, key) => {
    lastInput.current = rt.now(); // any keystroke is activity, for the turn-complete bell
    if (key.ctrl && input === 'c') {
      // The leave-turn overlay answers Ctrl+C itself (keep); everywhere else it quits, asking first
      // only when a detachable turn would be left behind.
      if (overlay?.name !== 'leave-turn') leave(quitApp);
      return;
    }
    if (overlay) {
      if (key.escape && overlayInputless.current) {
        if (overlay.name === 'onboarding') cancelOnboarding();
        else close();
      }
      return;
    }
    const inLeader = leaderRef.current;
    if (key.escape && !inLeader) {
      const s = sessionRef.current;
      if (!s || (!s.busy && s.queued === 0)) return;
      const t = rt.now();
      if (t - lastEsc.current < DOUBLE_ESC_MS) {
        view.clearQueue();
        notify('queue cleared');
      }
      view.cancel();
      lastEsc.current = t;
      return;
    }
    const r = chordFor(input, key, inLeader);
    if (r.kind === 'leader') return setLeaderPending(true);
    if (inLeader) setLeaderPending(false);
    if (r.kind !== 'chord') return;
    const command = registry.byKeybind(r.chord);
    if (command && (!command.when || command.when(host))) void command.run(host, '');
    else if (inLeader) notify(`${r.chord} is not bound — ctrl+p lists commands`, 'warning');
  });

  const overlayNode = overlay ? (
    <AppOverlay
      key={overlayKey}
      overlay={overlay}
      rt={rt}
      os={os}
      registry={registry}
      host={host}
      currentSessionId={attached.session?.sessionId}
      open={open}
      close={close}
      onOnboarded={() => {
        // Spec §6.8 step 4: create the first session and land in Chat.
        show({ name: 'new-session' });
        notify('all set — type a message to start');
      }}
      onConnected={() => {
        persistEndpoints(rt);
        committed.current = connectionOf(rt);
      }}
      onOnboardingCancel={cancelOnboarding}
      onLoggedIn={onLoggedIn}
      onCpError={(err) => loginIfExpired(err, overlay)}
      onCreate={(req, values) =>
        new Promise<void>((resolve, reject) => {
          // Created at once, the overlay that asked is still mounted and shows a failure itself.
          // After the leave-turn question it is gone, so the App reports the failure instead.
          let asked = false;
          leave(() => {
            const created = create(req, values);
            if (!asked) return void created.then(resolve, reject);
            created.then(resolve, (err: unknown) => {
              if (!loginIfExpired(err, { name: 'new-session' }))
                notify(describeError(err), 'error');
              resolve();
            });
          });
          asked = true;
          // Choosing stay leaves this unsettled; the overlay that awaited it is gone.
        })
      }
      onResume={resume}
      onDeleted={(id) => {
        if (id === sessionRef.current?.sessionId) detach();
      }}
      onInputless={(v) => {
        overlayInputless.current = v;
      }}
      bundle={
        pendingBundle
          ? {
              digest: pendingBundle.digest,
              skills: pendingBundle.skills.length,
              dropped: pendingBundle.dropped.length,
            }
          : undefined
      }
      leave={leaveChoice}
    />
  ) : null;

  const t = theme.tokens;
  const expiresIn = loginExpiryMinutes(rt.auth, now);
  const session = attached.session;
  // The subject's name, the title (from a prompt or transcript) and a toast (often an error's
  // server text, or the login's display name) are all shown terminal-safe.
  const fields = (
    [
      ...(rt.auth
        ? [{ key: 'subject' as const, text: rt.auth.displayName ?? rt.auth.subject }]
        : []),
      { key: 'title', text: title ?? (session ? session.sessionId.slice(0, 8) : 'no session') },
      { key: 'turn', text: describeTurn(view.turn, now) + (leader ? ' · ctrl+x …' : '') },
      ...(view.usage.total > 0 ? [{ key: 'usage' as const, text: formatUsage(view.usage) }] : []),
      ...(expiresIn ? [{ key: 'warning' as const, text: `login expires in ${expiresIn}m` }] : []),
    ] satisfies StatusField[]
  ).map((f): StatusField => ({ ...f, text: sanitizeRemote(f.text) }));
  const toastNode = toast ? (
    <Text color={toast.tone === 'error' ? t.error : toast.tone === 'warning' ? t.warning : t.info}>
      {sanitizeRemote(toast.text)}
    </Text>
  ) : null;

  return (
    <ThemeProvider value={theme}>
      <Chat
        blocks={view.state}
        details={details}
        thinking={thinking}
        width={width}
        staticKey={staticKey}
        statusFields={fields}
        inputActive={!overlay && !leader}
        history={history}
        onSubmit={submitText}
        onHelp={() => open({ name: 'help' })}
        prefill={prefill}
        banner={banner}
        overlay={
          overlayNode || toastNode ? (
            <Box flexDirection="column">
              {toastNode}
              {overlayNode}
            </Box>
          ) : undefined
        }
      />
    </ThemeProvider>
  );
}
