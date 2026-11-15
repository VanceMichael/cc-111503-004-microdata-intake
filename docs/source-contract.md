# 来源接口与资料语义

以 WHATWG microdata 的 item 属性遍历和取值规则为准。scope 是实体边界；itemscope+itemprop 的值为嵌套 item。itemref 为本页 id 引用，遍历去重仅限本 item，不能全页共享。itemprop 按 ASCII 空白拆分，重复属性保留顺序；itemid 是声明标识而非自动合并许可。meta/content、time/datetime、data或meter/value、a或area/link/href、媒体/src、object/data 等用其专属值规则，其余文本按标准取值。URL按最终响应URL和首个有效base解析，缺失引用留下诊断，不递归抓取任意外链。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- 两个 item 共用外置参数而不相互消耗
- 嵌套配件不污染整机属性
- 一个元素同时提供两个属性名
- base、相对 URL 与纯文本的差别
- 引用回环、同 itemid 不同实体观察

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。
