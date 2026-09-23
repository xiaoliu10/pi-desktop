/**
 * Channel-agnostic bot transport interface. Each IM (DingTalk, Feishu,
 * Telegram, …) implements one adapter: it connects using channel-specific
 * credentials, feeds incoming messages into the core, and sends the core's
 * replies back. The core never sees channel details.
 */

export interface IncomingMessage {
  /** Stable chat/conversation id — used for /bind bindings. */
  chatId: string;
  text: string;
  /** Sender display name if the channel provides one. */
  sender?: string;
}

export interface TransportContext {
  /** Feed one incoming message into the bot core; resolves to the reply text. */
  onMessage: (msg: IncomingMessage) => Promise<string>;
  onStatus?: (line: string) => void;
}

export interface ImTransport {
  readonly id: string;
  start(ctx: TransportContext): Promise<void>;
  stop(): Promise<void>;
}
