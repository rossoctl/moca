import type { CreateSessionRequest } from './api/types.js';
import type { CommandHost, OverlayName } from './commands/builtin.js';
import type { CommandRegistry } from './commands/registry.js';
import type { CachedAuth } from './config.js';
import { apiTokenValid } from './core/auth.js';
import { runDiagnostics } from './core/diagnostics.js';
import type { OsDeps } from './os.js';
import {
  applyEndpoints,
  ensureRuntimeAuth,
  sessionManager,
  setAuth,
  type Runtime,
} from './runtime.js';
import { CredentialsOverlay } from './views/overlays/Credentials.js';
import { DoctorOverlay } from './views/overlays/Doctor.js';
import { HelpOverlay } from './views/overlays/Help.js';
import { LoginOverlay } from './views/overlays/Login.js';
import { NewSessionOverlay } from './views/overlays/NewSession.js';
import { OnboardingOverlay } from './views/overlays/Onboarding.js';
import { PaletteOverlay } from './views/overlays/Palette.js';
import { SessionsOverlay } from './views/overlays/Sessions.js';

/**
 * `then` reopens an overlay once this one reports a change (credentials → new session); `back`
 * is the overlay a Login interrupted, reopened once the login succeeds.
 */
export type Overlay = { name: OverlayName; hint?: string; then?: OverlayName; back?: Overlay };

interface Props {
  overlay: Overlay;
  rt: Runtime;
  os: OsDeps;
  registry: CommandRegistry<CommandHost>;
  host: CommandHost;
  currentSessionId?: string;
  open: (o: Overlay) => void;
  close: () => void;
  onConnected: () => void;
  onOnboarded: () => void;
  onOnboardingCancel: () => void;
  onLoggedIn: (auth: CachedAuth, back?: Overlay) => void;
  /** Offered each control-plane error an overlay hits; true when it opened Login instead. */
  onCpError: (err: unknown) => boolean;
  onCreate: (req: CreateSessionRequest, values: Record<string, string>) => Promise<void>;
  onResume: (id: string) => void;
  onDeleted: (id: string) => void;
  onInputless: (inputless: boolean) => void;
  bundle?: { digest: string; skills: number; dropped: number };
}

// Every overlay owns Esc on its interactive screens. Onboarding, Sessions, New Session and
// Credentials also have screens with no input at all (a spinner, an error); they report those via
// onInputless and the App cancels the overlay on Esc from there, so no screen strands the user.
export function AppOverlay({
  overlay,
  rt,
  os,
  registry,
  host,
  currentSessionId,
  open,
  close,
  onConnected,
  onOnboarded,
  onOnboardingCancel,
  onLoggedIn,
  onCpError,
  onCreate,
  onResume,
  onDeleted,
  onInputless,
  bundle,
}: Props) {
  const loginDeps = () => ({ cp: rt.cp!, sleep: rt.sleep, now: rt.now });
  switch (overlay.name) {
    case 'onboarding':
      return (
        <OnboardingOverlay
          initial={rt.endpoints}
          connect={(e) => {
            // In memory only (reloading the login cached for that control plane); the URLs are
            // persisted by onConnected, once the control plane and its harness have answered.
            applyEndpoints(rt, e);
            return { cp: rt.cp!, harness: rt.harness! };
          }}
          hasValidLogin={() => apiTokenValid(rt.auth, rt.now())}
          loginDeps={loginDeps}
          onLoggedIn={(a) => setAuth(rt, a)}
          copy={os.copy}
          openUrl={os.openUrl}
          onConnected={onConnected}
          onDone={onOnboarded}
          onCancel={onOnboardingCancel}
          onInputless={onInputless}
        />
      );
    case 'login':
      return (
        <LoginOverlay
          deps={loginDeps()}
          controlPlaneUrl={rt.endpoints.controlPlaneUrl!}
          copy={os.copy}
          openUrl={os.openUrl}
          onLoggedIn={(a) => onLoggedIn(a, overlay.back)}
          onCancel={close}
        />
      );
    case 'sessions':
      return (
        <SessionsOverlay
          cp={rt.cp!}
          transcripts={rt.transcripts}
          now={rt.now}
          currentSessionId={currentSessionId}
          remove={(id) => sessionManager(rt).remove(id)}
          onResume={onResume}
          onNew={() => open({ name: 'new-session' })}
          onDeleted={onDeleted}
          onCancel={close}
          onError={onCpError}
          onInputless={onInputless}
        />
      );
    case 'new-session':
      return (
        <NewSessionOverlay
          cp={rt.cp!}
          lastUsed={rt.config.lastUsed}
          presets={rt.config.presets}
          onCreate={onCreate}
          onBlocked={(hint) => open({ name: 'credentials', hint, then: 'new-session' })}
          onCancel={close}
          onError={onCpError}
          onInputless={onInputless}
          bundle={bundle}
        />
      );
    case 'credentials': {
      const then = overlay.then;
      return (
        <CredentialsOverlay
          cp={rt.cp!}
          hint={overlay.hint}
          startInAdd={!!overlay.hint}
          onChanged={then ? () => open({ name: then }) : undefined}
          onCancel={close}
          onError={onCpError}
          onInputless={onInputless}
        />
      );
    }
    case 'doctor':
      return (
        <DoctorOverlay
          run={async () => {
            // Renew first (spec 5.2), so a refreshable login past its 15-minute API token still counts.
            await ensureRuntimeAuth(rt);
            return runDiagnostics({
              cp: rt.cp!,
              harness: rt.harness!,
              controlPlaneUrl: rt.endpoints.controlPlaneUrl!,
              harnessOverridden: rt.endpoints.harnessUrl !== undefined,
              loggedIn: apiTokenValid(rt.auth, rt.now()),
            });
          }}
          onClose={close}
          onError={onCpError}
        />
      );
    case 'palette':
      return <PaletteOverlay registry={registry} host={host} onClose={close} />;
    case 'help':
      return <HelpOverlay registry={registry} host={host} onClose={close} />;
  }
}
