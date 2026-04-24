import type { SourceEntry } from "../core/types";

export interface BaseConnector {
  /** Start the connector (e.g. launch browser) */
  start(): Promise<void>;
  
  /** Fetch new raw data items for a given source entry */
  fetchUpdates(source: SourceEntry): Promise<Record<string, any>[]>;
  
  /** Clean up and shut down */
  stop(): Promise<void>;
}
