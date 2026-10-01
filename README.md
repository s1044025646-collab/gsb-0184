# 湿空气状态与混风除湿过程计算服务（教学用）

纯本地后端：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无 Docker、无外部在线 API）。提供 HTTP API 与 CLI。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（19 个）
npm start          # 启动 HTTP 服务（默认端口 8321）
npm run demo       # 运行固定算例演示并写入数据库
npm run cli -- state --state '{\"T\":25,\"rh\":0.5}'
```

配置：环境变量 `PORT`、`PSYCHRO_DATA_DIR`，或项目根目录 `config.json`：

```json
{ "port": 8321, "dataDir": "data" }
```

数据库文件为 `<dataDir>/psychro.db`，服务重启后自动重新读取。

## 单位与约定（重要）

- 温标：摄氏度（°C）；压力：kPa；大气压力默认 101.325 kPa。
- **所有质量与能量均按每千克干空气（kg_da）计量**：含湿量 W [kg/kg_da]、焓 h [kJ/kg_da]、比容 v [m³/kg_da]、流量 m_da [kg_da/s]。全程不使用湿空气总质量。
- 焓参考态（ASHRAE 惯例）：干空气 0 °C 焓为 0，0 °C 饱和液态水焓为 0；
  `h = 1.006·T + W·(2501 + 1.86·T)`。
- 液态水（凝结水）焓约定：`h_w = 4.186·T` [kJ/kg]，T 为凝结水温度（取盘管表面温度）。
- 饱和蒸气压：Hyland–Wexler 关联式（ASHRAE Handbook—Fundamentals，水面上公式，源适用范围 0–200 °C）。
- 露点：对饱和蒸气压关联式二分求根（约 100 次迭代，收敛到 1e-10 °C 量级）。

## 适用范围（明确限制）

- 干球温度 0–60 °C，大气压力 80–115 kPa；超出即拒绝并返回错误。
- 不覆盖冰相、结霜与超临界工况；露点求根范围 −40–80 °C（过冷水面上公式外推，教学可接受）。
- 零湿度（W=0）合法，此时露点返回 `null`。

## 过程模型

- **状态求解**：干球温度 + 相对湿度 / 含湿量 / 露点 三者之一，输出 T、W、RH、pw、h、Tdp、v。
- **混风**：按干空气质量流量绝热混合，W、h 线性加权；要求各股等压。若混合点超饱和（h-W 图上线性混合穿过饱和线），**明确拒绝并报错**，绝不把 RH 静默裁剪为 100%。
- **显热加热/冷却**：定含湿量，给定出风干球温度，返回负荷 Q（加热为正）。
- **冷却盘管**：给定表面温度 Ts 与旁通因子 BF（0–1）：
  `T2 = Ts + (T1−Ts)·BF`；除湿时 `W2 = Ws(Ts) + (W1−Ws(Ts))·BF`。
  - Ts 高于进风露点时自动退化为无凝露显热冷却，凝结水量为 0。
  - 旁通混合点轻微越过饱和线时（物理上对应雾气凝结），按出口温度饱和含湿量凝结多余水分，凝结水以 `h_w=4.186·T2` 离开，水分与能量保持严格平衡。
  - 返回出风状态、凝结水量 [kg/s]、空气侧热负荷 Q = m·(h1−h2) [kW]，以及完整水分/能量核算残差。

## HTTP API

统一错误格式：`{ "error": { "code", "message", "node" } }`，`node` 可定位到具体输入字段（如 `steps[1].BF`、`streams[0].mda`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/state` | `{p?, state:{T, rh|W|Tdp}, save?, label?}` 单状态求解 |
| POST | `/api/mix` | `{p?, streams:[{state, mda}], save?}` 混风 |
| POST | `/api/coil` | `{p?, inlet, mda, Ts, BF, save?}` 冷却盘管 |
| POST | `/api/heat` | `{p?, inlet, mda, Tout}` 显热加热 |
| POST | `/api/chains` | `{name, p?, steps:[...]}` 执行并保存过程链 |
| GET | `/api/chains` / `/api/chains/:id` | 链列表 / 链详情（含每步输入输出与核算） |
| POST | `/api/chains/:id/snapshot` | `{overrides:{步骤id:{...}}, name?}` 编辑上游生成新快照链，旧链保留 |
| GET | `/api/states` / `/api/states/:id` | 已保存状态点 |
| POST | `/api/compare` | `{chainIds:[...]} 或 {stateIds:[...]}` 工况比较 |
| GET | `/api/export?format=json|csv` | 导出全部状态与链 |
| POST | `/api/import` | 导入 JSON（`{states:[...], chains:[...]}`） |

过程链步骤类型：`state`（定义状态点）、`mix`（`streams:[{from,mda}]`）、`coil`（`from, mda, Ts, BF`）、`heat`（`from, mda, Tout`）。步骤只能引用已定义的上游 id，循环/前向引用会被拒绝。

## CLI

```powershell
npm run cli -- state --state '{\"T\":25,\"rh\":0.5}'          # 单状态（PowerShell 内联 JSON 需转义引号）
npm run cli -- mix --streams "[{...},{...}]"
npm run cli -- coil --inlet '{\"T\":30,\"rh\":0.7}' --mda 1.2 --Ts 8 --BF 0.1
npm run cli -- heat --inlet '{\"T\":20,\"rh\":0.5}' --mda 1.5 --Tout 35
npm run cli -- chain --file examples/chain1.json             # 执行并保存链
npm run cli -- chains / chain-get --id 1
npm run cli -- snapshot --id 1 --overrides '{\"oa\":{\"state\":{\"T\":30,\"rh\":0.7}}}'
npm run cli -- compare --chainIds "[1,2]"                    # 工况比较
npm run cli -- export --format csv --out out.csv
npm run cli -- import --file backup.json
```

## 持久化

SQLite 四张表：`param_versions`（关联式/参考焓参数版本）、`states`（状态点）、`chains`、`steps`（每步 kind、输入、输出、水分/能量核算）。编辑上游状态通过 `snapshot` 生成新链，`source_chain_id` 记录来源，旧链与其报告可继续查询。

## 测试与可复核性

`npm test` 运行 19 个测试，关键断言**不**依赖本程序同一函数的重复输出：

- 饱和蒸气压对照 ASHRAE 公布值（20 °C→2338.8 Pa，25 °C→3169.9 Pa，0.01 °C→611.657 Pa）；
- 标准点 25 °C / RH 50%：W≈9.88 g/kg，h≈50.29 kJ/kg，Tdp≈13.9 °C；
- 混风/盘管的水分与焓守恒用独立加权式核算；显热负荷用 `m·(1.006+1.86W)·ΔT` 独立核对；
- 零湿度边界、露点 ≤ 干球温度全范围扫描、BF=0/1 两端极限、无凝露冷却、超饱和混风拒绝、循环链拒绝、负流量拒绝、超范围拒绝。

## 已知限制

- 教学用途模型：理想气体、等压混合、稳态、集总盘管（单 Ts + BF），不做盘管逐排计算。
- 混风超饱和工况直接拒绝（未实现混风凝结平衡）；盘管出口的轻微超饱和按上述凝结平衡处理。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
