import { createHash, randomBytes } from "node:crypto";

/**
 * What a token lets its holder do. `dueAt` names one specific pending
 * restart: a later proposal has a different deadline, so an old token
 * can never cancel it.
 */
export interface TokenAction {
  kind: "cancel-restart";
  dueAt: number;
}

const TOKEN = /^[0-9a-f]{64}$/;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Single-use capabilities carried inside a notification.
 *
 * They exist because the Cancel button has to work without a session:
 * sessions last 24 hours and a service worker cannot log in. Held in
 * memory only, keyed by hash; a backend restart drops the pending restart
 * they could cancel anyway.
 */
export class ActionTokens {
  private readonly tokens = new Map<string, { action: TokenAction; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(action: TokenAction, expiresAt: number): string {
    this.sweep();
    const token = randomBytes(32).toString("hex");
    this.tokens.set(hash(token), { action, expiresAt });
    return token;
  }

  redeem(token: string): TokenAction | null {
    if (!TOKEN.test(token)) return null;
    const key = hash(token);
    const entry = this.tokens.get(key);
    this.tokens.delete(key);
    if (entry === undefined || this.now() >= entry.expiresAt) return null;
    return entry.action;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.tokens) {
      if (now >= entry.expiresAt) this.tokens.delete(key);
    }
  }
}
