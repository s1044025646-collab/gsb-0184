// SQLite 持久化：状态点、过程链（含版本快照）、参数版本。
// 使用 Node.js 内置 node:sqlite，无外部依赖。
// 编辑上游状态并重新执行时插入新的 chain_versions 行（version 递增），旧版本保留可查。
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const PARAM_VERSION_ID = "ashrae-2009-hw-v1";
export const PARAM_VERSION_DESC = {
  id: PARAM_VERSION_ID,
  saturationPressure: "Hyland-Wexler (ASHRAE Fundamentals 2009), 0-60C over water",
  enthalpy: "h = 1.006*T + W*(2501 + 1.86*T) kJ/kg(da); 0C dry air and 0C liquid water reference",
  humidityRatio: "W = 0.621945*pw/(p-pw)",
  specificVolume: "v = 287.042*T_K*(1+1.607858*W)/p",
  liquidWater: "h_w = 4.186*T kJ/kg",
  range: { tC: [0, 60], pKPa: [80, 115] },
};

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS param_versions (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        param_version TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        param_version TEXT NOT NULL,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chain_id, version)
      );
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO param_versions (id, description, created_at) VALUES (?, ?, ?)",
      )
      .run(PARAM_VERSION_ID, JSON.stringify(PARAM_VERSION_DESC), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  saveState(input: unknown, output: unknown): number {
    const r = this.db
      .prepare(
        "INSERT INTO states (param_version, input, output, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(PARAM_VERSION_ID, JSON.stringify(input), JSON.stringify(output), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getState(id: number): { id: number; input: unknown; output: unknown; createdAt: string } | null {
    const row = this.db.prepare("SELECT * FROM states WHERE id = ?").get(id) as
      | { id: number; input: string; output: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      input: JSON.parse(row.input),
      output: JSON.parse(row.output),
      createdAt: row.created_at,
    };
  }

  saveChainExecution(name: string, steps: unknown[]): { chainId: number; version: number } {
    const existing = this.db.prepare("SELECT id FROM chains WHERE name = ?").get(name) as
      | { id: number }
      | undefined;
    let chainId: number;
    if (existing) {
      chainId = existing.id;
    } else {
      const r = this.db
        .prepare("INSERT INTO chains (name, created_at) VALUES (?, ?)")
        .run(name, new Date().toISOString());
      chainId = Number(r.lastInsertRowid);
    }
    const vrow = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM chain_versions WHERE chain_id = ?")
      .get(chainId) as { v: number };
    const version = vrow.v + 1;
    this.db
      .prepare(
        "INSERT INTO chain_versions (chain_id, version, param_version, steps, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chainId, version, PARAM_VERSION_ID, JSON.stringify(steps), new Date().toISOString());
    return { chainId, version };
  }

  getChain(chainId: number, version?: number): {
    chainId: number;
    name: string;
    version: number;
    paramVersion: string;
    steps: unknown[];
    createdAt: string;
  } | null {
    const chain = this.db.prepare("SELECT * FROM chains WHERE id = ?").get(chainId) as
      | { id: number; name: string }
      | undefined;
    if (!chain) return null;
    const row = (
      version == null
        ? this.db
            .prepare("SELECT * FROM chain_versions WHERE chain_id = ? ORDER BY version DESC LIMIT 1")
            .get(chainId)
        : this.db
            .prepare("SELECT * FROM chain_versions WHERE chain_id = ? AND version = ?")
            .get(chainId, version)
    ) as
      | { version: number; param_version: string; steps: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      chainId,
      name: chain.name,
      version: row.version,
      paramVersion: row.param_version,
      steps: JSON.parse(row.steps) as unknown[],
      createdAt: row.created_at,
    };
  }

  listChains(): { id: number; name: string; versions: number }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, COUNT(v.id) AS versions
         FROM chains c LEFT JOIN chain_versions v ON v.chain_id = c.id
         GROUP BY c.id ORDER BY c.id`,
      )
      .all() as { id: number; name: string; versions: number }[];
  }

  listParamVersions(): unknown[] {
    const rows = this.db.prepare("SELECT * FROM param_versions").all() as {
      id: string;
      description: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ ...JSON.parse(r.description), createdAt: r.created_at }));
  }
}
