import type { WatchTarget } from "../core/types";

export interface BaseConnector {
  start(): Promise<void>;
  fetchUpdates(source: WatchTarget): Promise<Record<string, any>[]>;
  stop(): Promise<void>;
}
