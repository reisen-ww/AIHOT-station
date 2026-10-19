// 站别切换的目标地址。四个站各有一份：内容一样，只有 CURRENT_STATION 和四个 port 不同。
// 用 127.0.0.1 与本机的 aihot-portal 保持一致；端口就是各站 site/site.ts 里的 defaultUrl。
export const STATIONS = [
  { key: "ai", label: "AI", port: 3000 },
  { key: "finance", label: "金融", port: 3010 },
  { key: "academic", label: "学术", port: 3020 },
  { key: "open", label: "开源", port: 3030 },
] as const;

/** 本站的 key：报头上哪一个高亮。 */
export const CURRENT_STATION: (typeof STATIONS)[number]["key"] = "ai";
