# 门户表单的语义目标采集与确认式草稿录入

Node.js 门户接入项目。当前版本保留网页原件，提供目录预览及表单控件清点；它不把同名文字当作录入许可，也尚未具备按确认意图提交草稿的入口。目录预览继续兼容原资料站。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证目录和表单预览、本地门户真实草稿请求及证据存储。`npm run demo` 保留原目录预览；`node src/form-demo.mjs` 获取门户表单并显示实际控件与原页证据，两者均自行关闭本地服务。`npm run acceptance` 检查语义定位、确认回读及草稿传递接口；当前尚无 collect，因此这些检查会明确失败，不属于现有预览的故障。功能交付后保留已有检查并通过新接口检查，不能改成跳过。

Linux 环境可用 `docker build -t microdata-intake:local .` 预装依赖，然后 `docker run --rm --network none microdata-intake:local` 验证底座。`docker run --rm --network none microdata-intake:local npm run demo` 展示真实预览。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件功能开发后的演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
