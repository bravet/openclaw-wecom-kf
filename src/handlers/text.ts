import { registerHandler } from "./registry.js";

registerHandler("text", {
  extract: (msg) => {
    if (msg.msgtype !== "text") return "";
    return (msg as any).text?.content ?? "";
  },
});

registerHandler("msgmenu", {
  extract: (msg) => {
    if (msg.msgtype !== "msgmenu") return "[msgmenu]";
    const menu = (msg as any).msgmenu;
    const head = menu?.head_content ?? "";
    const items = (menu?.list ?? [])
      .map((item: any) => {
        if (item.type === "click") return item.click?.content ?? "";
        if (item.type === "view") return item.view?.content ?? "";
        if (item.type === "miniprogram") return item.miniprogram?.content ?? "";
        return "";
      })
      .filter(Boolean);
    return head ? `${head}\n${items.join("\n")}`.trim() : items.join("\n") || "[msgmenu]";
  },
});
