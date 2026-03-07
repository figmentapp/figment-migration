export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  MIGRATION_QUEUE: Queue;
  ANTHROPIC_API_KEY: string;
}

export interface Task {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "partial";
  input_type: "fgmt" | "source";
  node_count: number;
  nodes_completed: number;
  errors: string | null;
  input_key: string;
  output_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface FgmtFile {
  version: number;
  nodes: FgmtNode[];
  connections: FgmtConnection[];
  settings: Record<string, unknown>;
  types: FgmtType[];
}

export interface FgmtNode {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  values?: Record<string, unknown>;
}

export interface FgmtConnection {
  outNode: number;
  outPort: string;
  inNode: number;
  inPort: string;
}

export interface FgmtType {
  name: string;
  type: string;
  source: string;
  description: string;
}

export type NodeClassification = "generator" | "filter" | "feedback" | "raw";

export interface ConversionResult {
  typeName: string;
  success: boolean;
  convertedSource?: string;
  error?: string;
}

export interface QueueMessage {
  taskId: string;
}
