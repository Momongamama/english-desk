# English Desk

個人英文口說與寫作練習頁。和 AI 對話、批改短文，把修正過的說法存成卡片每天複習。

- AI：Gemini 或 Claude，在「設定」頁填自己的 API key（只存在瀏覽器裡，不在這個 repo）
- 資料：卡片和紀錄存在瀏覽器裡，設定頁可以匯出／匯入備份。匯入是「合併」：每張卡有 `updated`（毫秒），同一張卡保留較新的複習進度；刪掉的卡記在 `deleted`（保留 90 天），匯入後另一台也會刪掉。合併邏輯是 `app.js` 的 `mergeData()`，之後的雲端同步也用它
- 可以「加入主畫面」（PWA，`manifest.webmanifest`）：iPhone Safari 對沒加入主畫面的網站，7 天沒開可能清掉資料；加入後不會。網站也會向瀏覽器申請永久保存（`navigator.storage.persist()`），設定頁「Backup」會顯示目前狀態
- 跨裝置同步（`sync.js`）：設定頁「Sync across devices」貼一個只有 gist 權限的 GitHub token，卡片、練習紀錄、刪除紀錄和 AI 選擇（不含 key）會存在你帳號下的 secret gist（檔名 `english-desk-sync.json`）。打開網站時拉下來用 `mergeData()` 合併，存檔後約 4 秒推上去；每台裝置會自動找到同一個 gist。API key、token 和私人字典不會上傳
- 離線：`sw.js` 只處理同網域的 GET。網頁和 `news.json`／`podcasts.json` 先用網路（4 秒沒回應就用存的），帶 `?v=` 的 js、`dict/`、圖示先用快取。AI、GitHub 等其他網域的請求不經過它
- 快取版本號：`index.html` 裡每個 `?v=` 是該 js 檔內容的 hash，由 `.github/workflows/cache-version.yml` 在每次 push 到 main 後自動更新（`scripts/bump-versions.mjs`），不用手動改
- 卡片用 Anki 的 SM-2 間隔複習（Again / Hard / Good / Easy，按鈕上顯示下次間隔），可以匯出成 Anki 能匯入的 CSV（正面、背面、標籤三欄）

## 練習紀錄（History）

- 每次口說和寫作都完整保存：口說存逐字稿、總評、CEFR、5 個修正（含原因）、即時或貼稿、幾點開始、聊幾分鐘（貼稿可選填）；寫作存原文、等級理由、修正、習慣、C1 範本、關範本後的重寫，以及打字時間（只算 90 秒內有打字的時間）。
- 寫作一拿到批改就存；同一篇改了再批改會更新同一筆，按 Done 再把重寫加進去。
- 完整內容在 `practice.js`（IndexedDB `englishDesk.practice`，以 `ts` 為鍵），localStorage 的 `logs` 照舊當摘要索引（首頁長條圖、每月同題重做）。只存文字，不存錄音。
- History 分頁（`history.js`）：按月份列出、Speak/Write 篩選、搜尋、每月最常見等級；點一筆看全部；同一題可並排比較（`#history/compare/<ts>`）。
- 刪除一筆記成 `deleted["log:" + ts]`，同步和匯入都會跟著刪。
- 同步：gist 裡每月一個檔 `english-desk-practice-YYYY-MM.json`，只上傳有變的月份；備份匯出也包含 `practice`。

## 每日新聞題目

- `.github/workflows/news.yml` 每天台灣時間 05:30 跑 `scripts/fetch-news.mjs`，把 BBC（Business／Technology／World）和 CNN 的 RSS 整理成 `news.json` 並 commit 回 main。也可以在 Actions 分頁按「Run workflow」手動更新。
- CNN 的 RSS 很多已經停更。腳本會檢查：最新一則超過 3 天、或三個分類有兩個抓不到，就自動改抓 NPR。
- 挑「重要」的新聞，不是最新的：同時出現在該來源首頁頭條（BBC 首頁、CNN 頭條、NPR Home Page Top Stories）的排最前面；其餘照 RSS 的編輯排序；只收 48 小時內的（每類不到 3 則才放寬）；略過直播、影片和音檔頁。每個來源每類取 6 則。
- 只存標題、一句摘要、連結，不存全文。
- 「今天」分頁顯示今日新聞；口說和寫作的題目改用新聞標題（仍可自己輸入），AI 會拿到該則的標題和摘要當背景。`news.json` 不存在時改用預設題目。
- 口說有兩種方式：「語音對話」用 Gemini Live API（預設 `gemini-3.8-live`，可在設定改）直接在瀏覽器說話，聊完自動用逐字稿評 CEFR、挑 5 個重點；「貼稿評分」把在 Gemini App 等處聊完的逐字稿貼進來評分，Gemini 和 Claude 都能用。語音對話只支援 Gemini，需要允許麥克風（iPhone 用 Safari，iOS 14.5 以上）。

## 跟讀

- 「跟讀」分頁：貼 podcast 音檔的直接連結或上傳音檔，選 1–3 分鐘，Gemini 轉成帶時間的逐句稿（同一段會存在瀏覽器裡，不會重複花用量）。逐句播放、循環、0.8 倍速，按住按鈕錄音，放開後可以聽自己的、或原音接自己的。
- 發音評分：設定填 Azure Speech key 和地區就用 Azure 發音評估（總分、準確度、流暢度、完整度、韻律，加上每個字的分數）；沒填就讓 Gemini 比較原音和你的錄音給建議。
- 有些 podcast 網站不讓別的網頁直接讀音檔，這時先下載再上傳。保留「打開 Enjoy」。按「完成這次跟讀」會記入本週進度。

## 每月同題重做

- 「今天」分頁會列出上個月練過的口說、寫作題目（各最多 2 題），按「重做這題」就用同一題再練一次。每月 1 日這張卡會移到最上面。
- 做完後在結果下方並排對照：上個月和這次的 CEFR 等級、評語（寫作會放兩版原文），AI 也會說哪裡進步、哪個問題還在。
- 從這版開始，紀錄會多存寫作原文和口說的評語、5 個重點，才有東西可以對照；更早的紀錄只能比等級。

## 跟讀節目清單

- 同一個 Action 也會跑 `scripts/fetch-podcasts.mjs`，抓 BBC World Service《Business Daily》和 NPR《The Indicator from Planet Money》最新幾集，寫成 `podcasts.json`（只有標題、日期、長度和 mp3 連結，不存音檔）。
- 腳本會檢查瀏覽器能不能從別的網站讀這個 mp3（CORS）。可以的話跟讀分頁顯示「用這集」直接載入；不行就只給「下載這集」，下載後再上傳。結果寫在 Action log 裡。

## 新聞閱讀器與查字典

- 「今天」的新聞按「閱讀全文」：瀏覽器當場透過 r.jina.ai 取得原文 HTML，自己挑出內文（BBC／NPR／CNN 用網站規則，其他用 Mozilla Readability，最後才用 jina 的 markdown）並重新排版，全文不存進這個 repo。抓不到時可以貼上文章。
- 點任何字先查「設定 → 字典與考試單字」匯入的個人字典（存在瀏覽器 IndexedDB，不上傳），再查內建字典 `dict/`（ECDICT＋自己的筆記，見 dict/README.md），都沒有才用 Free Dictionary。
- 「加入單字本」會存成卡片（kind: word）。卡片正面是你讀到這個字的新聞原句（字會標出來），同一個字在別篇再加一次，就多收一句（最多 5 句，複習時輪流出現）。「Real voice」只播聲音：從 Tatoeba（開放授權的真人錄音句子）找一句含這個字的句子播放，顯示錄音者和授權。「Video clip」用 YouGlish 官方嵌入元件播 YouTube 片段，播完含這個字的那句就暫停（YouTube 規定不能隱藏播放器，所以影片會顯示）。都是點了才載入，不下載也不儲存。
- 托福／雅思／GRE 單字畫底線：實線托福、虛線雅思、波浪線 GRE。預設用內建的個人總表（dict/_exam.json）；匯入總表 CSV（word,TOEFL,IELTS,GRE）後改用自己的清單。
- 個人字典（商業字典內容）和清單不放進 repo。重建內建字典：`python3 scripts/build-dict.py ecdict.csv [個人 MDX 匯出的 txt]`，只會取出「我的筆記」。
