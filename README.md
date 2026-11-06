# 数据问答 Agent（Text-to-SQL）

用中文问业务数据，Agent 自己决定看哪张表、写什么 SQL、错了怎么改 —— 每一步都摊开给你看。

> 项目 #3。前两个项目分别证明「能做 RAG 并验证它」和「能做产品化」，
> 这个项目要证明第三件事：**能让 LLM 可靠地执行有副作用的操作**。
>
> 状态：W1 完成（地基 + 3 个工具 + 只读安全模型），W2/W3 进行中。

---

## 它解决什么

给 LLM 一个数据库账号让它随便查，是最容易做的技术演示，也是最容易出事的产品。

这个项目的重点不是"能生成 SQL"，而是**出错时会发生什么**：

| 风险 | 这里的做法 |
|---|---|
| 模型删库 | 数据库账号**没有写权限** + 事务强制只读。不靠 prompt 劝阻 |
| 模型写错 SQL | 报错原样喂回去让它自己改（带 position 与 hint） |
| 一条 SQL 拖垮库 | `statement_timeout` 10 秒 + 返回行数硬上限 |
| 模型编数字 | 工具返回真实行数；prompt 要求"查不到就说明"，且答案必须来自执行结果 |
| 大面积扫表烧 token | 表结构只给一句话说明，按需 `describeTable` |

---

## 架构

```
用户问题
   ↓
ToolLoopAgent（AI SDK 7，最多 10 步）
   ├─ listTables      → 21 张表的用途 + 当前行数
   ├─ describeTable   → information_schema 现查列定义
   └─ runSql          → 只读执行器（事务级 READ ONLY）
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
| W2 | 可靠：6 个工具 + SQL 错误自修（定量）+ 死循环检测 + 写操作两阶段确认 | 进行中 |
| W3 | 可证明：40 条评测集 + 五项指标 + 全过程可见 UI + 部署 | 未开始 |

拉下的判据与遗留项都写在 `docs/ACCEPTANCE-W*.md` 里，包括没做到的。
