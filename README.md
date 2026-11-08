# 数据问答 Agent（Text-to-SQL）

用中文问业务数据，Agent 自己决定看哪张表、写什么 SQL、错了怎么改 —— 每一步都摊开给你看。

> 项目 #3。前两个项目分别证明「能做 RAG 并验证它」和「能做产品化」，
> 这个项目要证明第三件事：**能让 LLM 可靠地执行有副作用的操作**。
>
> 状态：W1 + W2 完成（6 个工具 · 三级死循环防护 · 写操作两阶段确认 · 三条评测可复跑），W3 进行中。

---

## 它解决什么

给 LLM 一个数据库账号让它随便查，是最容易做的技术演示，也是最容易出事的产品。

这个项目的重点不是"能生成 SQL"，而是**出错时会发生什么**：

| 风险 | 这里的做法 |
|---|---|
| 模型删库 | 数据库账号**没有写权限** + 事务强制只读。不靠 prompt 劝阻 |
| 模型写错 SQL | 报错原样喂回去让它自己改（带 position 与 hint）；同一个错误撞 3 次就**换诊断方向**（去 describeTable），不是继续猜 |
| 模型绕圈烧 token | 三级检测：同一条 SQL 第二次不执行 / 同错第 3 次给诊断指令 / 连续 3 次相同结果直接叫停 |
| 一条 SQL 拖垮库 | `statement_timeout` 10 秒 + 返回行数硬上限 |
| 模型编数字 | 工具返回真实行数；prompt 要求"查不到就说明"，且答案必须来自执行结果 |
| 大面积扫表烧 token | 表结构只给一句话说明，按需 `describeTable`；表多时先 `searchSchema` 检索 |
| 写操作被误触发 | 两阶段确认：模型只能**提案**，确认端点只收 id、SQL 从库里读，客户端改不了要保存什么 |

---

## 架构

```
用户问题
   ↓
ToolLoopAgent（AI SDK 7，最多 10 步）
   ├─ listTables      → 21 张表的用途 + 当前行数（现查，不写死）
   ├─ searchSchema    → 关键词 + IDF 检索相关表，返回命中词（可解释）
   ├─ describeTable   → information_schema 现查列定义
   ├─ runSql          → 只读执行器（事务级 READ ONLY）→ 结果记在 state 里
   ├─ makeChart       → 用 state 里的结果生成图表配置（数据不经过模型的手）
   └─ saveQuery       → 生成待确认提案（写 query_proposals，不直接落库）
                          ↓
                    只读账号 data_agent_ro（只有 21 张业务表的 SELECT）
```

**两条数据库通道，互不越界**：

| 通道 | 账号 | 用途 |
|---|---|---|
| `DATABASE_URL` | 读写 | 应用状态（保存的查询、表结构索引） |
| `AGENT_DATABASE_URL` | **只读** | Agent 执行 SQL |

Agent 的能力边界和应用的写入能力是两条独立通道 —— 混在一起就说不清"谁能写什么"。

---

## 演示数据

21 张表、约 13 万行，一家「卖硬件 + 卖订阅服务」的公司：

- 共用维度：`customers` `regions` `channels` `employees`
- 电商线：`orders` `order_items` `products` `product_variants` `inventory` `shipments` `returns` `coupons` …
- SaaS 线：`plans` `subscriptions` `invoices` `payments` …
- 服务：`support_tickets`

数据是**脚本生成的，固定种子可复现**，且刻意做出真实结构：双 11 有峰（905 万）、
春节有谷（214 万）、复购率 59%、买过硬件的客户中 33% 后来订阅了服务（跨线分析的基础）。

> 为什么自己造而不是下载公开数据集：国内网络不可控，且真实数据集的列名常是 `col_a`、
> `col_b`，Agent 表现会被数据质量拖累 —— 那就不是在测 SQL 能力了。

---

## 快速开始

```bash
npm install

# 1. 建表（21 张业务表 + 2 张应用表）
npx prisma generate
# 迁移见 prisma/migrations/，用 prisma migrate deploy 或手工执行 SQL

# 2. 灌演示数据（约 13 万行，固定种子）
npm run seed

# 3. 建只读角色（安全模型第 1 层，会把连接串写回 .env.local）
node --experimental-transform-types scripts/setup-ro-role.mts

# 4. 起来
npm run dev
```

环境变量见 `.env.example`。**`AGENT_DATABASE_URL` 必须是只读账号**，
填成和 `DATABASE_URL` 一样就等于把安全交给 prompt 自觉。

冒烟测试（不打开浏览器，直接看执行轨迹）：

```bash
node --experimental-transform-types scripts/smoke-ask.mts "上个月 GMV 是多少？"
```

---

## 测试与评测

```bash
npm test          # 33 条单测：检索打分、图表校验、死循环检测（纯函数，秒级）
npm run test:db   # 14 条数据库/HTTP 测试：两阶段确认的原子消费与五条拒绝路径
npm run eval:recall    # C8：20 题检索召回（纯计算，不花钱）
npm run eval:repair    # C13/C14：36 轮真实 LLM，约 7 分钟
npm run eval:thinking  # C15：thinking 开关的 token 对比（图的是把结论钉在数据上）
```

评测脚本在 `eval/`，跑完落 `eval/results/*.json`。**它们不是"跑绿就完"的测试**——
评估的产出是数字和失败原因，不是 pass/fail。当前结论：

| 指标 | 数字 | 状态 |
|---|---|---|
| 检索召回 recall@3（20 题） | **0.917** | 达标（门槛 0.85，所以不引入向量检索） |
| SQL 修复率（12 条注入故障，撞错后修复） | **0.83** | 达标（门槛 0.75）；同批 75% 的案例模型执行前就静态修好了 |
| 死循环有界 | 5 步停止（上限 10） | ✅ |
| thinking 关闭 | **关不掉** | ❌ 见下面的「已知限制」 |

---

## 安全模型的四层

| 层 | 手段 | 性质 |
|---|---|---|
| 1 | 数据库账号只读（逐表 GRANT SELECT） | **权限层，绕不过** |
| 2 | 事务强制 `READ ONLY` | 引擎层，即使账号配错也拦得住 |
| 3 | `statement_timeout` + 行数上限 + 多语句拦截 | 资源层 |
| 4 | prompt 规则 | 语言层，**不作为安全依赖** |

第 1、2 层各自独立验证过（见 [`docs/ACCEPTANCE-W1.md`](docs/ACCEPTANCE-W1.md) 第 8.3 节）：
即使刻意关掉只读事务，账号权限仍然拒绝 `DELETE` / `TRUNCATE` / `DROP`。

第 4 层只管"让它少犯错"，不管"保证不出事"。这个分工写在这里，是为了防止
将来有人往 prompt 里加几条规则就以为加固了安全。

---

## 路线

| 周 | 目标 | 状态 |
|---|---|---|
| W1 | 地基：骨架 + 演示库 + 只读安全 + 3 个工具 + 单工具 loop | ✅ |
| W2 | 可靠：6 个工具 + 错误自修（定量）+ 三级死循环检测 + 两阶段确认 | ✅ |
| W3 | 可证明：40 条评测集 + 五项指标 + 全过程可见 UI + 部署 | 进行中 |

拉下的判据与遗留项都写在 `docs/ACCEPTANCE-W*.md` 里，包括没做到的。

---

## 已知限制（写清楚，不粉饰）

- **thinking 关不掉。** `thinking:{type:'disabled'}` 与 `reasoning_effort:'none'` 都注入了请求体
  （`eval/probe-inject.eval.ts` 验证过），但 deepseek-flash 端点照常返回 reasoning tokens。
  项目 #1 时这条经验成立，现在不成立了——**经验会过期，所以关键假设要定期重验**。
  现状：成本控制靠 `MAX_STEPS`，不靠关思考。
- **`make_chart` 只画最近一次查询。** 想看两条不同查询的对比，得先把它们 JOIN 成一条 SQL。
  这是刻意的：数据只从 SQL 出，不从模型手里出。
- **`search_schema` 的关键词表要人养。** 20 题里仍有 3 题不满分，原因是"一道题有多条正确路径"
  与同义词覆盖不足。达到不达标门槛才考虑上向量检索（`schema_docs.embedding` 字段已留）。
- **没有对话历史。** 单轮问答，刷新即清空（W3）。
- **`save_query` 只存 SQL 文本**，不是可执行的定时任务；保存的查询不会自动重跑。
