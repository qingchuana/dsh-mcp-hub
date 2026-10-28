/**
 * Test double for `@deepseek-ai/dsh-typert-protocol`.
 *
 * The real base class registers the instance as a Cordis service and the
 * gateway reads the Remote method list from a prototype marker. This double
 * keeps the one observable side effect a suite needs — the instance is recorded
 * on the context — so the service `apply()` created can be reached without the
 * plugin having to export its class.
 */
export class TypertRemoteService {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.serviceName = name;
    if (ctx !== undefined && ctx !== null) {
      ctx.services ??= {};
      ctx.services[name] = this;
    }
  }
}

export class Remote {
  constructor(options) {
    Object.assign(this, options);
  }
}
