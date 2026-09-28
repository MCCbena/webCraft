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
