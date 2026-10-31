# butterfly

three.js(`three/webgpu` と TSL)で青いモルフォ蝶を描く WebGPU デモ。ビルドは Vite。

## コマンド
- `npm run dev`: 開発サーバー
- `npm run build`: ビルド(構文エラーの確認にも使う)

## 公開
https://butterfly.shunyakoide.com 。main に push すると `.github/workflows/ci.yml` がビルドして GitHub Pages に出す(DNS は Cloudflare で DNS only)。

## 構成
README.md の「Files」の表を参照。README は英語が本体で、日本語版は README.ja.md。変えるときは両方そろえる。

## 決まり
- モデルファイルや画像テクスチャは入れない。形・模様・質感はすべてコードで作る(空の光の HDRI の読み込みと、README に載せる描画結果のスクリーンショット `docs/screenshot.jpg` だけは例外)
- 本物らしく作るのは蝶だけ。壁と背景はデジタルな表現だが、光と影(太陽の影、線の光の映り込み)は物理的に正しく保つ
- 長さの単位はメートル。蝶は 1/1.3 の大きさで作り、`butterfly.js` の `SCALE` で実寸にする
- 数値の根拠は、論文・写真の測定・推定(`est.`)のどれなのかをコメントに書く
- 見た目を変えたら、ブラウザで寄り・引き・逆光などを実際に見て確かめる
- 参照写真はリンクだけにして、画像ファイルをリポジトリに入れない

計画・調査メモはこのリポジトリに置かない(作者の手元の別リポジトリで管理している)。
