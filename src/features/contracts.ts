import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { NativeSessionHost, Session } from "../core/sessions.js";
import type { SavedNativeSession } from "./history-source.js";

/** Optional behavior. The core owns runtimes, terminal attachment, and lifecycle. */
export interface SessionFeature {
  readonly id: string;
  start?(host: NativeSessionHost): void | (() => void | Promise<void>);
  refresh?(host: NativeSessionHost): Promise<void>;
  settled?(host: NativeSessionHost, record: Session, ctx: ExtensionContext): void;
  /** A finalized transcript message in this session, after native persistence. */
  messageEnd?(host: NativeSessionHost, record: Session, ctx: ExtensionContext, message: MessageEndEvent["message"]): void;
  changed?(host: NativeSessionHost): void;
  input?(host: NativeSessionHost, record: Session, ctx: ExtensionContext, data: string): { consume: true } | undefined;
  history?(host: NativeSessionHost, path: string): Promise<SavedNativeSession | undefined>;
}
