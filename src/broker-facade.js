// Control-side stand-in for the mail services in isolated mode (MAIL_BROKER_TOKEN set). Mailbox secrets,
// IMAP and SMTP exist only in the mail worker, so every method here either reads the state the worker last
// reported through the broker or raises a signal the worker applies on its next inventory (about 1 s).
// It deliberately has no `entries`, `password` or reader/sender internals: the control process holds none.
//
// One instance serves the four roles server.js wires up: CredentialLeases, MailService, MailReader and
// MailSender.
export class BrokerMailFacade {
  constructor(broker = () => null) {
    this.broker = broker;
  }

  // --- CredentialLeases ---
  // Authorization state as last reported by the worker; locked while the worker is unavailable.
  status(account) {
    return this.broker()?.status(account) || { mode: "client", state: "locked", expiresAt: null };
  }
  // Credential changed, mailbox deleted or sync re-keyed: the worker revokes the in-memory lease.
  revoke(id) {
    this.broker()?.invalidate(id);
  }
  // Nothing to do here: the worker revokes leases of devices that drop out of the inventory device list
  // (revoked, owner deactivated or no unexpired session).
  revokeDevice() {}

  // --- MailService ---
  state(id) {
    return this.broker()?.state(id) || { connectionStatus: "worker_unavailable" };
  }
  // The worker starts listeners itself from monitor_enabled/sync_enabled on its next inventory.
  async start() {}
  // Monitoring switched off: the worker closes the listener but keeps the user's authorization.
  stop(id) {
    this.broker()?.stopMonitor(id);
  }
  // Mailbox gone: drop the lease, listener and reported state.
  remove(id) {
    this.broker()?.invalidate(id);
  }

  // --- MailReader / MailSender ---
  // Cancels the worker's reads and sends for this mailbox; this also revokes the lease.
  invalidate(id) {
    this.broker()?.invalidate(id);
  }

  close() {}
}
