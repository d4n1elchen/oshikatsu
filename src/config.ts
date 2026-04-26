import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";

export interface OshikatsuConfig {
  scheduler: {
    ingestionIntervalMinutes: number;
    extractionIntervalMinutes: number;
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
  resolution: {
    titleSimilarityThreshold: number;
    autoMergeScoreThreshold: number;
    needsReviewScoreThreshold: number;
    candidateWindowHours: number;
  };
}

const DEFAULT_CONFIG: OshikatsuConfig = {
  scheduler: {
    ingestionIntervalMinutes: 15,
    extractionIntervalMinutes: 5,
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
  resolution: {
    titleSimilarityThreshold: 0.6,
    autoMergeScoreThreshold: 0.7,
    needsReviewScoreThreshold: 0.25,
    candidateWindowHours: 48,
  },
};

let cachedConfig: OshikatsuConfig | null = null;

type RawConfig = Partial<Omit<OshikatsuConfig, "scheduler">> & {
  scheduler?: Partial<OshikatsuConfig["scheduler"]> & {
    preprocessingIntervalMinutes?: number;
    normalizationIntervalMinutes?: number;
  };
};

export function getConfig(): OshikatsuConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(process.cwd(), "config.yaml");
  let userConfig: RawConfig = {};

  try {
    if (fs.existsSync(configPath)) {
      const fileContents = fs.readFileSync(configPath, "utf8");
      userConfig = parse(fileContents) || {};
    }
  } catch (e) {
    console.warn("[Config] Failed to load config.yaml, using defaults.", e);
  }

  const { preprocessingIntervalMinutes, normalizationIntervalMinutes, ...schedulerOverrides } = userConfig.scheduler ?? {};
  const schedulerConfig = {
    ...DEFAULT_CONFIG.scheduler,
    ...schedulerOverrides,
  };
  if (schedulerOverrides.extractionIntervalMinutes === undefined) {
    schedulerConfig.extractionIntervalMinutes = preprocessingIntervalMinutes ?? normalizationIntervalMinutes ?? schedulerConfig.extractionIntervalMinutes;
  }

  // Deep merge userConfig into DEFAULT_CONFIG
  cachedConfig = {
    scheduler: schedulerConfig,
    llm: { ...DEFAULT_CONFIG.llm, ...userConfig.llm },
    twitter: { ...DEFAULT_CONFIG.twitter, ...userConfig.twitter },
    paths: { ...DEFAULT_CONFIG.paths, ...userConfig.paths },
    resolution: { ...DEFAULT_CONFIG.resolution, ...(userConfig as any).resolution },
  };

  // Resolve relative paths based on CWD
  cachedConfig.paths.browserData = path.resolve(process.cwd(), cachedConfig.paths.browserData);
  cachedConfig.paths.database = path.resolve(process.cwd(), cachedConfig.paths.database);

  return cachedConfig;
}
