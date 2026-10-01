/**
 * SQLite 持久化层（node:sqlite，Node 内置，无原生依赖）。
 * 保存：参数版本、状态点、过程链（每步输入/输出/水分与能量核算）。
 * 编辑上游状态 = 基于旧链创建新快照链，旧链数据不可变、可继续查询。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const PARAM_VERSION = "v1.0-hw2017"; // Hyland-Wexler 关联式 + ASHRAE 参考焓

export class Store {
  db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS param_versions (
        id INTEGER PRIMARY KEY, name TEXT UNIQUE, description TEXT, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS states (
        id INTEGER PRIMARY KEY, version TEXT, label TEXT,
        inputs TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chains (
        id INTEGER PRIMARY KEY, version TEXT, name TEXT,
        source_chain_id INTEGER, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY, chain_id INTEGER, seq INTEGER, name TEXT, kind TEXT,
        inputs TEXT NOT NULL, output TEXT NOT NULL, balances TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steps_chain ON steps(chain_id, seq);
    `);
    this.db.prepare(
      "INSERT OR IGNORE INTO param_versions(id,name,description,created_at) VALUES (1,?,?,?)"
    ).run(PARAM_VERSION,
      "Hyland-Wexler 饱和蒸气压(水面上,0-200°C源范围)；焓参考态：干空气0°C、液态水0°C；h_w=4.186*T kJ/kg；范围 T 0..60°C, p 80..115kPa",
      new Date().toISOString());
  }

  saveState(label: string, inputs: unknown, result: unknown): number {
    const r = this.db.prepare(
      "INSERT INTO states(version,label,inputs,result,created_at) VALUES (?,?,?,?,?)"
    ).run(PARAM_VERSION, label, JSON.stringify(inputs), JSON.stringify(result), new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getState(id: number) {
    const row = this.db.prepare("SELECT * FROM states WHERE id=?").get(id) as any;
    if (!row) return null;
    return { ...row, inputs: JSON.parse(row.inputs), result: JSON.parse(row.result) };
  }

  listStates() {
    return (this.db.prepare("SELECT id,version,label,created_at FROM states ORDER BY id").all() as any[]);
  }

  createChain(name: string, sourceChainId: number | null = null): number {
    const r = this.db.prepare(
      "INSERT INTO chains(version,name,source_chain_id,created_at) VALUES (?,?,?,?)"
    ).run(PARAM_VERSION, name, sourceChainId, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  addStep(chainId: number, seq: number, name: string, kind: string, inputs: unknown, output: unknown, balances: unknown): void {
    this.db.prepare(
      "INSERT INTO steps(chain_id,seq,name,kind,inputs,output,balances) VALUES (?,?,?,?,?,?,?)"
    ).run(chainId, seq, name, kind, JSON.stringify(inputs), JSON.stringify(output), JSON.stringify(balances));
  }

  getChain(id: number) {
    const chain = this.db.prepare("SELECT * FROM chains WHERE id=?").get(id) as any;
    if (!chain) return null;
    const steps = (this.db.prepare("SELECT * FROM steps WHERE chain_id=? ORDER BY seq").all(id) as any[])
      .map((s) => ({ ...s, inputs: JSON.parse(s.inputs), output: JSON.parse(s.output), balances: JSON.parse(s.balances) }));
    return { ...chain, steps };
  }

  listChains() {
    return this.db.prepare("SELECT id,version,name,source_chain_id,created_at FROM chains ORDER BY id").all();
  }

  close(): void { this.db.close(); }
}
