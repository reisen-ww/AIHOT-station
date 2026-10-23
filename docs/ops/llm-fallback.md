# 模型兜底链运维手册

四个站共用一条模型回退链：探测首选模型，坏了按档位顺序往下退，好了自动升回。它不属于站点代码，是部署机上的运维脚本。

> 2026-10-22 实测结论：**升回机制真实存在并已自动生效**（当天 2 次 deepseek→mimo 升回，前一天 4 次）。这条链路不会把站点卡死在最差档。

## 文件位置

| 文件 | 用途 |
|---|---|
| `.tasks/llm-fallback.ps1` | 探测、切档、重启站点的脚本 |
| `.tasks/llm-fallback.config.json` | 档位顺序、探测超时、切档门槛、站点清单 |
| `.tasks/llm-fallback.state.json` | 运行状态：当前档位、每档 okStreak / failStreak |
| `.tasks/llm-fallback.log` | 探测与切换日志 |

`config.json` 里含 API Key，**不要提交进仓库**（`.tasks/` 与仓库是分离的）。本文件只描述结构，不写密钥。

## 探测与决策算法

每 10 分钟跑一次（计划任务 `MultipleInstances = IgnoreNew`，上一轮没跑完时下一轮直接跳过，不会并发写 state）。

1. **探测**：从第 0 档开始按顺序探，遇到第一个 `ok` 就 `break`。
   - 首选健康时每轮只花一次探测（这是"日志里只见单档 probe"的正常现象，不是漏测）
   - 掉到第 N 档时，每轮会重测它上面的所有档——**这就是升回的探测基础**
2. **选目标**：按档位顺序取第一个 `ok 且 okStreak >= okStreakToPromote` 的档。
3. **切档**：目标 ≠ 当前且满足门槛（`failStreakToSwitch` 连续失败）时切换，同步改写四站 `.env` 的 `LLM_MODEL` 并重启四站。
4. **升回守卫**：若"当前档本轮也被探测且应答正常"，先不升回。注意——探测在更高档就 `break` 了，**当前的低档本轮根本没被探测**，所以守卫不会拦住升回。

### 升回需要多久

`okStreakToPromote = 2`、探测间隔 10 分钟 → 故障模型恢复后**约 20 分钟自动升回**。

### 切换的代价

每次切档都会重启四站。2026-10-22 的 3 次切档（01:23 / 13:32 / 14:42）各造成一轮服务抖动，也是当天日报晚生成约 1.5 小时、下午回执稀疏的直接原因。**因此超时阈值宁宽勿窄**：误判"慢"为"死"的成本（重启四站）远高于多等几分钟。

## 当前档位（2026-10-22 起）

| # | id | 模型 | 探测超时 | 备注 |
|---|---|---|---|---|
| 0 | `hcnsec-mimo` | MiMo-V2.6-Flash | 150s | 四站在用；实测 3–7s，抖动期 40–130s |
| 1 | `hcnsec-minimax` | MiniMax-M3.1-Flash | 60s | 上游路由名带 `free`；**未做生产验证** |
| 2 | `hcnsec-deepseek` | DeepSeek-V4-Flash | 120s | 实测 1.6s，最快；多次实战兜底 |
| 3 | `hcnsec-sensenova` | sensenova-6.8-flash-lite | 60s | 实测 2.1s |
| 4 | `hcnsec-step5` | step-5-preview | 60s | 首测出现过一次空响应 |
| 5 | `hcnsec-dspro` | DeepSeek-V4-Pro | 60s | **名不副实**：上游实际路由到 Flash 的 Vision 版 |
| 6 | `hcnsec-qwen-fn` | Qwen3.8-Flash-Next | 90s | 实测 22s，偏慢 |
| 7 | `hcnsec-qwen-27b` | Qwen3.8-27B | 90s | 实测 22s，偏慢 |

全档 `reasoningTokens = 4000`，同一 base 与 key。已删除：`wawazz-luna`（见下）。

## 五条硬经验

### 1. `probeTimeoutSec` 必须按实测延迟定，不能照抄默认值

模型"慢"和"死"是两件事：**真断是连接错误，秒级返回；慢是超时线切得太紧。**

- 2026-10-21 DeepSeek 实测 62s → 阈值设 120s
- 2026-10-22 MiMo 从 3s 劣化到 42–130s，60s 阈值把"慢但活着"判成 DOWN，一度即将触发误切；改成 150s 后同一分钟、同一延迟，判定从「DOWN→切站」翻成「up→不动」
- 定值方法：取该模型劣化期的实测上限 × 1.5～2

### 2. 目录里有模型 ≠ 账号能调；延迟不可控的档不能当最后一道保险

`wawazz-luna`（`gpt-6-luna`）的教训：`GET /v1/models` 明确列出了它，但实际请求返回 `Model "gpt-6-luna" is not supported by any configured account in this group`。该账号组 9 个模型里有 4 个可用，延迟在 3.7–44 秒之间随机，并且长期 100% 失败却一直挂在链尾。

结论：**免费中转不能只看模型清单，必须逐个发一次真实请求测通**；做兜底链最后一环的档位必须延迟可控。

### 3. 只看局部数据会得出反向结论

2026-10-22 下午，仅凭 40 分钟内 4 个点（115s→130s）判断"崩溃式劣化、建议立刻切站"，是错的。拉全天 59 次探测才看清：`up=54 / DOWN=5`，成功率 91.5%，**5 次 DOWN 全部在下一轮恢复，从未连续 2 次**，而切档门槛正是连续 2 次。这是上游间歇抖动，不是崩溃。

判定"是否恶化"必须用**全天样本 + 连续失败次数**，不能用最近几个点。

### 4. 档位数量增加后，最坏探测轮时长会超过探测间隔

8 档全挂的理论上限是各档超时之和 ≈ 690 秒 > 10 分钟间隔。靠 `IgnoreNew` 兜住：最坏后果只是"少探测一轮"，不会并发、不会重复写 state。只要深档活着，实际上限就锁在 330 秒内。**不需要为此加超时上限。**

### 5. 免费额度会静默转付费

`MiniMax-M3.1-Flash` 当前上游路由到 `minimax-m3.1-flash-free`，是免费档。但这是**当下路由**，供应商随时可能改。一旦它被真实调用，要核对回执里是否出现该模型的计费记录——出现即表示免费额度已耗尽。

## 日常操作

```powershell
# 只探测不动作，看当前会怎么判（改配置后必跑）
powershell -File E:\NEWS\.tasks\llm-fallback.ps1 -DryRun

# 看当前档位与连续计数
Get-Content E:\NEWS\.tasks\llm-fallback.state.json

# 看最近切换记录
Select-String -Path E:\NEWS\.tasks\llm-fallback.log -Pattern 'SWITCH|probe DOWN'

# 看当前四站实际用的模型（.env 才是真相，config 只是意图）
Get-ChildItem E:\NEWS\apps\*\apps\api\.env | ForEach-Object {
  "$($_.Directory.Parent.Parent.Name): " + (Select-String -Path $_ -Pattern '^LLM_MODEL=').Line
}
```

### 改档位的规矩

1. 改前备份：`Copy-Item llm-fallback.config.json llm-fallback.config.json.bak-<原因>`
2. 改 `tiers` 数组时**保持 id 与 state 键一致**（删档要同时删 state 里的对应键，否则残留计数会被误用）
3. 改完必须 `-DryRun` 验证一轮：结构正常、首选探测 up、输出 `already on the best tier`
4. 改 config **不会**重启站点（只有"切档"动作才重启），可以放心改

### 备份清单（保留 3–5 天）

`.bak` / `.bak-mimo` / `.bak-luna` / `.bak-timeout150` / `.bak-tier8`

## 巡检要看什么

| 指标 | 正常 | 异常信号 |
|---|---|---|
| 切档次数 | 单夜 0 次 | 一夜多次 → 上游不稳，考虑把更稳的档提上来 |
| 首选探测延迟 | <10s | 持续 >40s → 上游降级，查阈值余量 |
| `okStreak` | 持续增长 | 停滞 + `failStreak` 上升 = 正在坏 |
| 新档是否被探测 | 一次都不该被测 | 被探测说明已经降级过 |
| 回执里的模型分布 | 全是当前档模型 | 出现未预期模型 = 有进程还拿着旧 `.env` 在跑（`.env` 改了但进程没重启） |

最后一条是历史坑：改 `.env` 不等于生效，**进程不重启就还在用旧模型**。核对时以回执里的模型名为准，不要以 `.env` 内容为准。

## 已知盲点

`config.json` 的档位与站点 `.env` 的 `LLM_MODEL` 是两套独立记录。正常切换时脚本会同步改写，但**手工改了其中一边不会自动对齐**。巡检时两边都要看。
