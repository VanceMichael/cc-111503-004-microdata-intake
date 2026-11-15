# 门户表单及语义定位契约

本地门户由 src/form-source.mjs 提供。formFixture 生成来源，jobs 是经过业务方确认的录入意图，包含 id、formName、fields 和 submitterName；每个字段用 accessibleName、role 和 value 表达目标。pages.initial 与 pages.beforeSubmit 分别是形成定位计划时和真正提交前回读的页面地址。地址只指向同一来源的本地草稿门户，不存在生产账号。

## 页面解释范围

采用 HTML5 树，不按 CSS 位置或 DOM id 作为业务身份。范围包括原生 form、input、select、textarea、button、label、fieldset、legend；不要求执行脚本、解析 CSS 或实现完整浏览器可访问树。textbox 包括普通文本 input 与 textarea，combobox 包括单选 select，button 包括提交按钮。文件控件、自定义角色和未支持的名称计算结构应报告不支持，不猜值。

名称计算按 Accessible Name 1.2 的对应子集解释：aria-labelledby 依次引用本页 id、aria-label、原生关联或包裹 label，按钮还可用其文本。直接引用的隐藏文本可以供名；普通隐藏内容不自动参与。引用跨多个元素，需保留参与供名的节点和来源位置；引用缺失、重复 id、引用回环或同表单下存在多个相同名称和角色的候选时，不允许自动选择。相同标签在不同表单下可独立存在。表单名称来自 aria-labelledby 或 aria-label。

表单所有权采用控件显式 form 属性或最近祖先 form；两者不同时显式关联优先。名称和所有权都是定位条件。disabled 控件及 disabled fieldset 的后代不参与写入或提交，但首个 legend 下的控件遵守 HTML 的例外。readonly 可以随表单提交，不允许被录入意图覆盖。选项、checkbox 和 radio 按页面所声明的选中状态提交。

## 确认与草稿提交

计划记录能唯一定位的表单、字段及提交者，也记录页面证据。提交前回读允许 DOM id、标签包装和布局变化；字段的 name/type、表单所有权、目标 action/method 或提交者身份发生变化，旧确认无效，返回 pending。nonce 是服务端新发的一次性隐藏值，不是稳定字段身份，应使用回读页中的当前值。提交者的 formaction/formmethod 会改变目标，属于确认范围；只允许与来源同源的 /draft，不能试发 /formal 或其他路径。

使用 application/x-www-form-urlencoded，按文档顺序构造成功控件的键值对：无 name、禁用、未选中的 checkbox/radio 以及未采用的提交按钮不参与；重复 name 不合成一个值。控件的 form 关联允许它位于 form 元素之外。文本用当前值，select 用选中且未禁用的 option，采用的提交按钮带自己的 name/value。服务端返回原始字段列表和 receipt，HTTP 200 但非 draft 状态不得交付为成功。

## 接收接口

src/intake.mjs 已有 preview(source, store) 和 previewForm(source, store)。新增 collect(source, store) 处理 jobs；调用方创建与关闭来源和 Inbox。records 仅包含收到有效草稿回执的条目，字段含 jobId、receipt 和 evidence；pending 含 jobId、reason 及可用定位证据。失败、身份漂移或歧义不得产生 POST，多个工作项的状态相互独立。原页、回读页、实际发送的键值对与响应均以 Inbox 保留，证据必须能回到实际页面节点，而非只保留重建字符串。

当前目录资料的预览入口保持兼容；历史 microdata 来源仍用于已有预览检查，但本次新增接口处理的是门户表单，不需要增加旧目录的批量实体采集。

## 参考

Accessible Name and Description Computation 1.2：https://www.w3.org/TR/accname-1.2/
HTML 表单数据集构造：https://html.spec.whatwg.org/multipage/form-control-infrastructure.html
