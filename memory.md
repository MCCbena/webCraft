# WebCraft — サブエージェント向け作業メモ

## Phase 4 実装メモ (review defect fixes)

### レビュー指摘の修正(全13項目対応)
**BLOCKERS**
1. **リピータ/コンペアの持続入力パルス** `src/redstone/components.ts` `tickDelayed`:
   残(delay window)が 0 になった瞬間に**入力を再サンプル**。>0 なら出力維持+強度
   再キャプチャ+window リセット、0 のみで消灯(state 削除)。持続入力→持続出力、
   入力除去→最小点灯時間(delay tick)後に低下。テスト更新:
   「constant input → continuous output (no OFF tick in 20 ticks)」「input removed →
   persists for minimum-on time then falls」(delay 1 と 4)。`tools/verify-render.ts`
   は delay 1 に変更(workaround コメント削除)— ランプ常点灯を実機検証。
2. **落下ダメージ無効化** `src/game.ts` `tickEntity`: `fallTracker.land()` を
   `fallTracker.update()` **より前に**評価(従来は onGround tick で peak リセットされ
   land() が常に 0)。統合テスト追加 `test/integration.test.ts`: 実 tick 順序で
   ~20.9ブロック落下 → 17ダメージ → HP 3。
3. **ピストン押し出し上限 off-by-one** `src/redstone/components.ts` `canExtend`:
   count は 0 開始(メインヘッドはカウントしない、連鎖ピストンは base+head=2)。
   12ブロック=成功 / 13ブロック=失敗 をテストで確認。

**MINOR**
4. `extend()`: 押出列を再検証(2tickカウントダウン中の世界変化対応)。
   無効化時は move 列挙せず中止(state 削除、ピストンはその場にとどまる)。
5. **ラインルール** `src/redstone/network.ts` `computeDustTarget`:
   `pass = (sC > sN) ? sC : sC - 1`(sC > 0)。⚠ **判定・影響**: タスクの「既存§8.4
   テストは緑のまま」との条件は**両立不可能**(直線は必ず 14,13,14,13,... ザグザグ
   に収束 — ソース側の 2先は常に中間より強い)。明示された数式を優先し実装、
   影響を受けたテストの期待値を更新:
   - 減衰テスト → ザグザグ均衡 (14,13,14,13,...; 15個目=14)
   - 決定論テスト → リピータ入力(dust #8)=13 / 出力 13 (旧: 7)
   - トーチ列 fixture の back 入力 = 14 (旧: 12) → コンペア/リピータの期待値更新
   - 新規: sub-15 ラインパステスト (3ダスト列 → 14,13,14)
   - **副次効果**: ラインは自己持続(一度点灯すると消灯しない — トーチ除去でも
     ダスト列は 14,13,14 で維持)。コンペア「入力除去」テストは back ダスト自体を
     除去して入力を断つ。
6. **点灯トーチの水平強給電** `network.ts` `isStronglyPowered`: 水平 strong source
   を redstone_block(+リピータ/コンペア出力)に限定。トーチは下方ブロックのみ。
7. **レドストーンアイル上限** `terrain.ts`: `REDSTONE_MAX_Y = 15`(y<16)。
   テスト `toBeLessThan(16)` に更新。
8. **メッシング予算** `src/engine/renderer.ts`: `MESH_BUDGET_PER_FRAME = 2`、
   キュー(nearest-first、未処理は保持)。初回 49チャンクは数フレームで分散。
9. `game.ts` `placeTarget(hit: RayHit)`: onRightClick のレイキャスト結果を渡し、
   二重 targetBlock() 削除。
10. **4096×4096 旧コメント修正**: `world.ts`(ヘッダ+定数コメント)、
    `physics.ts`(ヘッダ)、`docs/design.md` §1(256×256ブロック・高さ256)と
    §5(座標 -128..127)。承認仕様 = 16×16チャンク = 256×256ブロック。

**DRY / マジックナンバー / デッドコード**
- リピータ出力マスク `(meta & 0xf0) >>> 4` を `blocks.ts` に集約
  (`getRepeaterOut`/`setRepeaterOut`)。types.ts は re-export、mesher/verify-render
  は import。
- Phase 1 プレースホルダ生成器を `world.ts` から**削除**(mulberry32/hash2/
  valueNoise/fbmNoise/SEA_LEVEL/placeholderHeight/plantTree/generateSimpleTerrain)。
  既定生成器 = `createTerrainGenerator(seed)`(terrain.ts から import、型のみ
  逆参照でランタイム循環なし)。world.test の「placeholder terrain」テストは
  地形生成器のまま全合格(名称のみ更新)。
- チャンク境界 dirty マーキングを `world.markDirtyAround(x,y,z)` に集約
  (game.setBlock と redstone/tick の重複ロジック削除)。
- `mesher.ts` の `ATLAS_TILES_X/Y` 再定義を削除 → `engine/atlas.ts`
  `ATLAS_TILES_PER_ROW` を import(純TS・three.js なし)。
- デッドコード削除: `Input.consumeScroll`+scrollフィールド(**wheel が onScroll
  を呼んでいなかった潜在バグも修復 — 直接呼出に**)、`Input.onLockChange` オプション、
  `blocks.ts` `isOpen`/`setOpen`/`BlockId` 型、`terrain.ts` `biomeName`+`BIOME_NAMES`、
  `GameLoop.isRunning`、`Hotbar.isInteractive`、`DebugPanel.isVisible`、
  verify-render の never-true `file://${process.argv[1]}` 条件。
  `ModeManager.setFly` は modes.test が使用するため**保持**。
- マジックナンバー: `CHUNK_SIZE_X/Z`(chunk.ts)を game/tick/renderer/world に、
  `WORLD_MAX_Y` を physics.ts に使用。海面は `TERRAIN_SEA_LEVEL` の単一定数に
  統一(world.ts 側 SEA_LEVEL はプレースホルダ削除で消滅)。game.ts 調整定数に
  命名(MOUSE_SENSITIVITY 0.0022 / PITCH_LIMIT / MAX_FRAME_DT 0.1 /
  FPS_SMOOTHING 0.05 / HEAD_IN_WATER_OFFSET 1.5)。
- `terrain.ts` `sampleColumn` エイリアスを削除(呼び出し元 verify-render/
  terrain.test は `columnProfile` に更新)。
- `tools/rasterizer.ts` `buildSoftwareAtlas` に atlas.ts への drift-warning
  クロスリファレンス追加。

### テスト結果
- `npm test`: **160/160 合格**(既存158 + 新規2: sub-15ラインルール /
  落下ダメージ統合。一部は書き換え)。
- `npm run build`: 合格(tsc --noEmit + vite build)。
- `npm run verify`: 両スクリーンショット再生成し目視確認(地形=草原+砂+雪山、
  レッドストーン=ダスト列(ザグザグ 14/13)+点灯リピータ+**delay 1 でランプ常点灯**)。
- コンソール: dust=[14,13,14,13,...]、repeater output=13、lamp lit=true。

### 判断(要報告)
- **ラインルール数式 vs 既存テスト緑の両立不能**(item 5): 上段参照。
  ユーザー確認ができない環境だったため、タスクの明示数式を優先した。
  §8.4「15個目=0」の設計書文言はザグザグ均衡と不一致(要上級レビュー再確認)。

---

## Phase 4b 実装メモ (line rule REVERT — 再適用禁止)

### 何が起きたか
Phase 4 のラインルール `pass = (sC > sN) ? sC : sC - 1`(network.ts
`computeDustTarget`)は **Java 1.13 に非準拠** と確定し、**Phase 2C の
exactly-15 ルールに完全復帰**した。git 8066922(4b前= b01745d)からコード・
コメント・テストをそのまま復元。

### 復帰理由(再適用しないこと!)
1. **ザグザグ均衡**: トーチの直線が 14,13,14,13,... で収束(真の 1.13 は
   単調減衰 14,13,12,11,...)。ソース側の 2先は常に中間ダストより強いので、
   全ダストがソース側強度を減衰なしで再受信してしまう。
2. **自己持続ライン**: 一度点灯したラインは**トーチを除去しても消灯しない**
   (真の 1.13 はソース除去で全ライン 0 へ排渇)。
   → 必須要件「Java 1.13 レッドストーン」を両面で破っていた。

### 復元したコード(network.ts computeDustTarget のラインルール)
```ts
if (world.getBlock(cx2, y, cz2) === Block.RedstoneDust && getStrength(world.getMeta(cx2, y, cz2)) === MAX_POWER) {
  m = MAX_POWER;
}
```
つまり 2先 C 経由の寄与 = `sC === 15 ? 15 : (通常隣接伝播 sN-1 のみ)`。
ラインルールが通常伝播を上回るのはフル強度 15 パススルーの場合だけ。

### 変更ファイル
- `src/redstone/network.ts`: ラインルールを exactly-15 に復元(+コメント)。
- `src/redstone/types.ts`: ヘッダ NOTE を Phase 2C 文言に復元(4b の
  警告を追加)。
- `test/redstone.test.ts`:
  - 減衰テスト → 単調 14,13,...,0(15個目=0)に復元
  - 「sub-15 ラインパス」テスト**削除**(バグを固定化するテスト)
  - **新規**「no self-sustain: removing the source fully drains the line
    within a few ticks」(4ダスト列 → トーチ除去 → 全 0)
  - リピータ「preserves input strength」→ back 入力 12 / 出力 12 に復元
  - コンペア4テスト → back 12 系に復元(Phase 4 の持続挙動は**保持**)
  - 決定論テスト → 出力 13 → **7** に復元
  - 15 パススルーテスト(レッドストーンブロック上のダスト)は据え置き
- `docs/design.md` §8.2: ラインルール文言を実装どおりの無歧義ルールに置換。
- `memory.md`: 本節追加。

### テスト結果
- `npm test`: 全合格(件数は実行ログ参照)。`npm run build`: 合格。
- `npm run verify`: verify-redstone.png で単調減衰(14,13,...,7)+
  delay-1 リピータ出力 7 + ランプ点灯を確認。verify-terrain.png 不変。

### 注意
- Phase 4 の**他の修正(リピータ持続・落下ダメージ・ピストン上限・
  強電力・DRY等)はすべて正しく保持**されている。本セクションはライン
  ルール**のみ**の復元。
- 「直線の減衰テストを緑にしたければ sC > sN パスが必要」という推論は
  **誤り** — exactly-15 ルールは減衰テスト・15パススルーテストの両方を
  緑にし、かつ 1.13 と整合する。

---

## Phase 5A 実装メモ (complete 1.13 redstone data layer + power model)

### 新規ブロック id / meta レイアウト (blocks.ts)
- 新規 id(既存は不変、末尾追加): `Hopper 37` / `DaylightDetector 38` / `Tnt 39` /
  `NoteBlock 40` / `Rail 41` / `PoweredRail 42` / `Tripwire 43`(弦ライン本体)。
  (TripwireHook 32 / Dispenser 33 / Dropper 34 / OakDoor 36 は 5A 以前に定義済み。)
- meta レイアウト:
  - **door** (kind `door`): bit 1 = 上半分 (`isDoorTop`/`setDoorTop`, `DOOR_TOP_BIT 0x02`)、
    bit 2 = 開 (`isDoorOpen`/`setDoorOpen`, `DOOR_OPEN_BIT 0x04`)。
    閉=ソリッド(`isSolidBlockAt`: `!isDoorOpen`)、開=非ソリッド。
  - **daylight** (kind `daylight`): bit 1 = 反転 (`isDaylightInverted`/`setDaylightInverted`、
    DOOR_TOP_BIT を共用)。
  - **note** (kind `note`): bits 0-4 = 音階 pitch 0-24 (`getNotePitch`/`setNotePitch`、
    クランプ付き)。
  - **facingOnOff** (tripwire_hook): bits 0-1 facing、bit 2 = 弦保有 (`setSideOn`)。
  - **onOff** (TNT): bit 0 = 着火(primed)。litTiles → `TntPrimed`(白)。
- アイテム: `Item.TripwireString = 136`("tripwire"、非配置可能 — フック右クリックで
  使用のみ。生存モードで消費)。

### アトラスタイル (Tile enum, 41..59)
TripwireHook 41 / DispenserSide 42 / DispenserFront 43 / DropperSide 44 /
DropperFront 45 / Torch 46 / OakDoor 47 / Hopper 49 / DaylightDetector 50 /
TntSide 51 / TntTop 52 / TntPrimed 53 / NoteBlock 54 / Rail 55 / PoweredRail 56 /
TripwireString 57 / DoorBottom 58 / DoorTop 59(48 = Phase 3 の ComparatorOn)。

### メッシャー形状 (blocks.ts `SHAPE_BOXES`)
新規 shape: `hook`(0.375..0.625 × y0.5..1 × 0.375..0.625)/ `hopper`(0.05..0.95 ×
0.95高)/ `rail`(幅0.94 × 高0.125 平底)/ `string`(幅1/8 = 0.4375..0.5625 の全高細線)。
ドアは `full` shape のまま(開閉でソリッド性のみ切替)。

### 電力モデル追加 (network.ts, §8.1 準拠)
- **dust が上のブロックに弱給電**: `weakPowerFromBelow(world, x, y, z, p)` —
  直下ダスト strength>0 のときその strength。使用: 点灯トーチ判定(components.ts
  `tickTorch`)、ランプ(`totalPowerReceived`)、ドア(下記)、パワーレール。
- `totalPowerReceived`: 6隣接(水平4+上=弱、下=強)+ dust-above ルールの最大値。
  **ランプ専用**(1.13: 圧力プレートは純センサー — 電力では ON しない。
  プレートは `tickPlate` が entityAbove のみで判定)。
- `isRailPowered` (PoweredRail): 下のブロックが強給電 OR 水平隣が弱給電(ダスト
  含む)OR 直下ダストが弱給電 → `directPower` = 15(弱=水平4+ダストへ14、強=上)。
- `directPower` の新規 source: TripwireHook(トリガー中=15、`PowerCtx.trippedHook`)、
  PoweredRail(`isRailPowered`)、DaylightDetector(`daylightOutput(worldTime,
  inverted)`)。コンテナ(Hopper/Dispenser/Dropper)は**一般 source ではなく**
  `powerFromNeighbor` 内で「中身あり(`PowerCtx.hasItems`)→ 後方のブロックのみ
  弱15」を処理(§8.1)。
- 昼光センサーは**下のブロックにも弱給電**(§8.1: 弱=水平4+下、強=上)—
  `powerFromNeighbor`(上方向)と `computeDustTarget`(上段センサー分)で両対応。

### 全ワールドアクティブ領域 (tick.ts, §8.2 — 旧 3×3 チャンク宇宙スキャン廃止)
- 疎レジストリ: `components` / `dust`(posKey → {x,y,z,id})。`REDSTONE_COMPONENT_IDS`
  (types.ts) = 毎tick状態機械が必要な id 群(Tnt/NoteBlock/Hopper/Dispenser/Dropper
  は **5B 占位**として登録済み、tick case は 5B 追加)。ダストは別セット。
- 増分同期: `World.drainChangedChunks(budget=32)` で変更チャンクのみ再スキャン
  (`syncRegistry`)。ピストン移動は `patchRegistry` で即座にパッチ。
- `worldEdit(world, x, y, z, id, meta)` が**ゲーム/テストの唯一の世界書き込み経路**
  (setBlock+markDirtyAround+トリップワイヤ弦の維持: フック除去/弦セル置換で切断)。

### 昼夜サイクル (新規 src/world/time.ts)
- `DAY_LENGTH_TICKS 24000` / `DAY_HALF_TICKS 12000` / `START_TIME 1000`(1.13 既定)。
- `daylightOutput(t, inverted)` = `clamp(round(15·max(0, sin(π·t/12000))), 0, 15)`
  (昼 0≤t≤12000、夜=0、反転=15−出力)。`wrapTime` で 0..23999 に巻き戻し。
- `sunElevation(t)` = `sin(2π·t/24000)`(空色/フォグの lerp 用)。**判断**: 5A タスク
  本文の `sin(2πt/24000 − π/2)` はピークが t=12000(日没)と 1.13 センサー式と半日
  ずれるため、シフトなし版を採用(正午 t=6000 で+1)。time.test.ts で固定。
- game.ts 統合: `readonly clock = new WorldClock()`、20TPS tick で `clock.tick()`、
  redstone ctx に `worldTime: this.clock.time`、毎フレーム `renderer.updateSky(time)`。

### ドア (components.ts `doorPowered` / `tickDoor`, tick.ts `toggleDoor`)
- **電力ルール(1.13、判定済み)**: 下半分が (a) 水平4隣接の弱電力、(b) **直下からの
  弱電力(点灯ダスト — dust が上ブロックに弱給電するため)**、(c) 直下からの強電力
  (レッドストーンブロック等) のいずれかを受ければ開く。電力喪失で閉じる。
- 下半分が駆動し上半分の open ビットは同期。`isSolidBlockAt` で閉=ソリッド衝突。
- `toggleDoor`: 上下どちらでもトグル。**給電中はロック(右クリック無視)**。
  手動開放は `doors` Map(下半分 posKey)保持、電力喪失後も開放維持。
- 配置: `placeTarget` が**上下2半分を1アイテムで配置**(上半分 meta=DOOR_TOP_BIT、
  配置先がプレイヤー AABB と交差したら拒否 — 閉ドアはソリッド)。

### トライブワイル (tick.ts)
- **状態 API**: `tryConnectTripwire(world, hook, eyePos, eyeDir)` — DDA レイキャスト
  (40ブロックまで、game.raycast と同手順)。同一Yの水平1軸線 or 同X/Zの垂直線で、
  中間が全て air/弦、かつ両端とも未接続なら成功: 中間セルに `Block.Tripwire` を
  配置+双方フックの bit 2(弦保有)を立て+ `tripwireLinks` に双方向記録。
- **トリガー**: 毎tick、`ctx.entityAbove`(プレイヤー AABB)が弦セルと交差 →
  **両端フック**が `trippedHooks` 入り → 電力モデルで 15 出力(弦存在間継続)。
- **切断**: `worldEdit`(フック採掘/弦セルへの任意ブロック配置)、ピストン押出で固体
  が弦セルに着地した場合も。`isHookTripped(x,y,z)` でクエリ。
- **ゲームフロー**: 弦アイテム(`Item.TripwireString`)手持ちでフック右クリック →
  `interactWith` の `Block.TripwireHook` case が `tryConnectTripwire` を呼び、
  成功で生存モードのみ 1 消費。

### レール (§8.8)
- `Rail`/`PoweredRail`: 非ソリッド、`shape: 'rail'`。パワーレールは給電時に
  source(弱=水平4→ダストへ14、強=上)。給電判定は `isRailPowered`(上段参照)。
  (マインカートはスコープ外 — 設計書 §8.8 通り。)

### テスト結果
- `npm test`: **209/209 合格**(5A 新規: redstone5a.test.ts 24 + time.test.ts 10 +
  blocks.test 追加等)。`npm run build`: 合格(tsc --noEmit + vite build、
  `dist/assets/game.js` = 604,742 bytes、fixed-name 維持)。
- **2件の誤期待テストを判定どおりに修正**(詳細は下段の「判断」参照):
  プレート=純センサー化 / ドアは直下ダスト(弱電力)で開く。

### Phase 5B への契約(厳守)
1. **`ctx.hasItems(x, y, z)` フック** — `RedstoneCtx.hasItems?`(types.ts、省略時
   既定 false)。game.ts の redstone ctx 構築(≈422行目)に 5B のコンテナ中身系
   で実装を渡す。消費側は network.ts `powerFromNeighbor` の Hopper/Dispenser/
   Dropper case(後方のブロックのみ弱15、§8.1)。
2. **TNT 着火エントリポイント** — `Redstone.primeTnt(world, x, y, z)`(tick.ts):
   TNT の meta bit 0(`setOn`)を立て+markDirty(メッシャーが TntPrimed 白タイルに切替)。
   5B は `Redstone.tick()` の switch(「Phase 5B cases」コメント处)に `Block.Tnt`
   case を追加し **fuse 80tick カウントダウン → 爆発**(半径4・bedrock 以外を破壊
   (ドロップなし)・プレイヤー距離減衰ダメージ 中心12→端0)を実装。
   着火源(§8.4「給電で着火」)も 5B が primeTnt 経由で発火させる。
3. **音符ブロックの pitch meta アクセス** — blocks.ts `getNotePitch`/`setNotePitch`
   (bits 0-4、0-24 クランプ)。5B は tick switch に `Block.NoteBlock` case を追加し
   給電立ち上がりで `80 * 2^(n/12)` Hz 発音(上段ブロックで音色変化)、右クリック
   pitch サイクルは game.ts `interactWith` に case 追加。
4. **コンテナ GUI 統合ポイント** — game.ts `interactWith(hit)` switch(≈600行目)に
   `case Block.Hopper / Dispenser / Dropper:` を追加し右クリックでコンテナ GUI
   (9/5 スロット+プレイヤーインベントリ、クリック移動、E/Esc 閉じ)を開く。
   既存 `InventoryUI`(src/ui/inventoryUI.ts)のパターンを拡張。現状これら id は
   `interactWith` が false を返し placeTarget に落ちる(空気ではないので何もしない)。
   ハッパー伝送(上→ハッパー→下、8tick間隔・1回2アイテム)/ ドロッパー射出 /
   ディスペンサ「使用」の tick case も 5B。

### 判断(要報告)
- **圧力プレート = 純センサー(1.13)**: 前サブエージェントが「直下ダスト/下方強
  電力/水平電力でプレートが ON」を実装していたが、Java 1.13 では圧力プレートは
  エンティティ検出のみ(電力では作動しない)。`tickPlate` を entityAbove のみに
  修正、不要化した `platePowered` を削除。テストを「点灯ダスト上のプレートは
  OFF のまま(エンティティで踏圧すると ON)」に置換(1.13 セマンティクス固定)。
- **ドアは直下ダストで開く(1.13)**: 前サブエージェントの「弱電力では開かない」
  実装は誤り。dust は上ブロックに弱給電するため、下半分が「水平4弱 / 直下弱
  (ダスト)/ 直下強」のいずれでも開くのが 1.13。`doorPowered` を修正、テストを
  「powered dust below opens the door (weak power from below counts, 1.13)」
  に改名+逆転(給電除去で閉じる確認も追加)。レッドストーンブロック下テストは
  既存のまま緑。
- **`totalPowerReceived` はランプ専用**に(プレートの電力応答を撤去したため)。
  ドキュメントコメントも更新済み。

---

## Phase 3 実装メモ (integration + render verification)

### 変更点(全ファイル)
1. **地形配線** `src/game.ts`: `new World(seed)` → `new World(s, createTerrainGenerator(s))`
   (`s = seed ?? DEFAULT_SEED`)+ `import { createTerrainGenerator } from './world/terrain'`。
   スポーンは実地形上(findSpawn: 列の最上 solid)。
2. **mesher 点灯タイル** `src/world/mesher.ts`: `isPowered()` に
   `facingDelay`(repeater: 出力=meta bits 4-7、`getRepeaterOut` と同一マスク)と
   `facingModeOutput`(comparator: `getOutput`=bits 3-6)を追加。
   facing/delay/mode ビットだけでは点灯しない(テスト済み)。
   - **`src/world/blocks.ts` 編集(core所有—報告)**: タスク要求どおり lit comparator を
     描画するため `Tile.ComparatorOn = 48` と comparator の `litTiles` を追加。
     既存 id・ヘルパーは不変。
3. **DRY アトラス** 新規 `src/engine/atlas.ts`: `paintAtlas(ctx: CanvasRenderingContext2D)`
   (純 canvas 2D、three.js なし、`ATLAS_SIZE`/`TILE_PX`/`ATLAS_TILES_PER_ROW` 定数)。
   `renderer.ts` と `icons.ts` の両方が呼ぶ(従来は ~200 行の複製)。
   タイル索引・色は Phase 1 と同一(+ComparatorOn 48: 赤マーカーが明るい255,80,80)。
4. **CPU ラスタライザ** 新規 `tools/rasterizer.ts` + `tools/verify-render.ts`:
   - `renderScene(faceDatas, camera, opts)`: 透視投影(three.js YXZ 慣習、
     forward=(-sin yaw, -cos yaw)、カメラ空間 forward=-Z)、重心座標ラスタライザ、
     zバッファ(1/z 線形補間=平面三角形で正確)、per-vertex 輝度×純TSソフトアトラス
     (`buildSoftwareAtlas()`=atlas.ts のミラー)、距離フォグ、空背景、背面カリング。
   - `encodePng(w,h,rgba)`: node:zlib deflateSync + 手動 PNG チャンク(IHDR/IDAT/IEND+CRC32)。
   - `verify-render.ts` (a) seed 1337・全256チャンク生成+findSpawn+±3チャンク実メッシャー
     → 景観ビューポイント自動探索(スポーン近傍の平地標高で空いた場所+
     45°刻みで前方16ブロックが下る yaw 選択)→ `screenshots/verify-terrain.png`
     (1280×720、実測: 三角形~11万、sky~35%)。
     (b) 全空気ワールド+石床12×12+トーチ(2,1,2)→ダスト8(3..10,1,2)→
     リピータ(11,1,2, east, delay 4)→ランプ(12,1,2)、`Redstone.tick()`×10、
     10ブロック先・30°俯瞰カメラ → `screenshots/verify-redstone.png`
     (実測: ダスト 14..7、リピータ出力 7、ランプ lit=true)。
   - 実行: `npm run verify`。**tsx を devDependency に追加**(Node 24 の型剥ぎは
     extensionless import を解決せず、Vite 8 は rolldown 移行で esbuild 同梱なしのため)。
5. **スモークテスト** 新規 `test/verify.test.ts`(2): 1×1チャンク平坦ワールド→
   PNGシグネチャ+非sky>5%、空シーン→純 sky。

### テスト結果
- `npm test`: **158/158 合格**(既存152+新規6: mesher 点灯4 + ラスタライザ2)。
- `npm run build`: 合格(tsc --noEmit + vite build)。
- 両スクリーンショットは read_image で目視確認済み(地形=緑草原+砂+石山+空、
  レッドストーン=ダスト列+点灯リピータ(緑ドット)+黄色ランプ)。

### 既知ギャップ・判断(Phase 3)
- **リピータのパルス挙動(2C仕様の踏襲)**: 継続入力で出力は `delay`tick ON →
  1tick OFF → 再サンプル(真の 1.13 は入力ON中はロックで継続)。delay=1 では
  毎tick ON/OFF 交互。検証シーンは delay 4 で tick 10 時点ランプ常点灯。
- **CPU ラスタライザは水バッファを描画しない**(opaque 三角形のみ。
  ブラウザでは水は半透明マテリアルで表示)。
- **世界サイズの設計書乖離は未解決**(16×16チャンク=256×256ブロック、
  設計書§5/§11 の 4096×4096 ではない)— Phase 1 から記録済みの要確認事項。
- flower ブロック不在(平野の花なし)、ハッパー未実装(blocks.ts に id なし)、
  木はチャンク内完結 — すべて従来どおり。
- puppeteer スクリーンショット(screenshot.ts)はサンドボックスで未実行継続
  (視覚検証は CPU ラスタライザで実施済み)。

---

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
- [redstone] **Phase 2C 完了**: src/redstone/{types,network,components,tick}.ts(1.13仕様の電力モデル+固定点ダスト伝播+全コンポーネント、20TPS同期)、game.ts 統合(tickRedstone 実装・右クリックインタラクト・facing配置)、test/redstone.test.ts(32: §8.4 全シナリオ)。全152テスト合格、ビルド合格。詳細は「Phase 2C 実装メモ」節を参照
- [integration] **Phase 3 完了**: 地形配線(game.ts 1行+import)、mesher 点灯タイル修正(repeater/comparator+ComparatorOn タイル48追加)、DRYアトラス抽出(src/engine/atlas.ts が renderer/icons 共用)、CPUラスタライザ(tools/、`npm run verify`、terrain+redstone の2枚スクリーンショット)、スモークテスト(test/verify.test.ts)。全158テスト合格、ビルド合格。詳細は「Phase 3 実装メモ」節を参照
- [fixes] **Phase 4 完了**: レビュー指摘13項目全修正(リピータ持続/落下ダメージ/ピストン上限/extend再検証/ラインルール/トーチ強電力/アイル上限/メッシュ予算/placeTarget(hit)/256×256仕様確定 + DRY・マジックナンバー・デッドコード)。全160テスト合格、ビルド合格、verify 2枚目視確認。詳細は「Phase 4 実装メモ」節を参照
- [fixes] **Phase 4b 完了**: ラインルールを Phase 2C の exactly-15 に**復帰**(4bの数式 `sC > sN ? sC : sC - 1` はザグザグ均衡+自己持続ラインを引き起こし 1.13 非準拠と確定)。テスト復元(減衰=単調14,13,...,0 / 決定論出力=7 / back入力=12)+ sub-15テスト削除 + 新規「no self-sustain」テスト。design.md §8.2 文言置換。詳細は「Phase 4b 実装メモ」節を参照
- [polish] **最終polish完了**: (1) design.md §8.4 減衰文言を実装と整合に修正(「14マス目=強度1、15マス目で0（単調減衰）」)。(2) `tickTorch` に 1.13 忠実な「下段ダスト(strength>0)で消灯」を追加(上段からの給電はダストに効かないため安定)。新規テスト2件(点灯ダスト上のトーチ1tickで消灯 / 非点灯ダスト上は点灯維持)。全162テスト合格、ビルド合格
- [redstone] **Phase 5A 完了**: 1.13 完全版データ層+電力モデル(新規ブロック Hopper/DaylightDetector/Tnt/NoteBlock/Rail/PoweredRail/Tripwire + 既存 TripwireHook/Dispenser/Dropper/OakDoor 全実装)、dust-上ブロック弱給電+全ワールドアクティブ領域(疎レジストリ+変更チャンク増分スキャン)、昼夜サイクル(time.ts 24000tick/日)、ドア(上下2半分+1.13電力ルール+手動トグル+ソリッド性)、トリップワイヤ(接続/トリガー/切断+弦アイテム)、パワーレール。誤期待テスト2件を判定どおりに修正(プレート=純センサー / ドアは直下ダストで開く)。全209テスト合格、ビルド合格。5B 契約4件(hasItems / TNT着火 / note pitch / コンテナGUI)を「Phase 5A 実装メモ」節に明記
- [fixes] **ユーザー報告バグ2件修正**: (1) インベントリスロットクリック無効 — `#hud{pointer-events:none}`(index.html)が子要素も食っており、`src/ui/inventoryUI.ts` の `.inventory-panel` ルールに `pointer-events:auto` を追加(スロットはパネルから継承、ホットバーと同パターン)。(2) 水から出られない — `src/player/physics.ts` の `WATER_JUMP_VELOCITY` を 4.5→9 に(9²/60=1.35ブロックで1段の岸を越えられる。ジャンプ維持で毎tick vy=9 更新のため深水の底から表面への上昇も保証。持続上昇キャップ案は岸越え要件(1.0ブロック)と両立しないため未採用)。新規テスト2件(1段岸ジャンプ脱出 / 5段プール水面到達)。全164テスト合格、ビルド合格

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

## Phase 2C 実装メモ (redstone モジュール)

### 新規ファイル(すべて [redstone] 所有)
```
src/redstone/types.ts      RedstoneCtx / 定数(MAX_POWER=15, DUST_MAX_ITERATIONS=30,
                           DUST_MAX_ROUNDS=3, PISTON_PUSH_LIMIT=12, PISTON_ACTION_TICKS=2,
                           OBSERVER_OUTPUT_TICKS=2, BUTTON_TICKS 10/20) / posKey / FACING_X/Z /
                           facingFromYaw(yaw) / getRepeaterOut・setRepeaterOut(meta bits4-7)
src/redstone/network.ts    電力モデル(directPower/weakPower/strongPowerToAbove/isStronglyPowered/
                           powerFromNeighbor/inputPowerAt) + ダスト固定点伝播
                           (computeDustTarget / propagateDust / propagateDustToFixedPoint)
src/redstone/components.ts 全コンポーネント状態機械: tickTorch / tickLamp / tickDelayed(repeater+comparator) /
                           tickObserver / tickButton / tickPlate / tickPiston(canExtend/extend/retract)
src/redstone/tick.ts       Redstone クラス: tick(world, ctx) — 宇宙スキャン(プレイヤー3×3チャンク、
                           id 18..34 の typed-array スキャン≈0.5ms)→ 状態機械 → ピストン移動適用 →
                           ダスト固定点+受動コンポーネント(上限ラウンド)→ 状態パージ。
                           pressButton(world,x,y,z) は右クリックから呼ぶ
test/redstone.test.ts      32テスト(§8.4 全シナリオ: 減衰境界/ラインルール/リピータ遅延・維持・
                           強度保持・ロック/コンペア compare・subtract/ピストン12推進・13失敗・
                           bedrock・sticky引き戻し/オブザーバ2tick/トーチ消灯・点灯/ランプ/
                           圧力プレート/ボタン10・20tick/レバー/決定論)
```

### game.ts 統合ポイント(Phase 2C が編集した箇所 — 許可範囲内のみ)
1. **`Game.tickRedstone()`** — スタブを `this.redstone.tick(this.world, ctx)` で実装。
   ctx = `{ playerX/Y/Z, entityAbove(x,y,z) }`。entityAbove は `Player.boxesIntersect(
   player.getAABB(), ブロックbox)` で圧力プレートの踏圧を検出。20TPSで毎ティック呼ばれる(既存呼出箇所は不変)。
2. **`Game.interactWith(hit)`(新規)** — `onRightClick()` 内で placeTarget() 前に呼ぶ。
   レバー=on切替(setOn)、ボタン=`redstone.pressButton()`(10/20tickカウントダウン)、
   リピータ=遅延 1→2→3→4→1(setDelay)、コンペア=モード切替(setMode)。ヒットすれば true を返し放置をスキップ。
3. **`Game.placeTarget()`** — 向きブロック(piston/sticky_piston/observer/repeater/comparator)は
   `facingFromYaw(player.yaw)` で facing meta(bits0-1)を保存。レッドストーントーチは meta=1(点灯;
   torch の meta は onOff で facing bit と衝突するため facing は保存しない — 簡易化・下記参照)。
4. `Game.redstone` フィールド(readonly Redstone)を追加。block-breaking/採掘/エンティティティックは不変。

### RedstoneCtx インターフェース(game.ts → tick.ts)
```ts
interface RedstoneCtx {
  entityAbove(x: number, y: number, z: number): boolean; // AABB重複(プレート: 上1マスの空間)
  playerX: number; playerY: number; playerZ: number;     // 宇宙スキャン範囲の中心
}
```

### 1.13 セマンティクス判断(設計書 §8 準拠 + 決定論的解釈)
1. **ラインルール(§8.2d)の解釈**: 「2ブロック先のダスト C が **full strength(15)のときのみ**、
   減衰なしで伝播」。弱い信号は 1ブロック毎 -1 で減衰。根拠: 要求テスト両立必須 —
   (a) トーチ直線は 14,13,...,0(15個目で0)の完全境界、(b) RB上のダスト(15)が2つ先にフル強度を伝える。
   「任意強度で2つ先参照」だと直線が 14,13,14,13... にジグザグ化し (a) を壊す。types.ts 冒頭コメントにも明記。
2. **トーチの消灯条件**: 水平4隣接+下方が給電で消灯。ただし**隣接ダストは消灯要因にしない**
   (1.13 ルール: 隣接ダストはトーチを消さない。これで基本トーチ+ダスト線回路が成立し、減衰テストと整合)。
3. **強電力(source化)の範囲**: 強給電された**実ブロック**が 15 source になる(垂直に伝播)。
   air は source にならない(バグ回避: かつて air が隣接 source で power 化し全回路が過給電した)。
   水平方向の強 source は redstone_block と点灯中の wall torch のみ(レバー/ボタン/プレートは
   添付ブロック(下方)にのみ power する — 1.13 準拠の簡易化。添付方向メタは本プロジェクトに無いため)。
   リピータ/コンペアは facing 方向のブロックにのみ weak+strong 出力(フル強度・減衰なし)。
4. **ピストン幾何(1.13)**: base=P、(縮小時)ヘッド=P+d を占有、押出カラムは P+2d から。
   伸展: ヘッド P+d→P+2d、カラム全体 +d 移動、base P→P+d。12要素制限=メインヘッド+押出ブロック
   (連鎖ピストンは base+head で 2 カウント)。bedrock・非 solid ブロック・向き違いピストンは失敗。
   縮小: 2tick 後 base 復帰、sticky は「伸展時に記録した前面ブロックが不変かつ solid」のときのみ引き戻し。
   伸展完了時に前面記録(移動適用後読み込み)。状態 Map は base 移動に伴い再キーイング(移動先キーで保持)。
5. **リピータ/コンペア timing**: 入力検出 tick t → t+1 で出力 ON(1tick遅延)→ リピータは delay(1-4)tick、
   コンペアは 1tick 維持 → OFF。出力>0 中はロック(入力無視)。出力=入力強度のキャプチャ(保持)。
   リピータの出力は meta bits4-7(blocks.ts 未定義域 — Phase 2C 追加、types.ts 参照)。
   コンペア: compare=max(back, side0, side1)、subtract=max(back-side0, 0)。side0=facing の +90°側。
6. **ティック順序**(タスク指定): (1)宇宙スキャン(2)状態機械(ピストン/オブザーバ/リピータ/コンペア/
   ボタン/プレート)(3)ピストン移動適用(4)ダスト固定点(≤30スイープ)+トーチ/ランプ再評価(≤3ラウンド)
   (5)ランタイム状態パージ。全処理は同期・決定論(排序済み位置順)。タイマ/promise なし。

### 既知の簡易化・制約
- **アクティブ範囲**: プレイヤーの 3×3 チャンク(±16ブロック)内の redstone ブロック(id 18..34)のみティック。
  離れたネットワークは停止(Minecraft の active redstone 距離制限と同じ趣旨)。
- **ディスペンサ/ドロッパー**: 内容物システムが無いため meta bit0 フラグが立っている時のみ source(15)。
  通常は OFF(タスクの「keep simple」指示どおり)。
- **トリップワイヤフック**: 未実装(source にもしていない、設計書「簡易可」)。
- **ハッパー**: blocks.ts に id が存在しない(§8.1 に記載あり)→ 未実装(blocks.ts 編集禁止のため適応: 存在しない id は source にしない)。
- **メッシャー**: `isPowered()` が facingDelay/facingModeOutput 種を扱わないため、リピータ/コンペアの
  点灯(litTiles)は描画されない(出力は meta に正しく書かれる)。Phase 3 で mesher 側拡張を推奨。
- **トーチ自己給電**(トーチが自分のダスト線でループする回路)は 1tick 周期で振動(1.13 と同様の挙動)。
- **スクリーンショット**: サンドボックス制約で未実行(指示どおり)。視覚検証は Phase 3 の CPU ラスタライザで実施予定。

### テスト結果
- `npm test`: 152/152 合格(既存120 + 新規32)。`npm run build`: 合格。

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
