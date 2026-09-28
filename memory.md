# WebCraft — サブエージェント向け作業メモ

## 前提
- プロジェクト: C:\Users\user\IdeaProjects\webCraft (WebCraft)
- 設計書: docs/design.md を必ず最初に読む
- スタック: TypeScript + Vite + Three.js + Vitest。外部アセットなし(テクスチャはCanvas生成)
- 環境: Windows、Node 24、npm 11、git 2.39。コマンドはタイムアウトを設定すること

## 作業ルール
1. 設計書の §3「ファイル所有権」を厳守。他モジュール担当のファイルは編集しない(変更が必要なら報告)
2. 全ブロック・アイテム定義は Phase 1 の core が src/world/blocks.ts に完成させる。追加が必要なら報告
3. レッドストーンは Java 1.13 仕様に従う(§8)。20TPS同期ティックで処理、非同期禁止
4. テスト(Vitest)はブラウザ不要の純ロジックとして書く。`npm test` で合格必須
5. UI変更時はスクリーンショットで確認する
6. 進捗と重要判断は本ファイルに追記すること

## 進捗ログ
- [core] 設計書・リポジトリ初期化(コーディネータ)
- [core] **Phase 1 完了**: スキャフォールド、blocks.ts(全ブロック/アイテム)、chunk/world(注入可能生成器)、mesher、プレイヤー物理、エンジン(renderer/loop/input)、HUD、game.ts、Vitest 56テスト合格、ビルド合格

## Phase 1 実装メモ (Phase 2 チーム必読)

### ファイル構成(実際に作成した [core] ファイル)
```
package.json / vite.config.mjs / tsconfig.json / index.html / screenshot.ts
src/main.ts        エントリ(window.__WECRAFT_READY__ を第一描画後に設定)
src/game.ts        Game オーケストレータ + DDAレイキャスト(reach 6)
src/engine/        renderer.ts(three.js唯一のimport元) / loop.ts(20TPS) / input.ts
src/world/         blocks.ts / chunk.ts / world.ts / mesher.ts
src/player/        player.ts / physics.ts
src/ui/hud.ts      クロスヘア+左上テキスト
test/              chunk / world / blocks / mesher / physics / integration (計56)
```

### 重要な判断・乖離(設計書との差異)
1. **ワールドサイズの乖離(要確認)**: 設計書§5/§11の「16×16チャンク世界(4096×4096ブロック)」は矛盾している。16ブロック幅チャンク(§5固定)×16×16チャンク = **256×256ブロック**である。4096×4096ブロックは 256×256=65536チャンク(ブロックデータ約8GB)が必要でブラウザ上は非現実的。Phase 1 は **16×16チャンク(256チャンク、x,z∈[-128,127]、中心スポーン)** を実装。Phase 3 で仕様を確定すること。
2. **vite.config.mjs**(.tsではない): 開発サンドボックスがTS設定ファイルのサブプロセスバンドルをブロックするため(spawn EPERM)。依存関係のないプレーンESM JSを維持すること。
3. **Vitest pool: 'threads'**: 既定の 'forks' は子プロセスspawnを使用しサンドボックスでEPERM。configの test.pool を維持。
4. **npm**: サンドボックス内では `npm ... --cache .npm-cache`(ワークスローカルキャッシュ)を使うこと(ユーザーAppDataへの書き込みはブロックされる)。
5. **スクリーンショット**: `npm run screenshot` は Vite dev を起動し headless Chrome(puppeteer-core)で screenshots/phase1.png を撮影する。Chrome のspawnがサンドボックスでブロックされるため、**サンドボックス外(通常ターミナル)で実行する**。

### Phase 2 向け拡張ポイント
- **2A terrain**: `World` の第2引数に `ChunkGenerator(world, chunk, cx, cz)` を注入(現在 `generateSimpleTerrain` プレースホルダ、world.ts 内。値ノイズ高度ベース64/海面60/砂/水/チャンク内限定の木)。`src/world/terrain.ts` で置き換える。`chunk.minY/maxY` でメッシュ高速化済み(setBlock で自動更新)。
- **2B modes**: `game.slots`(9項目の簡易ホットバー)と `Game.selectedSlot` を inventory.ts / hotbar.ts で置き換え。`Player` は feet-center 座標、AABB 0.6×1.8、eye 1.62。破壊は現状即時(硬度タイミング未実装: `blocks.ts` の hardness を使用)。`Game.mode` は survival/creative フラグのみ。
- **2C redstone**: `Game.tickRedstone()` が 20TPS フック(現在スタブ)。metaバイトのビット配置とヘルパーは `blocks.ts` 冒頭コメント参照(facing bits0-1 / on bit0 / strength bits0-3 / delay bits2-3 / mode bit2 / output bits3-6 / door bit2)。`World.getBlock/setBlock/getMeta`、`world.markDirty(cx,cz,includeNeighbors)` でブロック変更+再メッシュ。
- **mesher**: `buildChunkMeshData(chunk, cx, cz, blockAt)` は純TS。`blockAt` はワールド座標ルックアップ(チャンク跨ぎ対応)。opaque/water を分離。形状ボックスは `blocks.ts` の `SHAPE_BOXES`(full/slab/half/dust/torch/hook)。点灯系は `litTiles`+`isPowered(meta)`。
- **座標系**: ワールド座標は中心基準(x,z∈[-128,127]、y∈[0,255])。チャンク cx,cz∈[-8,7]、ブロック x = cx*16+localX。チャンクキー = (cx+8)*16+(cz+8)。

### 既知のギャップ(Phase 1 スコープ外)
- 木はチャンク境界をまたがない(プレースホルダ生成器)。
- ドアは solid=false(簡易化)。ガラスのドロップなし(drop=0)。
- 水没・落下ダメージ、インベントリ、飛行は未実装(2B)。
- スクリーンショットの自動検証はサンドボックス制約により未実行(スクリプトは完成済み)。
