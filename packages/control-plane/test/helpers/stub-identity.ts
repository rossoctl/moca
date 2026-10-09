import type { DeviceStart, IdentityProvider, Principal } from '../../src/identity.js';

/** A scripted IdentityProvider: hands back one principal, or throws whatever it was given. */
export class StubIdentity implements IdentityProvider {
  constructor(private readonly principal: Principal | Error) {}
  async startDeviceAuth(): Promise<DeviceStart> {
    return {
      deviceCode: 'dc-1',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    };
  }
  async completeDeviceAuth(): Promise<Principal> {
    if (this.principal instanceof Error) throw this.principal;
    return this.principal;
  }
  rolesFor(subject: string): string[] {
    return this.principal instanceof Error || this.principal.subject !== subject
      ? []
      : this.principal.roles;
  }
}
