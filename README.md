# butterfly

壁にとまる青いモルフォ蝶(Morpho peleides)を three.js の WebGPU で描くデモ。モデルファイルは使わず、形・模様・構造色・毛までコードで作っている。触ると飛び去り、少し違う色と模様になって戻ってくる。

## 動かし方

```bash
npm install
npm run dev
```

WebGPU に対応したブラウザ(Chrome / Edge / Safari 26 以降など)で開く。

## 操作

- 蝶をタップ: 飛び去る
- ドラッグ: 視点を回す / ホイール: 寄る・引く
- Shift + ドラッグ: 太陽の向き

URL パラメータ: `?pose=open|closed`(止まっているときの翅)、`?sun=方位,仰角`(度)、`?wear=0..1`(翅の擦り切れ)、`?slow=0.1`(スローモーション)。

## ファイル

| ファイル | 中身 |
|---|---|
| `main.js` | シーン、壁、光、カメラ操作、飛び方 |
| `butterfly.js` | 蝶の組み立てと翅の動き |
| `wing.js` | 翅の形、翅脈、凹凸 |
| `pattern.js` | 翅の模様のパラメータと描画 |
| `morpho.js` | 青い構造色(鱗粉ごとの干渉反射)のマテリアル |
| `body.js` | 胴体、毛、複眼、触角、脚 |
| `noise.js` | ノイズと乱数 |
| `refs.html` | 見比べ用の参照写真(Unsplash へのリンク。画像は含まない) |

## 素材

背景の HDRI は Poly Haven の [garden_nook](https://polyhaven.com/a/garden_nook)(CC0)を実行時に読み込んでいる。

## ライセンス

MIT
