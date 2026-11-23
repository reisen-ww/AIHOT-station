# 静态滚动阅读构建（开发候选）

用户已于2026-11-09要求继续本地开发与隔离验证，旧交接暂停状态失效。静态模式复用原组件、行业配置与统一公开读取层，动态部署保留原入口。

2026-11-10新高分本地成品已验证：最近1000篇并集全部原评分≥85的公开历史文章，共1006篇（额外6篇）；全部28日报/4周报/1月报保留。完整构建退出0（572.89秒），9108文件、119779172字节（含本站标记）。原阅读8/8组及新高分旧文/条款/隐私/关于页8/8组桌面和窄屏检查通过，四站合站579567649字节。用户本轮将合计硬上限确认至900MB，700–900MB可接受，700/800不提前阻断；本次成品标记仍为原700MB校验，通过更严门禁即已满足新限额。原库/备份和失败现场保留；不是实体手机或上线验收。旧1000篇结果保留在rolling证据与文档备份。

上述数据来自2026-11-06备份，不是手机最新数据。准确证据见`E:/Shaw live2d/work/y73s/static-repair/rolling-20261109/PROGRESS.md`。源码接入、测试、实际构建、页面交互、实体手机和生产分别验收。

## 文章窗口

`scripts/export-static.ts`新增可选`--max-items <正整数>`。同一只读repeatable-read事务内，按公开文章发布时间（为空时发现时间）倒序、文章ID倒序固定选集。列表、双搜索、事件、主题、分组、续读、RSS及Markdown统一窗口；manifest.window记录数量与起止时间，搜索明确限在线文章。

可选 `--retain-score-at-least <0至100>` 必须和 `--max-items` 一起使用：最新 maxItems 篇照常保留，再加入所有原评分达到门槛的已公开历史文章，去重且保持同一时间/ID顺序。`window.scoreRetention` 记录门槛与额外保留数；此时 maxItems 限最近部分，在线总数可以更大。不填写分数参数仍保持原最近窗口行为，不改评分或精选状态。本轮按最近1000篇+原评分≥85的规则完整实测，用户随后仅将合计容量上限调整为900MB；四站结果见rolling-20261109/SCORE-RETENTION-RESULT-v1.md。

原数据库与备份不删，全部历史日报/周报/月报保留。窗外报告引文回原文，不重新加入旧文章详情。旧直接入口恢复原路径、查询和锚点后解释窗口状态；未知/撤回数据404，超窗数据410。超窗收藏保留、提示并非来源撤回并提供可用原文，不生成悬空本站详情。

四站合计上限现为900000000字节（900MB），700–900MB为用户接受区间，700/800MB不提前阻断。原700MB仅是本轮成品保留的更严格校验记录。须按完整网页、脚本、数据、媒体、OG、历史报告及发布标记实际总字节确定，不能只算JSON或外推图片。

## 显式生成

在本站根目录运行`scripts/export-static.ts`，必需参数为`--station aihot`、`--out <新目录>`、`--database-url <核实过的隔离只读连接>`和`--site-url https://reisen-ww.github.io/hot-pages/aihot`；可选`--max-items`、`--retain-score-at-least`、`--cache-dir`、`--assets-dir`。省略max-items保留全量兼容行为，大库须显式定窗口。

不载入.env，不跑迁移/采集/业务模型/git/发布。中间.source目录无可发布manifest；关闭数据库后转换媒体，全部检查通过才写manifest.json。正文、联系图片和未知媒体失败仍严格中止；有限来源图标容错须记录审计，不能泛化为忽略媒体错误。站内全文与RSS再分发许可独立校验，readingMode为full不是来源授权证明。

在本站apps/web目录设定AIHOT_STATIC_BUILD=1、AIHOT_STATIC_STATION=aihot、AIHOT_STATIC_DATA=<有效快照绝对路径>、AIHOT_STATIC_URL=https://reisen-ww.github.io/hot-pages/aihot，执行`node --max-old-space-size=192 ../../scripts/build-static.ts`。入口串行等待编译进程退出、独立收尾和官方类型恢复，静态模式禁用.env自动载入；不要直接用单个react-router build替代完整流程。先保全已有候选，只有完整数据/媒体/引用/路由/字节校验通过才最后写build-static/client/static-release.json；失败目录不可发布。192MB是单进程V8上限，不是整机总内存保证。

在根目录执行`node scripts/static-preview.ts --dir apps/web/build-static/client --base /hot-pages/aihot --port 43818`。只服务文件，缺失文档用404壳并保持HTTP404，数据和资源不兜底成功。检查筛选、两种搜索、翻页刷新、精选续载、历史报告、旧链接、收藏及海报；窄屏浏览器不是实体手机。分享/canonical/OG/海报二维码使用正式地址。

## 合站与边界

`scripts/static-compose.ts`接受四次`--station slug=client目录`、新`--out`、`--site-url https://reisen-ww.github.io/hot-pages`和显式`--budget-bytes`。核对各站文件集合、哈希、站点/版本/基址/404，再复制并核总量，最后写static-site-release.json。预算须小于1,000,000,000字节。

收藏、已读、搜索、缓存与位置按站隔离，主题共享。v2备份带站点，旧v1导入须确认来源。读者反馈入口取消，历史管理/业务数据/浏览器键保留；用户已决定不公开运营主体与联系方式，条款/隐私页已移除公开字段及待填提示。保留site、industry、模块和手机路径差异，不整站覆盖。

四站统一生成入口、无变化跳过、同一commit重试、锁和版本保留见[静态周期生成](static-cycle.md)，配置和cron均为未启用示例；手机安装条件见[手机切换说明](static-cycle-phone-handoff.md)。本站不另复制一套编排。

当前不提交/推送/发布，不改生产调度/凭据/.env，不写真实业务库，不启停真实站群/TTS，不加构建期内存监控或金额/飞书。手机已改ADB，旧Termux8022自启动可恢复退役；用户明确暂不启动双TTS。双TTS常驻承载及两小时生成/校验/有变化才推送仍未实测，生产集成另需授权。
