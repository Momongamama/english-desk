# English Desk

個人英文口說與寫作練習頁。和 AI 對話、批改短文，把修正過的說法存成卡片每天複習。

- AI：Gemini 或 Claude，在「設定」頁填自己的 API key（只存在瀏覽器裡，不在這個 repo）
- 資料：卡片和紀錄存在瀏覽器裡，設定頁可以匯出／匯入備份
- 卡片可以匯出成 Anki 能匯入的 CSV

## 每日新聞題目

- `.github/workflows/news.yml` 每天台灣時間 05:30 跑 `scripts/fetch-news.mjs`，把 BBC（Business／Technology／World）和 CNN 的 RSS 整理成 `news.json` 並 commit 回 main。也可以在 Actions 分頁按「Run workflow」手動更新。
- CNN 的 RSS 很多已經停更。腳本會檢查：最新一則超過 3 天、或三個分類有兩個抓不到，就自動改抓 NPR。
- 只存標題、一句摘要、連結，不存全文。
- 「今天」分頁顯示今日新聞；口說和寫作的題目改用新聞標題（仍可自己輸入），AI 會拿到該則的標題和摘要當背景。`news.json` 不存在時改用預設題目。
- 口說有兩種方式：「語音對話」用 Gemini Live API（預設 `gemini-3.8-live`，可在設定改）直接在瀏覽器說話，聊完自動用逐字稿評 CEFR、挑 5 個重點；「貼稿評分」把在 Gemini App 等處聊完的逐字稿貼進來評分，Gemini 和 Claude 都能用。語音對話只支援 Gemini，需要允許麥克風（iPhone 用 Safari，iOS 14.5 以上）。

## 新聞閱讀器與查字典

- 「今天」的新聞按「閱讀全文」：瀏覽器當場透過 r.jina.ai 抓原文並重新排版，全文不存進這個 repo。抓不到時可以貼上文章。
- 點任何字會查「設定 → 字典與考試單字」匯入的字典（存在瀏覽器 IndexedDB，不上傳），沒匯入時用 Free Dictionary 英英解釋。
- 「加入單字本」會存成卡片（kind: word），照原本的間隔複習，也能匯出 Anki。
- 托福／雅思／GRE 單字畫底線：實線托福、虛線雅思、波浪線 GRE。清單用總表 CSV（word,TOEFL,IELTS,GRE）匯入。
- 字典和清單是個人檔案，不放進 repo。
