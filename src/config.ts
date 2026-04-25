import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

export interface OshikatsuConfig {
  scheduler: {
    ingestionIntervalMinutes: number;
    normalizationIntervalMinutes: number;
  };
  llm: {
    provider: "ollama" | string;
    host: string;
    model: string;
  };
  twitter: {
    maxTweetsPerSource: number;
    headless: boolean;
  };
  paths: {
    browserData: string;
    database: string;
  };
}

const DEFAULT_CONFIG: OshikatsuConfig = {
  scheduler: {
    ingestionIntervalMinutes: 15,
    normalizationIntervalMinutes: 5,
  },
  llm: {
    provider: "ollama",
    host: "http://127.0.0.1:11434",
    model: "llama3",
  },
  twitter: {
    maxTweetsPerSource: 50,
    headless: true,
  },
  paths: {
    browserData: "./browser_data",
    database: "./data/oshikatsu.db",
  },
};

let cachedConfig: OshikatsuConfig | null = null;

export function getConfig(): OshikatsuConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(process.cwd(), "config.yaml");
  let userConfig = {};

  try {
    if (fs.existsSync(configPath)) {
      const fileContents = fs.readFileSync(configPath, "utf8");
      userConfig = parse(fileContents) || {};
    }
  } catch (e) {
    console.warn("[Config] Failed to load config.yaml, using defaults.", e);
  }

  // Deep merge userConfig into DEFAULT_CONFIG
  cachedConfig = {
    scheduler: { ...DEFAULT_CONFIG.scheduler, ...(userConfig as any).scheduler },
    llm: { ...DEFAULT_CONFIG.llm, ...(userConfig as any).llm },
    twitter: { ...DEFAULT_CONFIG.twitter, ...(userConfig as any).twitter },
    paths: { ...DEFAULT_CONFIG.paths, ...(userConfig as any).paths },
  };

  // Resolve relative paths based on CWD
  cachedConfig.paths.browserData = path.resolve(process.cwd(), cachedConfig.paths.browserData);
  cachedConfig.paths.database = path.resolve(process.cwd(), cachedConfig.paths.database);

  return cachedConfig;
}
