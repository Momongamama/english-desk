# English Desk 改版計畫

最後更新：2026-11-04。這份給接手改版的人看：先讀這裡，再看品牌規範和內容大綱。

## 來源文件

- 內容大綱（Claude Doc，可編輯）：https://claude.ai/artifact/LLWKu3Q7gYDMV1rTGAZo9H ，最後一節「對照三個來源的修改建議」是待做清單。
- 品牌規範（Design System）：https://claude.ai/artifact/MybY4d7FoLjGSGtNvRHKRe 。本 repo 的 `docs/brand/` 是副本：`README.md`（規則）、`tokens.json`（顏色、字級、間距、圓角）、`components.css`（元件樣式，class 前綴 `ed-`）。
- 風格提案頁（A–F）：https://claude.ai/artifact/VcTt55ASR24WvY2YP9BkzP ，選定 F「孔版＋粉彩」。

## 硬規則

- 圓角只有三種：10px（小格子、提示列）、18px（裝內容的盒子）、膠囊（能按的、標籤）。
- 外框只有 1.5px 一種（今日任務錯版外框 3px 例外）。間距 4/8/12/16/24/32。字級只用規範裡的 8 個。
- 口說珊瑚、寫作紫、今天與跟讀綠、卡片黃，整站固定。
- 淺色、深色都要過 4.5:1。

## 四個 PR（各自一個 thread）

1. **換成風格 F**：`index.html` 樣式改寫、首頁加本週完成天數與每天練習次數長條圖（從紀錄算，不記時間）。
2. **新聞＋題目**：GitHub Actions 排程抓 BBC Business／Technology／World 和 CNN 的 RSS（CNN 不能用就換 NPR），存成 repo 裡的 `news.json`。「今天」加今日新聞卡；口說和寫作的題目改成新聞標題，保留自訂題目；AI 拿到該則摘要當背景。只放標題、摘要、連結。
3. **口說兩種模式**：① 網站串 Gemini Live API 語音對話，聊完用逐字稿檢討（只限 Gemini）；② 取代打字聊天的「貼稿評分」：貼上在 Gemini App 等處的逐字稿，評 CEFR、挑 5 個重點、存卡片。
4. **跟讀分頁**：podcast 音檔連結或上傳音檔 → Gemini 轉帶時間的逐句稿 → 逐句循環、錄音對比；發音評分用 Azure 發音評估（設定加 Azure key 與地區），沒填就用 Gemini 給建議；保留「打開 Enjoy」；練完記入本週進度。

另外已決定：做「每月同題重做」（每月第一天提醒，旁邊放上個月同題結果）。

## 後來補充的決定

- 已決定（11/04）：週日卡片總複習兩者都保留，網站內可複習，也能匯出到 Anki 複習。
