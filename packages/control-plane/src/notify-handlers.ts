import { randomBytes } from 'node:crypto';
import { kindSpec } from './credential-store.js';
import { CpError } from './errors.js';
import { auditBestEffort } from './handler-util.js';
import { requirePrincipal, type CpDeps, type Handler } from './handlers.js';
import { parseNotifyConfig } from './notify-config.js';
import type { NotifySecrets } from './notify-send.js';
import type { NotifyStore } from './notify-store.js';
import type { TurnStore } from './turn-store.js';

/**
 * `GET`/`PUT`/`DELETE /v1/notifications` (#394), spread into HANDLERS by handlers.ts. Only TYPES
 * and plain utility functions come from handlers.ts (never runtime-cycle participants) -- a
 * circular runtime import would be a module cycle, the same arrangement turn-handlers.ts and
 * sandbox-handlers.ts use.
 *
 * NOT session-scoped: the config belongs to the caller's SUBJECT, so there is no path id to own and
 * no filter for a handler to get wrong. Every handler reads `principal.sub` and nothing else, which
 * is also why there is no `?owner=`: reading another subject's sinks is not a privilege granted
 * anywhere, and not reading the parameter is what stops it becoming one by accident.
 */

/** The subject's webhook SIGNING key (kind `hmac-sha256`). */
export const NOTIFY_WEBHOOK_CRED = 'notify-webhook';
/** The subject's ntfy publish token (kind `bearer`), absent on an anonymous topic. */
export const NOTIFY_NTFY_CRED = 'notify-ntfy';

/** 32 bytes, hex. Shown once, at the PUT that minted it, and never readable again. */
const SECRET_BYTES = 32;

function service(deps: CpDeps): { notify: NotifyStore; turns: TurnStore } {
  // depsFromEnv builds both whenever Redis is configured. Either missing is a wiring bug.
  if (!deps.notify || !deps.turns) {
    throw new CpError('internal_error', 'notifications are not configured');
  }
  return { notify: deps.notify, turns: deps.turns };
}

/**
 * The secrets for one subject, read back in-process. This is the reason the keys live in the
 * credential store rather than sealed into Redis: `deps.credentials` is on CpDeps and the KEK ring
 * is not, so sealing here would mean plumbing the ring through the boot contract. `/v1` still
 * exposes no read-back path for a credential's secret -- only this module and the sweep read them.
 */
export async function readNotifySecrets(deps: CpDeps, subject: string): Promise<NotifySecrets> {
  const [hook, push] = await Promise.all([
    deps.credentials.get(subject, NOTIFY_WEBHOOK_CRED),
    deps.credentials.get(subject, NOTIFY_NTFY_CRED),
  ]);
  return {
    ...(hook?.secret.key ? { webhookKey: hook.secret.key } : {}),
    // The token AND the hosts it was authorized for, so `deliver` can hold the credential store's
    // destination binding at the SENDER too. Reading the secret by name alone is what let a token
    // follow a moved sink; the PUT now refuses to store that mismatch, and this is the same
    // invariant one layer down, where a torn write or a hand-edited hash cannot step around it.
    ...(push?.secret.token
      ? { ntfyToken: push.secret.token, ntfyHosts: push.descriptor.destination.hosts }
      : {}),
  };
}

export const NOTIFY_HANDLERS: Record<string, Handler> = {
  getNotifications: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const { notify } = service(deps);
    const cfg = await notify.get(p.sub);
    if (!cfg) throw new CpError('not_found', 'no notification config for this subject');
    const secrets = await readNotifySecrets(deps, p.sub);
    return {
      status: 200,
      body: {
        sinks: cfg.sinks,
        states: cfg.states,
        cursor: cfg.cursor,
        lastDeliveryAt: cfg.lastDeliveryAt,
        failures: cfg.failures,
        mutedUntil: cfg.mutedUntil,
        /**
         * The half-configured case is VISIBLE rather than silent: a PUT writes the secret before
         * the config, and on a Vault- or K8s-backed store that write can 503. Without this field a
         * subject's webhook would simply never fire and nothing would say why.
         */
        secretMissing:
          cfg.sinks.some((s) => s.kind === 'webhook') && secrets.webhookKey === undefined,
      },
    };
  },

  putNotifications: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const { notify, turns } = service(deps);
    const { config, ntfyToken } = parseNotifyConfig(ctx.body, deps.config.notify.allow);

    // An ntfy token is stored against the host it was authorized for (`destination.hosts`, the
    // binding the credential store exists to enforce), but the sender reads it by NAME only. So a
    // re-PUT that MOVES the sink and omits `token` would post the old server's token to the new one
    // -- a self-hosted ntfy's token to ntfy.sh. Refused here, where the caller can fix it by
    // resending: dropping the token instead would silently turn an authenticated topic into a
    // failing one, and `GET` has no field that would tell them which happened.
    //
    // Before every write, so a refusal leaves nothing half-applied -- in particular it must precede
    // the webhook put, which ROTATES the signing key the caller would not be given on a 400.
    const ntfySink = config.sinks.find((s) => s.kind === 'ntfy');
    if (ntfySink && ntfyToken === undefined) {
      const stored = await deps.credentials.get(p.sub, NOTIFY_NTFY_CRED);
      const host = new URL(ntfySink.url).hostname;
      if (stored && !stored.descriptor.destination.hosts.includes(host)) {
        // Both ways out are named: a subject who wants the sink on the new host ANONYMOUSLY cannot
        // get there by omitting `token` -- that is this very branch -- so "resend it" alone would be
        // the opposite of what they are asking for.
        throw new CpError(
          'invalid_request',
          `this subject's ntfy token was authorized for another host; resend 'token' for '${host}', ` +
            'or DELETE /v1/notifications first to move the sink without one',
        );
      }
    }

    let webhookSecret: string | undefined;
    if (config.sinks.some((s) => s.kind === 'webhook')) {
      webhookSecret = randomBytes(SECRET_BYTES).toString('hex');
      // Secrets BEFORE the config, so the sweep can never read a config whose key is not there yet.
      // A re-PUT therefore rotates the key: the old one stops verifying the moment this returns,
      // which is the behaviour a leaked secret needs and the reason there is no separate rotate route.
      await deps.credentials.put(p.sub, {
        descriptor: {
          name: NOTIFY_WEBHOOK_CRED,
          kind: 'hmac-sha256',
          consumer: 'control-plane',
          destination: {
            hosts: config.sinks
              .filter((s) => s.kind === 'webhook')
              .map((s) => new URL(s.url).hostname),
          },
          binding: kindSpec('hmac-sha256').defaultBinding,
          endpoint: null,
        },
        secret: { key: webhookSecret },
      });
    }
    if (ntfyToken !== undefined) {
      await deps.credentials.put(p.sub, {
        descriptor: {
          name: NOTIFY_NTFY_CRED,
          kind: 'bearer',
          consumer: 'control-plane',
          destination: {
            hosts: config.sinks
              .filter((s) => s.kind === 'ntfy')
              .map((s) => new URL(s.url).hostname),
          },
          binding: kindSpec('bearer').defaultBinding,
          endpoint: null,
        },
        secret: { token: ntfyToken },
      });
    }
    // An ntfy token the caller did NOT resend is left alone, deliberately: a PUT that only edits
    // `states` must not silently turn an authenticated topic into a failing one.

    // From NOW, not from the start of the retained log: a subject who configures notifications on
    // Friday evening is not paged for every turn they already watched finish.
    const cursor = await turns.lastEventId(p.sub);
    await notify.put(p.sub, config, cursor, deps.now());
    // A kind absent from the NEW config gets its credential deleted, same principle as
    // deleteNotifications: "a key with no config is a secret nobody can see, use or rotate". After
    // the config write, not before -- a crash here leaves a readable config whose secret for a
    // dropped kind lingers one extra beat, rather than a config write that could still fail after
    // the secret it depended on was already gone.
    if (!config.sinks.some((s) => s.kind === 'webhook')) {
      await deps.credentials.delete(p.sub, NOTIFY_WEBHOOK_CRED);
    }
    if (!config.sinks.some((s) => s.kind === 'ntfy')) {
      await deps.credentials.delete(p.sub, NOTIFY_NTFY_CRED);
    }
    // 'notify_configured' is not in OwnershipIndex.audit's (string) union because there is none --
    // `decision` is a plain string there, so no widening is needed.
    await auditBestEffort(deps, 'putNotifications', `sinks=${config.sinks.length}`, {
      subject: p.sub,
      decision: 'notify_configured',
    });
    return {
      status: 200,
      body: {
        ...config,
        cursor,
        // Returned ONCE. There is no route that reads it back, by construction.
        ...(webhookSecret ? { webhookSecret } : {}),
      },
    };
  },

  deleteNotifications: async (ctx, deps) => {
    const p = requirePrincipal(ctx);
    const { notify } = service(deps);
    await notify.remove(p.sub);
    // Both secrets go too: a key with no config is a secret nobody can see, use or rotate. Each
    // store's delete is a no-op on an absent name, which is what makes a second DELETE a 204.
    await deps.credentials.delete(p.sub, NOTIFY_WEBHOOK_CRED);
    await deps.credentials.delete(p.sub, NOTIFY_NTFY_CRED);
    await auditBestEffort(deps, 'deleteNotifications', 'notifications', {
      subject: p.sub,
      decision: 'notify_removed',
    });
    return { status: 204, body: undefined };
  },
};
