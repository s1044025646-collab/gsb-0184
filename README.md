# 湿空气状态与混风除湿过程计算后端

暖通教学用湿空气计算服务。纯后端（HTTP API + CLI），TypeScript + Node.js + SQLite，
Windows 本地运行，不依赖 Docker / WSL / 外部在线 API / 任何第三方 npm 运行时依赖
（SQLite 使用 Node.js 内置 `node:sqlite`，要求 Node ≥ 22.5，建议 Node 24+）。

## 单位与基准约定（全系统统一）

- 温度：摄氏度 °C；压力：kPa；负荷：kW；流量：**干空气质量流量** kg(da)/s。
- 含湿量 W：kg 水蒸气 / kg 干空气；焓 h：kJ/kg 干空气；比容 v：m³/kg 干空气。
- **所有质量与能量均按每千克干空气计量，绝不混用湿空气总质量。**
- 焓参考态：0°C 干空气焓为 0，0°C 液态水焓为 0（ASHRAE 惯例，0°C 饱和蒸汽焓 = 2501 kJ/kg）。
- 液态水焓：h_w = 4.186·T kJ/kg。

## 关联式与适用范围

- 饱和水蒸气压：Hyland-Wexler 方程（ASHRAE Handbook—Fundamentals 2009），
  露点由该式二分反解（自实现数值求根，无外部库）。
- 湿度比：W = 0.621945·p_w/(p − p_w)。
- 焓：h = 1.006·T + W·(2501 + 1.86·T)。
- 比容：v = 287.042·T_K·(1 + 1.607858·W)/p。
- **适用范围：干球/露点 0–60 °C，大气压力 80–115 kPa。** 不覆盖冰相、结霜与超临界工况；
  超出范围的数据被明确拒绝（错误码 `OUT_OF_RANGE`）。

## 过程模型

- **混风**：按干空气质量流量加权混合 h 与 W，再反解温度。若混合点超饱和，
  **明确拒绝**（错误码 `MIX_SUPER_SATURATED`），绝不静默把相对湿度裁剪为 100%。
- **显热加热/冷却**：定含湿量过程，Q = m_da·Δh。
- **冷却盘管（旁通因子模型）**：给定表面温度 t_s 与旁通因子 BF，
  出风为接触部分（达到 t_s 饱和状态）与旁通部分的混合；
  t_s 高于进风露点时为无凝露干工况（W 不变、凝结水为 0）。
  出风若因模型特性微过饱和，则沿饱和线修正（多余水分计入凝结水）。
  冷负荷 Q = m_da·(h_in − h_out) − m_cond·h_w(t_s)，
  即凝结水以表面温度液态离开系统；每步输出水量与能量平衡残差供核算。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（24 个）
npm run demo       # 固定算例演示：状态点、混风、显热、结露冷却、盘管比较、过程链
npm start          # 启动 HTTP 服务（默认端口 8137，数据库 data/psychro.db）
```

## CLI

```
node dist/src/cli.js state --p 101.325 --t 25 --rh 0.5
node dist/src/cli.js state --p 101.325 --t 25 --w 0.0099
node dist/src/cli.js state --p 101.325 --t 25 --tdp 14
node dist/src/cli.js coil --p 101.325 --t 32 --rh 0.6 --m 1.5 --ts 8 --bf 0.1
node dist/src/cli.js sensible --p 101.325 --t 20 --rh 0.5 --m 1 --tout 35
node dist/src/cli.js mix --p 101.325 --streams "[{\"state\":{\"p\":101.325,\"t\":30,\"rh\":0.6},\"mDa\":1},{\"state\":{\"p\":101.325,\"t\":20,\"rh\":0.5},\"mDa\":2}]"
node dist/src/cli.js compare --p 101.325 --t 32 --rh 0.6 --m 1.5 --cases "[{\"tSurface\":8,\"bypassFactor\":0.1},{\"tSurface\":6,\"bypassFactor\":0.05}]"
node dist/src/cli.js chain run examples/chain-ahu.json   # 同名链重复执行产生新版本快照
node dist/src/cli.js chain get 1 --version 1             # 旧版本报告仍可查询
node dist/src/cli.js chain list
node dist/src/cli.js import --format csv --file examples/states.csv
node dist/src/cli.js export --chainId 1 --format csv
node dist/src/cli.js serve --port 8137 --db data/psychro.db
```

通用参数：`--db <路径>` 指定项目内数据目录下的 SQLite 文件（默认 `data/psychro.db`）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/state` | 单状态求解：`{p, t, rh|w|tdp}` |
| POST | `/api/mix` | 混风：`{p, streams:[{state, mDa}]}` |
| POST | `/api/coil` | 冷却盘管：`{state, mDa, tSurface, bypassFactor}` |
| POST | `/api/sensible` | 显热过程：`{state, mDa, tOut}` |
| POST | `/api/compare` | 多盘管工况比较：`{state, mDa, cases:[{tSurface, bypassFactor}]}` |
| POST | `/api/chains` | 执行并保存过程链：`{name, steps:[...]}`，同名链产生新版本 |
| GET | `/api/chains/:id[?version=N]` | 查询过程链快照（默认最新版） |
| GET | `/api/chains` | 链列表 |
| GET | `/api/states/:id` | 查询已保存状态点 |
| GET | `/api/param-versions` | 关联式参数版本 |
| POST | `/api/import` | 导入：`{format: "json"|"csv", content}` |
| GET | `/api/export?chainId=N&format=json|csv` | 导出 |

过程链步骤类型：`state`（`{id, type:"state", input:{p,t,rh|w|tdp}}`）、
`mix`（`{id, type:"mix", p, streams:[{from, mDa}]}`）、
`sensible`（`{id, type:"sensible", from, mDa, tOut}`）、
`coil`（`{id, type:"coil", from, mDa, tSurface, bypassFactor}`）。
步骤间以 `id` / `from` 引用构成有向无环图，循环引用被拒绝（`CYCLE_DETECTED`）。
示例见 `examples/chain-ahu.json`（新风+回风混风 → 冷却盘管 → 再热）。

## 错误格式

所有错误返回统一结构，可定位到具体节点：

```json
{ "error": { "code": "INVALID_INPUT", "message": "...", "node": "steps[2].state" } }
```

错误码：`MISSING_INPUT`（缺少输入）、`INVALID_INPUT`（负流量、BF 越界、露点高于干球等）、
`OUT_OF_RANGE`（超适用范围）、`SUPER_SATURATED` / `MIX_SUPER_SATURATED`（超饱和）、
`CYCLE_DETECTED`（循环过程链）、`NOT_FOUND`。

## 持久化与版本

- SQLite 存于项目内 `data/` 目录（可用 `--db` / `serve --db` 配置）。
- 表：`states`（状态点）、`chains` + `chain_versions`（过程链及每次执行的完整快照，
  含每步输入、输出状态、水分与能量核算）、`param_versions`（关联式参数版本）。
- 编辑上游状态后重新执行同名链，会写入新的 `chain_versions` 行（version 递增），
  旧版本报告永久保留、可按版本号查询；服务重启后数据仍在。

## 测试与可复核性

`npm test` 运行 24 个测试，数值正确性不依赖"同一函数两次输出一致"，而是：

- 饱和蒸气压对照 ASHRAE 参考表（0/20/25/40/60 °C，相对误差 < 0.2%）；
- 25 °C / 50%RH 海平面状态对照 ASHRAE 公布值（W≈0.00988，h≈50.3，v≈0.858，tdp≈13.9）；
- rh / w / tdp 三种输入形式转换一致性；
- 零湿度边界、露点不高于干球温度；
- 混风水分与焓的独立加权守恒断言；
- 旁通因子两端极限（BF=1 无处理、BF=0 全接触饱和）；
- 无凝露冷却（W 不变、凝结水为 0）与结露冷却的水量/能量平衡残差为零；
- 循环链、缺失输入、负流量、超范围数据的拒绝；
- 过程链版本快照与 API 端到端。

## 目录结构

```
src/psychro.ts       饱和压力关联式、状态求解、露点求根、单位约定
src/processes.ts     混风 / 显热 / 冷却盘管（旁通因子）过程模型
src/engine.ts        过程链拓扑排序（含循环检测）与逐步执行
src/store.ts         SQLite 持久化（node:sqlite）
src/api.ts           HTTP API（node:http）
src/cli.ts           命令行入口
src/demo.ts          固定算例演示
src/importExport.ts  JSON/CSV 导入导出
test/                node:test 测试
examples/            过程链 JSON 与 CSV 算例
data/                SQLite 数据目录（运行时生成）
```

## 已知限制

- 仅覆盖 0–60 °C 水面上方工况；不支持冰相/结霜/超临界。
- 混风超饱和工况目前直接拒绝，未实现混风凝结（雾）模型。
- 盘管为集总旁通因子模型，非分布参数模型。
- `node:sqlite` 在 Node 中仍标记为实验特性（会有一条 ExperimentalWarning），
  如需消除可升级 Node 版本或加 `--no-warnings`。
