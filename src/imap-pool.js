// A connection has exactly one borrower. Mailbox selection is never shared concurrently.
export class ImapPool {
  constructor(mail, { idleMs = 60000, maxIdle = 8 } = {}) {
    this.mail = mail;
    this.idleMs = idleMs;
    this.maxIdle = maxIdle;
    this.idle = [];
    this.closed = false;
  }

  key(account) {
    return JSON.stringify([
      account.user_id,
      account.id,
      account.email,
      account.imap_host,
      account.imap_port,
      account.credential,
    ]);
  }

  async acquire(account, job) {
    if (this.closed || job.cancelled) throw Error("Cancelled");
    this.mail.leases?.assert(account);
    const key = this.key(account);
    const index = this.idle.findIndex(
      (entry) => entry.key === key && !entry.closed,
    );
    if (index >= 0) {
      const [entry] = this.idle.splice(index, 1);
      clearTimeout(entry.timer);
      job.client = entry.client;
      return entry;
    }
    const client = await this.mail.imap(account, job);
    const entry = {
      key,
      account: account.id,
      user: account.user_id,
      client,
      closed: false,
    };
    client.on?.("close", () => {
      entry.closed = true;
      this.remove(entry);
    });
    client.on?.("error", () => {
      entry.closed = true;
      this.remove(entry);
      client.close();
    });
    try {
      await client.connect();
      if (job.cancelled || this.closed) throw Error("Cancelled");
      return entry;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  release(entry, reusable) {
    if (!entry) return;
    if (
      !reusable ||
      entry.closed ||
      this.closed ||
      this.idleMs <= 0 ||
      this.maxIdle <= 0
    ) {
      this.remove(entry);
      entry.client.close();
      return;
    }
    // Bound both global idle sockets and each user's share of the pool.
    const own = this.idle.filter((item) => item.user === entry.user);
    if (own.length >= 2) this.discard(own[0]);
    while (this.idle.length >= this.maxIdle) this.discard(this.idle[0]);
    entry.timer = setTimeout(() => this.discard(entry), this.idleMs);
    entry.timer.unref();
    this.idle.push(entry);
  }

  remove(entry) {
    clearTimeout(entry.timer);
    this.idle = this.idle.filter((item) => item !== entry);
  }

  discard(entry) {
    this.remove(entry);
    entry.closed = true;
    entry.client.close();
  }

  invalidate(account) {
    for (const entry of [...this.idle])
      if (entry.account === account) this.discard(entry);
  }

  close() {
    this.closed = true;
    for (const entry of [...this.idle]) this.discard(entry);
  }
}
