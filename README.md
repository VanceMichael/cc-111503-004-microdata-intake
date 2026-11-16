# 门户表单的语义目标采集与确认式草稿录入

Node.js 门户接入项目。保留网页原件、目录预览与表单控件清点，并按表单语义定位把已审核资料录入本地合作门户的公开草稿表单。collect(source, store) 只交付真正收到 draft 回执的条目；同名文字、缺失或多义的标签引用、确认回读不一致都会转人工，且不发出 POST。目录预览继续兼容原资料站。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证目录和表单预览、名称计算与表单所有权、语义定位、确认回读、真实草稿请求及证据存储。`npm run demo` 保留原目录预览；`node src/form-demo.mjs` 获取门户表单并显示实际控件与原页证据；`npm run collect-demo` 执行一次完整草稿录入，可加场景名（如 `npm run collect-demo -- identity-drift`）观察转人工结果。以上命令均自行关闭本地服务。`npm run acceptance` 检查语义定位、确认回读及草稿传递接口，交付后必须通过，不能改成跳过。

Linux 环境可用 `docker build -t microdata-intake:local .` 预装依赖，然后 `docker run --rm --network none microdata-intake:local` 验证底座。`docker run --rm --network none microdata-intake:local npm run demo` 展示真实预览。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件功能开发后的演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。

## 录入流程

1. 读取 `source.pages.initial` 并保存原页证据，按可访问名称与角色为每个字段、表单和提交者形成定位计划；重名、引用缺失、重复 id 或引用回环直接转人工。
2. 在真正提交前重新读取 `source.pages.beforeSubmit`。DOM id、label 的包裹方式和布局变化不影响计划；字段 name/type、表单所有权、目标 action/method 或提交者身份变化时旧确认作废，该工作项进入 pending。
3. 只向同源 `/draft` 提交 `application/x-www-form-urlencoded` 数据，成功控件按文档顺序构造，重复 name 不合并，未采用的提交按钮、禁用控件和未选中的 checkbox/radio 不参与。
4. 原页、回读页、定位计划、实际请求体和响应都作为证据存入 Inbox；records 引用计划断言中的存储 id，节点位置可用证据中的字节偏移回读。
