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
- [terrain] **Phase 2A 完了**: src/world/terrain.ts(自作 mulberry32+2D Perlin fBm、バイオーム・鉱石・樹木・水・砂漠・山岳・砂浜)、test/terrain.test.ts(17テスト)。全73テスト合格、ビルド合格
- [modes] **Phase 2B 完了**: サバイバル/クリエイティブモード、インベントリ(36スロット)、硬度採掘+ドロップ、落下/void/溺水ダメージ・空腹・HP回復、ホットバー/心・空腹バー/F3/インベントリUI、WebAudio効果音、test/inventory.test.ts(19)+test/modes.test.ts(28)。全120テスト合格、ビルド合格

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

## Phase 2A 実装メモ (terrain モジュール)

### 統合方法(main.ts 側の変更は1行)
```ts
import { createTerrainGenerator } from './world/terrain';
// src/game.ts:111 の
this.world = new World(seed);
// を
this.world = new World(seed, createTerrainGenerator(seed));
```
- **正確なエクスポート**: `createTerrainGenerator(seed: number): ChunkGenerator`(`src/world/terrain.ts`)。`ChunkGenerator = (world, chunk, cx, cz) => void`(world.ts と同一シグネチャ)。
- 補助エクスポート(テスト用): `sampleColumn(seed, wx, wz): { height, biome, surface, sub, underwater }`、`columnProfile(...)`(同一)、`TERRAIN_SEA_LEVEL = 60`、`mulberry32(seed)`, `fbm2(x, z, perm, octaves)`。
- 決定論: 全ブロックは (seed, worldX, worldY, worldZ) の純関数。チャンクは自己完結(他チャンクへの書き込みなし)→ 生成順非依存(テスト済み)。

### 採用パラメータ(1.13風)
- 高さ: ベース64、fBm(4オクターブ、周波数1/96)±26、山脈帯は2番目のfBm(1/160, 3オクターブ)の smoothstep(0.15→0.55) × (80+60×detail) → 峰≈y198(上限250クランプ)。海面60。
- バイオーム: 温度/湿度fBm(1/192, 3オクターブ各)。山岳=山脈因子>0.45(石表面、y≥190で雪)、砂漠=温度>0.62かつ湿度<0.42(砂)、森=湿度>0.55かつ温度<0.68(草+木密度0.08)、それ以外=平野(草、木0.004)。浜=海面+2まで/水深1-3は砂。
- 地下: 表面下3層=土(砂漠/海/浜は砂、山岳は石)、その下は石、y=0は必ず bedrock、y1-3は30% bedrock、砂利パッチ(周波数1/64ノイズ>0.72で8%)。
- 鉱石(ランダムウォーク blob、石のみ置換): 石炭 y8-128 p=0.01 サイズ4-9 / 鉄 y8-64 p=0.004 サイズ3-8 / レッドストーン y0-16 p=0.003 サイズ2-7。**重要**: blob は各目標列の表面バンド(y ≤ h-3)を超えないようガード(隣接の高列の表面を壊さない)。
- 木: 幹4-6、葉5×5×2+3×3、trunk を lx,lz∈[2,13] に限定してチャンク内完結。
- 性能: チャンク生成 実測≈3-5ms、全256チャンク≈0.8s(要件<50ms/<10s を大幅満たす)。

### 設計書との乖離(報告済み)
- flower ブロックが blocks.ts に存在しない → 平野の花は実装せず(既存idのみ使用、id追加禁止の制約のため)。
- 設計書§6の「山岳:雪」は y≥190 の雪帽で対応(Snow id=14 使用)。
- clay は海床に未使用(タスク指示の「sandy seafloor」に準拠)。

### 既知のギャップ(Phase 1 スコープ外)
- 木はチャンク境界をまたがない(プレースホルダ生成器)。
- ドアは solid=false(簡易化)。ガラスのドロップなし(drop=0)。
- 水没・落下ダメージ、インベントリ、飛行は未実装(2B)。
- スクリーンショットの自動検証はサンドボックス制約により未実行(スクリプトは完成済み)。

## Phase 2B 実装メモ (modes モジュール)

### 新規ファイル(すべて [modes] 所有)
```
src/player/inventory.ts  Inventory(36スロット=9ホットバー+27メイン、スタック上限64)
                         addItem(既存スタック優先→先頭空き)/removeItem/moveBetweenSlots(移動・スワップ・マージ)/
                         shiftMove(ホットバー<->メイン、同种マージ)/countItem/firstEmpty/isFull
src/player/damage.ts     定数(TPS=20, MAX_HP=20, MAX_HUNGER=20, MAX_AIR_TICKS=300=15s)
                         fallDamage(d)= d<=5?0:floor(d-3)(1.13式)
                         Vitals{hp,hunger,air} / tickVitals(v,env,dt)->bool(死亡フラグ)
                         void: y<-10で4HP/tick / 溺水: 頭が水没でair-1/tick、air<=0で1HP/s
                         空腹: 0.125/s減少+ジャンプ1回0.1 / 空腹0→HP-0.25/s / 空腹>=18→HP+0.25/s
                         FallTracker(ピークY追跡、land()で落下距離)
src/player/modes.ts      GameMode型 / ModeManager(mode, fly、toggleMode= F、creative→survivalでfly強制OFF)
                         DoublePressTracker(300ms窓、ダブルSpaceで飛行切替)
                         FLY_SPEED=8, FLY_SMOOTH=8
                         fillCreativeInventory(inv): 入手未の置ける全ブロック(id 1..36=36種)を64スタックずつ補充
src/audio/sfx.ts         Sfx: WebAudioオシレーターのみ(break/place/hit/eat/mode)。
                         AudioContextは初回ユーザー操作で遅延生成(ensure())、非ブラウザではno-op
src/ui/icons.ts          テクスチャアトラス(canvas 256x256、renderer.tsと同じタイル描画コードのコピー。
                         src/engine/*はcore所有で編集不可のため複製。Phase 3で共通化可)
                         drawItemIcon(ブロック=アトラス側面タイル、食料/ツール=手続き描画)
                         injectStyle(id,css) — index.html(core所有)を触らずCSSを注入するヘルパ
src/ui/hotbar.ts         Hotbar(9スロット、選択ハイライト、個数表示、クリック=インベントリ画面開時のみ)
                         StatusBars(心10+ドラムスティック10、canvas 2D、サバイバルのみ表示)
                         MineBar(クロスヘア下の採掘進捗バー)
src/ui/inventoryUI.ts    Eで9×4グリッド(メイン27スロット)をホットバー上に開く。
                         クリック=ピック/ターゲットで移動・スワップ・マージ、Shiftクリック=shift-move。
                         E/Escで閉じる(ポインタロックの解放/再取得はgame.ts側)
src/ui/debug.ts          F3パネル(pos/facing/chunk/fps/mode/seed)。facingName(yaw)ヘルパ
test/inventory.test.ts   19テスト(スタッキング・64上限・移動/スワップ/マージ・shift-move・count)
test/modes.test.ts       28テスト(落下ダメージ式・FallTracker・void・溺水・空腹/回復・モードフラグ・
                         ダブルプレス・creative事前補充・sfxの非ブラウザ安全)
```

### game.ts 統合ポイント(Phase 2C/3 必須読込)
Phase 2B が game.ts に追加/変更した箇所(所有権: ブロック破壊パス+エンティティティックのみ):
1. **`Game.tick()`** — stepPlayerの前にcreative飛行の事前補償
   (`p.vy = flyVel + GRAVITY*TICK_DT`、stepPlayer内の重力で相殺→実効vy=flyVel)、
   stepPlayerの後に `p.vy = flyVel` で正規化。stepPlayer本体は未変更。
2. **`Game.tickEntity(jumpHeld, wasOnGround)`(新規・20TPS)** — tick()内でtickRedstone()の前に呼び出し。
   落下ダメージ(FallTracker+fallDamage、creative無効)、void/溺水/空腹/回復(tickVitals)、
   死亡時 `respawn()`(スポーン復帰+Vitalsリセット、インベントリ保持)。
3. **`Game.tickMining(dt)`(新規・毎フレーム)** — 左ボタン長押し+ターゲット固定で
   `progress += dt*toolSpeed/hardness`、1.0でbreakBlock。creativeは進捗なし(即壊)。
   左ボタン状態は Input(編集不可)にheld APIが無いため Game 自身の
   window mousedown/mouseup リスナー(`onMouseDownExtra`/`onMouseUpExtra`)で管理。
4. **`Game.breakBlock(x,y,z,id)`(新規)** — setBlock(AIR)+`def.drop`を inventory.addItem+SFX。
5. **`Game.onLeftClick()`** — creative即壊のみ。survivalはtickMiningに委譲。
6. **`Game.onRightClick()`** — 右クリックのディスパッチを frame() 側に集約:
   タヒット→placeTarget()(SFXは前後のブロック比較で判定)、未ヒット→`tryEat()`。
   **`placeTarget()` 本体は未変更**(Phase 2C がインタラクト拡張する想定)——
   ただしアイテム源を Phase 1 の `this.slots` スタブから `this.inventory` に置換し、
   creativeでは removeItem をスキップ(無限アイテム)。
7. **`Game.tryEat()`(新規・公開)** — サバイバル+食料選択+レイキャスト未命中で
   1個消費し hunger+=foodValue(bread+5, apple+4)、上限20。
8. **`Game.toggleMode()`** — ModeManager委譲+creative初回(毎回)でfillCreativeInventory+SFX。
   `Game.mode` はゲッタ(ModeManagerへ委譲)。Phase 1 の `Game.slots` プロパティは削除
   (既存テスト/コードからの参照なし、確認済み)。
9. **`Game.toggleInventoryUI()`/`openInventoryUI()`/`closeInventoryUI()`/`onSlotClick()`** —
   E/EscでUI開閉+pointer lock 解放/再取得、スロットクリックのピック&ドロップ+shift-move。
10. **UI構築** — constructor で Hotbar/StatusBars/InventoryUI/DebugPanel/MineBar を
    `#hud` 配下へ生成。F3は Input.onF3 で debug.setVisible、1-9/ホイールは
    Input.onSlot/onScroll で selectSlot(既存フック流用)。
11. **`Game.dispose()`** — 追加リスナー4件のremoveEventListenerを追加。
12. `tickRedstone()` スタブは未変更(Phase 2C がそのまま埋める想定)。
    start()/raycast()/setBlock()/hudText() 等は既存のままで互換保持
    (`Game.mode` ゲッタ+`selectedSlot`+`inventory.get(slot)` で新API)。

### スタートキット(サバイバル開始時)
ホットバー: stone32/dirt32/grass16/sand16/log16/planks32/glass16/cobblestone32/torch16、
メイン: bread4/apple2/stone_pickaxe1。

### 設計判断・乖離
1. **採掘速度**: 選択中アイテムがツールなら `tool.speed` 倍(pickaxe 4x等)。
   ツール種別×ブロック適合のマッチングは未実装(簡易化、Phase 3で検討)。
2. **voidダメージ**: 実装済み+テスト済みだが、現在のワールドは y>=0
   (物理が y=0 でクランプ)のため実際に発動する領域は存在しない(仕様準拠の将来対応)。
3. **icons.ts は renderer.ts のアトラス描画コードを複製**している(所有権ルールのため。
   Phase 3 で src/ui/atlas を共用化し両者からimportするようDRY化を推奨)。
4. **creative飛行は水平速度が歩行速度のまま**(physics.tsは編集不可のため。
   垂直のみ ±8 blocks/s、平滑化あり)。
5. **画面検証**: サンドボックスではブラウザ起動不可(指示通りpuppeteer未使用)。
   UIはDOM/canvasロジックのみで単体テスト対象外(純ロジックのみテスト)。
   視覚検証はPhase 3のCPUラスタライザで実施予定。
6. **SFXはユーザー操作で遅延生成**(autoplayポリシー)。最初のクリック/キーで
   ensure()が呼ばれる(game.ts の追加リスナーで担保)。
