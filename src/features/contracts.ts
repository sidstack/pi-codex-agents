import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeSessionHost, Session } from "../core/sessions.js";
import type { SavedNativeSession } from "./history-source.js";

/** Optional behavior. The core owns runtimes, terminal attachment, and lifecycle. */
export interface SessionFeature {
  readonly id: string;
  tools?(host: NativeSessionHost, record: Session): Parameters<ExtensionAPI["registerTool"]>[0][];
  request?(host: NativeSessionHost, operation: string, input: Record<string, unknown>, caller: string): Promise<unknown> | undefined;
  start?(host: NativeSessionHost): void | (() => void | Promise<void>);
  pending?(host: NativeSessionHost): number;
  refresh?(host: NativeSessionHost): Promise<void>;
  settled?(host: NativeSessionHost, record: Session, ctx: ExtensionContext): void;
  changed?(host: NativeSessionHost): void;
  input?(host: NativeSessionHost, record: Session, ctx: ExtensionContext, data: string): { consume: true } | undefined;
  history?(host: NativeSessionHost, path: string): Promise<SavedNativeSession | undefined>;
}
