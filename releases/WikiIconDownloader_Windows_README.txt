Minecraft Wiki ブロック画像・自動ダウンロードツール v1.0
Windows 10 / 11・標準のWindows PowerShell 5.1対応

【使い方】
1. このZIPを「すべて展開」してください。
2. 展開したフォルダの START_DOWNLOAD.cmd をダブルクリックしてください。
3. 完了すると、同じフォルダに Wiki_Block_Icons.zip ができます。
   このZIPをチャットに送ってください。取れた画像だけでも大丈夫です。

Python・追加モジュールのインストールは不要です。
ZIP内を直接開いた状態ではなく、必ず展開してから実行してください。

【何を集めるか】
前回のリストの215種類が対象です。
虫食い・ワックスなど、既存画像を共通で使える84 IDは対象外です。
https://minecraft.wiki/images/Invicon_Deepslate_Brick_Stairs.png
のような規則で、Wikiの小さいインベントリ用PNG画像を取得します。
先行版の項目など、画像が存在しないものは「未取得」として残します。

【保存するもの】
download_result/images/        取得した画像。IDに合わせたファイル名です。
download_result/sources.json   元URL・取得日時・画像サイズ・SHA256。
download_result/download_results.csv   全対象の結果。
download_result/missing.csv    未取得の項目。
download_result/missing.txt    未取得の理由と試した画像URL。
Wiki_Block_Icons.zip           取得画像と上記一覧をまとめた、送信用ZIP。

画像はリサイズや加工をせず、取得したPNGのまま保存します。
PNGの形式・サイズ・末尾までのデータを検査し、HTMLページを画像として保存しません。
そのブロックの見た目に合っているかは、取得後の一覧で確認が必要です。
通常は約0.4秒以上の間隔を空けて、1件ずつ取得します。所要時間は接続や未取得件数によります。

【途中からの再開】
START_DOWNLOAD.cmd をもう一度実行してください。
元URLと保存済み画像のSHA256が一致する画像は、そのまま使います。
画像が壊れているもの、まだ取れていないもの、指定URLを変更したものを取得し直します。
同じ保存先の結果一覧と送信用ZIPは、今回の結果で更新します。

【画像名が例外だった場合】
石の階段と丸石の階段など、統合版IDとWikiの英語名の違いには対応しています。
それでも取れない場合は、ブラウザーで対象の画像を開いてURLをコピーし、
custom_urls.json に次のように登録してから、もう一度実行してください。

{
  "minecraft:deepslate_brick_stairs": "https://minecraft.wiki/images/Invicon_Deepslate_Brick_Stairs.png?a6689"
}

2件入れたサンプルは custom_urls.example.json にあります。
実際に使うファイル名は custom_urls.json です。
URLの ? 以降が付いていても、そのまま指定できます。

【取得できない場合】
403・認証画面・HTMLの確認画面などが返る場合は、追加アクセスを止めて理由を記録します。
接続に失敗し続ける場合も止めます。残りは not_attempted（未試行）です。
画像名が見つからない missing と、接続を拒否された blocked は区別します。
403は、画像が存在しないという意味ではありません。

この開発環境からWikiへの接続は拒否されるため、実サイトからの一括取得は未確認です。
ローカルのHTTPサーバーとPowerShell 7で、取得・欠落・接続拒否・再開・PNG検査・ZIP作成を検証しました。
Windows PowerShell 5.1向けの構文／APIを使用していますが、Windows実機での起動は未確認です。
PCからも拒否される場合、画像URLをブラウザーで開けるかと、missing.txtを確認してください。
ブラウザーのログイン情報やCookieは収集しません。

【画像の出典】
Minecraft Wiki: https://minecraft.wiki/
取得した画像それぞれの元URLは sources.json に残します。
元画像のライセンス表示はWikiの各ファイルページを参照してください。
https://minecraft.wiki/w/Minecraft_Wiki:Copyrights

【個別に実行する場合（任意）】
PowerShellでフォルダを開き、1種類だけ取得する例:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Download-WikiIcons.ps1 -OnlyId minecraft:deepslate_brick_stairs

終了コード: 0=選択分を取得済み、2=未取得あり、1=ツール設定などのエラー。
