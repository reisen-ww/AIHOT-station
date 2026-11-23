import { CodeBlock } from "./CodeBlock";
import { Address, Block, PanelHead } from "./parts";
import type { AgentPanelProps } from "../../modules";

/** Pages serves files, not a fake always-healthy MCP server. These URLs are real exported resources. */
export function StaticPanel({ base }: AgentPanelProps) {
  return <>
    <PanelHead label="公开快照" title="同版本文章，完整历史报告">
      直接读取文件，无需登录或 API Key。GitHub Pages 不执行在线 MCP 或带查询参数的 REST 请求；浏览器搜索由同版本索引在本地完成。
    </PanelHead>
    <Block title="从使用说明开始"><Address url={`${base}/agent/index.md`} /></Block>
    <Block title="获取完整索引">
      <Address url={`${base}/data/manifest.json`} />
      <CodeBlock lang="bash" code={`curl --compressed '${base}/data/manifest.json'`} />
      <p>manifest 列出当前在线文章、详情、全部历史报告和获许可的全文搜索分片。两种搜索均限于当前在线文章；window 记录窗口范围，availability 区分超窗与不再公开。按文件内容的 SHA-256 校验字节，整次读取绑定一个 revision；站点更新后重新读取 manifest，不要混用版本。</p>
    </Block>
    <Block title="文章与报告 Markdown">
      <p>文章使用 manifest 中已有 id：<code>{base}/items/&lt;id&gt;/export.md</code>。正文只在来源许可时提供，摘要内容不会被扩写成全文。</p>
      <p className="mt-3">日报、周报、月报的 Markdown 地址和历史期号见使用说明；RSS 可在另一个接入页签直接订阅。</p>
    </Block>
  </>;
}
