import { CpError } from './errors.js';
import { asRecord, isAdmin, requireEnrolledPrincipal, seconds } from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { MEMBER_SUBJECT_FORMS, MEMBER_SUBJECT_RE } from './identity.js';
import { ADMIN, MAX_GRANT_SECONDS, type MembersStore } from './members.js';
import type { TokenClaims } from './token.js';

/**
 * Enrollment and roles through the API (enrollment and roles spec §4): any admin reads the list,
 * only an admin named in SH_ADMIN_SUBJECTS changes it. The deployment's settings stay the bootstrap
 * and are never edited here: a subject on SH_ALLOWED_SUBJECTS cannot be unenrolled, and one on
 * SH_ADMIN_SUBJECTS cannot lose the role (`409 bootstrap_subject`), so the deployment can always
 * recover. A grant may carry an expiry (`until`, epoch seconds).
 */

function admin(ctx: RequestCtx, deps: CpDeps): { p: TokenClaims; members: MembersStore } {
  const p = requireEnrolledPrincipal(ctx, deps.config);
  if (!isAdmin(p)) throw new CpError('forbidden', 'managing subjects requires the admin role');
  if (!deps.members)
    throw new CpError(
      'invalid_request',
      'this deployment does not store members (SH_PROVENANCE_DIR is unset): enrollment and roles are its settings',
    );
  return { p, members: deps.members };
}

/**
 * Who may CHANGE enrollment or roles: only an admin named in the settings
 * (SH_ADMIN_SUBJECTS). An admin by an API grant holds the role on every other admin route, but
 * cannot change who has access, so the API never widens access beyond what the settings' admins do.
 */
function settingsAdmin(ctx: RequestCtx, deps: CpDeps): { p: TokenClaims; members: MembersStore } {
  const a = admin(ctx, deps);
  if (!a.members.bootstrap.admins.includes(a.p.sub))
    throw new CpError(
      'forbidden',
      'changing enrollment or roles requires an admin named in the settings (SH_ADMIN_SUBJECTS)',
    );
  return a;
}

function subjectParam(ctx: RequestCtx): string {
  const s = ctx.params.subject ?? '';
  if (!MEMBER_SUBJECT_RE.test(s))
    throw new CpError('invalid_request', `subject must be ${MEMBER_SUBJECT_FORMS}`);
  return s;
}

const blank = (subject: string, by: string, nowS: number) => ({
  subject,
  enrolled: false,
  roles: [],
  since: nowS,
  by,
});

export const MEMBER_HANDLERS: Record<string, Handler> = {
  listSubjects: async (ctx, deps) => {
    const { members } = admin(ctx, deps);
    return { status: 200, body: { subjects: await members.list(seconds(deps)) } };
  },

  enrollSubject: async (ctx, deps) => {
    const { p, members } = settingsAdmin(ctx, deps);
    const subject = subjectParam(ctx);
    if (asRecord(ctx.body).enrolled !== true)
      throw new CpError('invalid_request', 'the body is {"enrolled": true}');
    const nowS = seconds(deps);
    // A subject the settings enroll is already enrolled: answer it unchanged (record null) and write
    // nothing, as unenroll refuses it. A store enrollment under it would be hidden behind
    // `source: env` and keep the subject enrolled after the settings drop it.
    if (members.bootstrap.allowed.includes(subject) || members.bootstrap.admins.includes(subject))
      return { status: 200, body: { ...(await members.view(subject, nowS)), record: null } };
    const record = await members.change((doc) => {
      const m = (doc.members[subject] ??= blank(subject, p.sub, nowS));
      if (m.enrolled) return null;
      m.enrolled = true;
      m.since = nowS;
      m.by = p.sub;
      return { kind: 'member', subject: p.sub, body: { subject, enrolled: true, before: false } };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  unenrollSubject: async (ctx, deps) => {
    const { p, members } = settingsAdmin(ctx, deps);
    const subject = subjectParam(ctx);
    if (members.bootstrap.allowed.includes(subject) || members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is enrolled by the deployment's settings (SH_ALLOWED_SUBJECTS or SH_ADMIN_SUBJECTS); remove it there`,
      );
    const nowS = seconds(deps);
    const record = await members.change((doc) => {
      const m = doc.members[subject];
      // An admin is enrolled whatever its enrollment says, so an unenroll that left a live admin
      // grant in place would answer 200 and change nothing the subject can do: refuse it instead.
      // Checked here, on the doc the change edits under the store's serial lock, so a grant that
      // lands just before cannot slip past it.
      const g = m?.roles.find((r) => r.role === ADMIN);
      if (g && (g.until === undefined || g.until > nowS))
        throw new CpError(
          'admin_granted',
          `${subject} holds the admin role, which keeps it enrolled: revoke the role first`,
        );
      if (!m?.enrolled) return null;
      m.enrolled = false;
      m.since = nowS;
      m.by = p.sub;
      return { kind: 'member', subject: p.sub, body: { subject, enrolled: false, before: true } };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  grantAdmin: async (ctx, deps) => {
    const { p, members } = settingsAdmin(ctx, deps);
    const subject = subjectParam(ctx);
    const raw = asRecord(ctx.body).until;
    const nowS = seconds(deps);
    if (
      raw !== undefined &&
      raw !== null &&
      !(
        Number.isSafeInteger(raw) &&
        (raw as number) > nowS &&
        (raw as number) <= nowS + MAX_GRANT_SECONDS
      )
    )
      throw new CpError(
        'invalid_request',
        'until must be a whole number of epoch seconds (not milliseconds) in the future, at most 366 days ahead (or absent: no expiry)',
      );
    const until = typeof raw === 'number' ? raw : undefined;
    if (members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is an admin by the deployment's settings (SH_ADMIN_SUBJECTS)`,
      );
    const record = await members.change((doc) => {
      const m = (doc.members[subject] ??= blank(subject, p.sub, nowS));
      const g = m.roles.find((r) => r.role === ADMIN);
      const live = g && (g.until === undefined || g.until > nowS);
      if (live && g.until === until) return null;
      m.roles = m.roles.filter((r) => r.role !== ADMIN);
      m.roles.push({
        role: ADMIN,
        ...(until !== undefined ? { until } : {}),
        by: p.sub,
        since: nowS,
      });
      m.since = nowS;
      m.by = p.sub;
      return {
        kind: 'role',
        subject: p.sub,
        body: {
          subject,
          role: ADMIN,
          state: 'granted',
          until: until ?? null,
          before: live ? 'granted' : 'none',
        },
      };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },

  revokeAdmin: async (ctx, deps) => {
    const { p, members } = settingsAdmin(ctx, deps);
    const subject = subjectParam(ctx);
    if (members.bootstrap.admins.includes(subject))
      throw new CpError(
        'bootstrap_subject',
        `${subject} is an admin by the deployment's settings (SH_ADMIN_SUBJECTS); remove it there`,
      );
    // Defence in depth: only a settings admin reaches here (settingsAdmin), and a settings admin's own
    // role is refused above as bootstrap_subject, so this is unreachable today. Kept so a later change
    // to who may revoke can never let an admin take its own role.
    if (subject === p.sub)
      throw new CpError('self_revoke', 'an admin cannot revoke its own admin role');
    const nowS = seconds(deps);
    const record = await members.change((doc) => {
      const m = doc.members[subject];
      const g = m?.roles.find((r) => r.role === ADMIN);
      if (!m || !g) return null;
      const live = g.until === undefined || g.until > nowS;
      m.roles = m.roles.filter((r) => r.role !== ADMIN);
      m.since = nowS;
      m.by = p.sub;
      return {
        kind: 'role',
        subject: p.sub,
        body: { subject, role: ADMIN, state: 'revoked', before: live ? 'granted' : 'expired' },
      };
    });
    return {
      status: 200,
      body: { ...(await members.view(subject, seconds(deps))), record },
    };
  },
};
