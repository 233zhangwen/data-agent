# ACCEPTANCE-W1：数据问答 Agent（Text-to-SQL，含写操作）

> 状态：**W1 已完成**（2026-11-06）
> 项目定位：项目 #3。项目 #1 证明「能做 RAG 并验证它」，项目 #2 证明「能做产品化」，
> 这个项目证明第三件事：**能让 LLM 可靠地执行有副作用的操作**。
> 周期：3 周（2026-11-06 起）

---

## 0. 这个项目不是「RAG 换个皮」

三个真问题，按难度排：

**① 模型得选对工具。** 现在 `agent-llm.ts` 只有一个 `retrieve` —— 没有「选择」，只有「调或不调」。
六个工具之后，模型要在「先看看有哪些表」和「直接跑 SQL」之间做判断，选错的代价是把
20 张表的结构全塞进上下文（token 爆炸），或者对着不存在的列查三次。

**② 错了得能自己修。** SQL 报错是常态：列名记错、类型不匹配、聚合漏 GROUP BY。
「把数据库的报错原样喂回模型让它改」听起来简单，实际要处理：重试上限、同一错误重复犯、
改了三轮越改越远。这段的指标是**平均重试次数**和**修复成功率**，能量出来。

**③ 写操作不能靠 prompt 自觉。** 这是整个项目最重要的一条。
「我在 prompt 里写了不要删数据」不是安全措施，是许愿。真正的做法是给它一个
**没有删除权限的数据库账号** —— 让危险操作在权限层面就不可能，而不是在语言层面被劝阻。

---

## 1. 场景：自然语言问业务数据

用户问「上个月哪个品类的复购率最高」→ Agent 自己决定：
看有哪些表 → 看订单表结构 → 写 SQL → 执行 → 结果不理想就改 → 画图 → 给结论。

**演示数据（拍板：两条业务线混合）**：一家「卖硬件 + 卖订阅服务」的公司，21 张表，
10 万行量级。共用 `customers` / `regions` / `channels` 三个维度，两条业务线各自成链：

| 线 | 表 |
|---|---|
| 维度（共用） | `customers` `regions` `channels` `employees` |
| 电商（实物） | `categories` `products` `product_variants` `warehouses` `inventory` `orders` `order_items` `shipments` `returns` `coupons` `coupon_redemptions` |
| SaaS（订阅） | `plans` `subscriptions` `subscription_seats` `invoices` `payments` |
| 服务 | `support_tickets` |

**为什么混合反而是技术加分**：12 张表的 schema 塞得进 context，
「用向量检索选表」就是个摆设；21 张表就必须有 `search_schema`，
否则每轮对话光表结构就烧掉几千 token。这个复杂度是 `search_schema` 存在的理由。

**跨线分析是深水区**：「买了硬件的客户里，后来订阅服务的比例是多少」这种问题
要跨三条链 JOIN，是真实分析师会问、而模型容易写错的那类问题——评测集里要有。

数据自己造（脚本生成，可复现）：不依赖外部数据集下载（国内网络不可控），
且真实数据集的 schema 往往没有业务语义（列名是 `col_a`、`col_b`），Agent 表现会被数据质量拖累。

---

## 2. 六个工具

| 工具 | 类型 | 补的缺口 |
|---|---|---|
| `list_tables` | 只读 | 多工具选择的第一步；返回表名 + 一句话说明，不返回全部 schema |
| `describe_table` | 只读 | 按需加载结构 —— 大 schema 不塞满 context |
| `search_schema` | 只读 | 表多时用**向量检索**找相关表（项目 #1 的 RAG 经验直接复用） |
| `run_sql` | 只读 | 核心工具；强制 LIMIT、`statement_timeout`、只读事务 |
| `make_chart` | 纯函数 | 结构化输出约束：结果 → 图表配置（不调 LLM，模型只填参数） |
| `save_query` | **写** | 两阶段确认：模型提议 → 用户点确认 → 才落库 |

**为什么 `make_chart` 不调 LLM**：让模型直接产出图表配置（JSON）比自己拼更可控，
但如果让模型同时决定「画什么图」和「数据长什么样」，错了分不清是谁的锅。
分成两步：SQL 出数据（可验证），图表配置由代码按数据形状决定（确定性）。

---

## 3. 安全模型：四层，从硬到软

| 层 | 手段 | 性质 |
|---|---|---|
| 1 | **数据库账号只读**（`GRANT SELECT` only），无 DDL/DML 权限 | 权限层，绕不过 |
| 2 | 事务强制 `SET TRANSACTION READ ONLY` | 引擎层，即使账号配错也拦得住 |
| 3 | `statement_timeout = 10s` + 结果行数硬上限（`LIMIT 1000` 外层包裹） | 资源层，防拖垮数据库 |
| 4 | prompt 规则 + 工具描述约束 | 语言层，只做体验优化，**不作为安全依赖** |

第 1、2 层是**结构性保障**：模型再怎么被诱导也改不了数据，因为账号没有那个权限。
第 4 层只管「让它少犯错」，不管「保证不出事」——这个分工必须写进 README，
否则将来有人往 prompt 里加规则就以为加固了安全。

**反证测试**（必做）：给 Agent 一个明确的诱导（"把订单表清空"），验证它在第 1/2 层被拒，
而不是靠 prompt 拒绝。两种拒绝的性质完全不同：前者是安全，后者是运气。

---

## 4. 三周里程碑

| 周 | 目标 | 判据 |
|---|---|---|
| **W1** | 地基通：骨架 + 演示库 + schema 元数据 + AI SDK 接 DeepSeek + 单工具 Agent loop 跑通 | 能用自然语言问出「订单总数」并返回真实数字 |
| **W2** | 可靠：6 工具齐 + SQL 错误自动修复 + 死循环检测 + 四层安全 + `save_query` 两阶段确认 | 诱导删库被权限层拒绝；SQL 报错后能自己改对 |
| **W3** | 可证明：40 条评测集 + 五项指标 + 全过程可见 UI + 部署 + README/面试文档 | 评测跑出真实数字，线上可访问 |

---

## 5. 验收判据

| 编号 | 判据 | 怎么验 |
|---|---|---|
| **C1** | 演示库可复现：一条命令重建 12 张表 + 10 万行 | 清库重跑，行数与分布对得上 |
| **C2** | 单工具 loop 通：自然语言 → SQL → 真实结果 | 问 5 个已知答案的问题，数字全对 |
| **C3** | 模型能选对工具：不需要人工指定先看哪张表 | 日志里工具调用序列合理（不是每次先 list 全表） |
| **C4** | SQL 报错能自修：注入错误列名后成功修复 | 平均重试 ≤ 1.5 次，修复成功率可量 |
| **C5** | 危险操作权限层拒绝（**不是 prompt 拒绝**） | 诱导删库 → 数据库报权限错误，且模型如实说明而不是假装成功 |
| **C6** | 写操作两阶段：未确认不落库 | 不点确认 → DB 里查不到；点确认 → 落库 |
| **C7** | 不退化：tsc / lint / 单测全绿 | 每周收口 |

---

## 6. 显式不做

- **多轮对话记忆**：单轮问答，多轮归 W3 之后（避免和项目 #1 的会话历史重复建设）
- **用户系统 / 多租户**：项目 #2 已经做过，这里不重复；单用户，无登录
- **任意数据源连接**：只连自己的演示库，不做「接入你的数据库」（那是另一个量级的安全问题）
- **自然语言建表 / DDL 生成**：只读 + 一个受限写操作，不做 schema 变更
- **内容流水线 / 知识库整理场景**：评估过，同一套框架的另两个应用场景，三周内做必然都浅

---

## 7. 已拍板

| 项 | 定案 | 理由 |
|---|---|---|
| 演示数据 | **电商 + SaaS 混合，21 张表** | 表多才让 `search_schema` 成为必需件；跨线分析是深水区 |
| 图表 | **Recharts 前端渲染** | 模型只填参数（类型/维度/度量），渲染确定性；配置可测，错了分得清是参数错还是渲染错 |
| 过程可见 | **全程可见**（选了哪张表、SQL、每次结果行数、重试） | 面试演示亮点；用户能判断可信度；自己调错时能看到 SQL |
| 写操作确认 | **服务端两阶段**（自己定，不问） | 客户端拦截可绕过——直接调 API 就跳过了，那等于没拦 |

**界面形态**：左侧对话 + 右侧「执行轨迹」时间轴（工具名、入参、返回摘要、耗时）。
SQL 单独高亮展示，可一键复制。

---

## 8. W1 实施记录（2026-11-06）

### 8.1 落地

| 文件 | 内容 |
|---|---|
| `prisma/schema.prisma` | 21 张业务表 + 2 张应用表（schema_docs / saved_queries）；表名与列名全部 `@map` 到 snake_case |
| `prisma/migrations/20261106150000_init/` | 建表 SQL（Prisma 7 的 `migrate diff --to-schema` 生成，手工加 `CREATE EXTENSION vector`） |
| `scripts/seed.mts` | 13 万行演示数据，固定种子可复现，数据里有季节性/复购/跨线转化 |
| `scripts/setup-ro-role.mts` | 创建只读角色 `data_agent_ro`，逐表授权，写完自动验证 |
| `src/lib/agent-db.ts` | 只读查询执行器：事务级 READ ONLY、10s 超时、行数上限、多语句拦截、错误分类 |
| `src/lib/agent.ts` | 3 个工具（listTables / describeTable / runSql）+ ToolLoopAgent |
| `src/lib/schema-docs.ts` | 21 张表的语义说明（做什么 · 怎么连 · **哪里容易写错**） |
| `src/lib/agent-prompt.json` | system prompt 单一来源（评测和线上读同一份） |
| `src/app/api/ask/route.ts` | UI Message Stream 端点 |
| `src/app/AskPanel.tsx` | 对话 + 工具调用展开（每次 SQL 都可见） |
| `scripts/smoke-ask.mts` | 冒烟测试：把执行轨迹和答案打出来 |

### 8.2 判据对账

| 编号 | 判据 | 结果 | 证据 |
|---|---|---|---|
| **C1** | 演示库可复现 | ✅ | 固定种子；`npm run seed` 重建 24 表 / 13 万行；月度 GMV 呈 11 月峰（905 万）、春节谷（214 万）、618 峰（695 万） |
| **C2** | 单工具 loop：自然语言 → 真实数字 | ✅ | 「订单总数」→ 14,900（与库内一致），4 次工具调用，首字 1.3s |
| **C3** | 模型能选对工具 | ✅ | 简单问题 1 次 listTables + 1~3 次 SQL；复杂问题（退货率）先并行 describeTable 5 张表再写 SQL，没有盲猜列名 |
| **C4** | SQL 报错能自修 | ⚠️ **部分** | 修复 rollback bug 后模型能改对，但没有**专门构造**错误场景做定量验证（见 8.4 遗留） |
| **C5** | 危险操作权限层拒绝 | ✅ | 见 8.3，两层独立 |
| **C6** | tsc / lint | ✅ | 均 0 |

### 8.3 C5 的硬证据（不依赖模型表现）

直接打数据库层，绕开 Agent：

```
第 2 层（只读事务）：
  DELETE  -> cannot execute DELETE in a read-only transaction
  UPDATE  -> cannot execute UPDATE in a read-only transaction
  DROP    -> cannot execute DROP TABLE in a read-only transaction
第 1 层（只读账号，刻意去掉只读事务 —— 模拟第 2 层失效）：
  DELETE   -> permission denied for table orders
  TRUNCATE -> permission denied for table orders
  UPDATE   -> permission denied for table orders
  INSERT   -> permission denied for table customers
  DROP     -> must be owner of table orders
  CREATE   -> permission denied for schema public
事后核对：orders 仍有 14,900 行，数据完好。
```

**两层独立**是这条判据的全部价值：如果只有一层，任何一次配置疏漏都意味着裸奔。

### 8.4 踩坑：一条报错的 SQL 污染了整条池连接

冒烟测试第一次跑：「订单总数」的答案是对的（14,900），但过程是这样的：

```
runSql: SELECT ... MIN(order_date) ...        ← 列名错（实际是 ordered_at）
runSql: 同样的错误重试两次
runSql: current transaction is aborted        ← 之后全是这个
runSql: 同样
```

根因：`BEGIN TRANSACTION READ ONLY` 之后 SQL 报错，事务进入 **aborted** 状态，
而我的 `catch` 直接 `throw`，**没有 ROLLBACK** —— 连接带着 aborted 事务回到池里，
下一个拿到这条连接的请求无论 SQL 写得多对，都只报 `current transaction is aborted`。
模型看到这个错会以为是自己的 SQL 有问题，于是继续改 SQL，把步数预算烧光。

修法：`finally` 里无条件 `ROLLBACK`（并 catch 掉 rollback 自身可能的失败）。

**这件事本身就是「全程可见」的收益证明**：答案是对的，只看答案的 UI 永远发现不了它。
如果没有把每一步工具调用摊开，这个 bug 会一直潜伏到线上，表现为"偶发地回答不出来"。

同一个坑在**测试脚本里又踩了一次**（catch 里没 rollback，导致后续探针全部误报
"current transaction is aborted"）—— 这说明它不是疏忽，是这类代码的结构性陷阱。

### 8.5 两个设计上的即时修正

**① `@map` 漏了列名。** 第一版只给表加了 `@@map`，列还是 `customerId`。
结果是 Agent 每条 SQL 都得写 `"customerId"`（PG 会把未加引号的标识符转小写），
忘一个就报错。这不是要考的能力，它会污染整个评测。改成全部 `@map` 到 snake_case，
重建 24 张表。**教训：混用两套命名约定时，要么全 camelCase 要么全 snake_case，
"表 snake 列 camel"是最坏的组合。**

**② 文档里的行数会漂移。** 客户数从 5 千调到 2 万、订单从 2.5 万调到 1.5 万之后，
`schema-docs.ts` 里还写着"5000 人""2 万单"—— 模型会把它当事实用，**而且不会报错**。
改成 `listTables` 时用一条 UNION ALL 现查行数。写死的数字必然过时，这是结构性的。

### 8.6 W1 遗留（进 W2）

1. **C4 只算部分达成**：需要专门构造错误场景（错误列名 / 类型不匹配 / 聚合漏 GROUP BY），
   量出「平均重试次数」和「修复成功率」，这才是判据要求的定量验证。
2. **思考 token 未验证关闭**：流里有 `reasoning-start/end` 事件（内容加密）。
   `thinking: {type:'disabled'}` 的注入是否生效需要用 token 数验证（对比开关前后）。
3. **还剩 3 个工具**：searchSchema（表多时向量检索选表）、makeChart、saveQuery（两阶段确认）。
4. **UI 还是一次性对话**：没有历史、没有保存的查询列表，W3 一起做。
5. **阈值**：`MAX_STEPS = 10` 是拍的。退货率那个问题跑满了 10 步 —— 需要看是真的需要还是浪费。

### 8.7 一个超出预期的观察

「退货率最高的 5 个商品」那个问题，模型的回答里主动做了三件我没想到的事：

- 指出**样本量不足**："单个商品一年只有 36–65 条订单明细，排名前后几名差距在统计上不太稳"
- 给了**两种口径**：全量 top5 + 至少 50 条明细才排名的 top5
- 指出**两个视角都出现的商品**最值得排查，并建议下一步按 `returns.reason` 拆解

这不是"生成 SQL"，是分析。说明 system prompt 里那句「不要编造数据，查不到就如实说明」
加上工具返回的真实行数，确实让它在按事实说话，而不是按语言模型的下一个 token 说话。
