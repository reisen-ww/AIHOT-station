# 四站静态生成入口

唯一编排入口是 AIHOT 真源的 scripts/static-cycle.mjs。它读取四站各自的源码目录，依次导出、构建、合站和全量复验。默认只生成；导入模块也不会启动任务。它不调用旧手机刷新脚本，不启动 API、采集或业务模型，不操作 TTS。

这是本地准备的接入方式，尚未安装到手机、接管计划或实际发布。四站完整成品、手机双 TTS 常驻下的冷/热缓存周期和远端生效证据分别验收。当前本地结果以 static-repair/rolling-20261109/PROGRESS.md 为准。

## 配置与生成

参考同目录 static-cycle.config.example.json，复制到计划使用的独立运行目录并填写实际值。本轮规则已定为每站最近1000篇并集全部原评分≥85公开历史文章，四站合计硬上限900000000字节，700–900MB为可接受区间，700/800MB不触发失败。示例填写这些规则，但没有安装或启用生产计划。源码目录和工作目录必须互不包含、使用真实物理路径。已有非空目录只有本入口正确的 runner-owner.json 才能使用，不能把原库或备份目录指定为工作目录。

四个 databaseEnv 字段只保存环境变量名。由操作者在未来获准执行时提供对应的显式只读连接，入口不自动加载 .env，也不从旧脚本猜连接串。金融 slug 是 cryptohot，历史数据库名为 finhot，二者不可混用。示例 /root/apps 路径来自旧部署资料，安装前必须在当前手机核实。可选 assetsDirectory 指向本站原有联系图片资源目录；原站点、行业和模块差异保留。

每站可选 retainScoreAtLeast，必须是 0 到 100 的数字；不填写时只保留最新 maxItems 篇。填写后，maxItems 限制最近部分，另外保留所有原评分达到该门槛的已公开历史文章，取并集去重后仍按原时间/ID顺序读取。它不改评分、精选状态、来源许可或撤回/未到公开时间的过滤。manifest.window.scoreRetention 记录门槛及额外保留篇数，搜索范围仍为实际在线集合，全部历史报告继续保留。门槛进入内容指纹，修改门槛会重新构建。完整合站超过 budgetBytes 时失败并保留上一版，不自动提高门槛或裁掉达标历史。

2026-11-10 本地已完整验证“每站最近1000篇 + 所有原评分≥85的公开历史文章”：四站4844篇、全部128期报告，完整合站579567649字节；金融1699篇覆盖25个北京时间有文日期。用户将四站硬上限调整为900MB，700–900MB为可接受区间；700/800MB不提前阻断。当前成品标记仍保留原700MB更严格校验，不改写既有证据。示例已填写900MB和各站retainScoreAtLeast:85，仍未安装或启用。详细结果见static-repair/rolling-20261109/SCORE-RETENTION-RESULT-v1.md，手机与真实计划未切换。

在有 Node.js 24 和四站现有依赖的环境中生成：

```text
node /实际AIHOT根/scripts/static-cycle.mjs --config /实际路径/static-cycle.json
```

没有显式 --publish 时不运行 Git 或远端确认请求。媒体处理仍可能请求原来源的图片；网络受限环境可显式提供项目现有的 EGRESS_PROXY_URL，仍检查目标公网地址，不使用 ALLOW_PRIVATE_NETWORK_FETCH 放宽保护。

完整版本位于 workDirectory/runs/<run-id>/combined，以 static-site-release.json 为最后标记。数据库、原始备份和全部历史日/周/月报不清理。lastGenerated 代表本地整版完成；lastConfirmed 只代表曾通过精确远端确认的版本。推送失败或确认超时保留 pending，不把推送退出 0 当上线。

单站手动构建应在 apps/web 目录设置明确 AIHOT_STATIC_STATION、AIHOT_STATIC_DATA、AIHOT_STATIC_URL 和 AIHOT_STATIC_BUILD=1，然后执行 node --max-old-space-size=192 ../../scripts/build-static.ts。它串行等待打包、独立收尾和官方类型恢复；前一阶段结束后才开始下一阶段。192MB 是单个 Node 进程的 V8 上限，不是整机或原生图像库的总内存保证。

## 未来发布与两小时计划

真实提交、推送、凭据使用、手机安装和调度切换仍须当次明确授权。获得授权后，--publish 才会准备独立 Git 树并普通快进推送到 reisen-ww/hot-pages 的 main；--publish-only --publish 只处理已有整版或 pending。目标地址固定为 https://reisen-ww.github.io/hot-pages，不使用 orphan、强推或空提交，不触碰用户已有发布工作树。不承诺远端 Git 历史大小恒定。

准备后的 commit 在推送前持久保存。重试只核对或重推同一 commit；远端 main 有其他变更时停止，保留现场。确认会核对总标记摘要、根入口/404、四站首页和数据 manifest。只有精确相符才更新 lastConfirmed。

同目录 static-cycle.cron.example 仅为未启用模板。每小时调用 --scheduled 可在失败后重试；成功检查按固定两小时时槽跳过重复执行，避免按完成时间另加冷却。所有手动、计划和 publish-only 必须共用同一配置与工作目录。手机环境变量如何提供、Node 的实际路径及原计划如何退役，需要在安装阶段核实；本轮不改现有计划。

## 失败恢复与空间

cycle.lock 覆盖整轮生成、复制、推送和确认。即使锁 owner 缺失、内容损坏或 PID 已退出，也不会自动抢占。硬崩溃后先核实本轮所有子进程已经结束，再由获准操作者保留并移走确属残留的锁；不能只按 PID 存在与否判断。普通日志写失败也会等待自己启动的子进程退出后才放锁。

正常生成后只移除本轮可再生的 snapshots/sites 中间目录。保留最近至少两份实际完整版本，另保留少量无变化运行日志；lastGenerated、lastConfirmed、pending 引用的版本始终保护。只有同时具备本程序 owner 和成功记录的自产旧目录才可能清理；failure.json、未知目录、原始资料及首次保全的旧 build 留存。无变化日志不会挤掉完整版本。发布准备区只有明确远端确认的自产旧版本才适用保留规则，失败与未确认准备区不自动删除。

工作盘不足时停止并保留旧版。缓存、失败现场和原始资料需由操作者结合实际空间审查；入口不会为腾空间删除它们。更换或恢复配置前，先读 state.json 和原始日志；不要删除 pending 来绕过未确认发布，也不要启用旧空提交重试脚本。
