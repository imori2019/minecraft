# バーアドオン コマンド一覧（v1.5.8）

`behavior_pack/scripts/` のコードから、登録されているコマンドと受け付ける引数をすべて書き出したものです。

## 共通

- すべて **チート有効** かつ **GameDirectors 以上**（コマンドブロック・OP）で実行できます。
- 名前は `rt:` から始まります（`/rt:timer` など）。
- `<>` は必須の引数、`[]` は省略できる引数です。引数は前から順番に読まれるので、後ろの引数だけを指定したい場合は、途中の引数を `0`（なし）で埋めます。
- 引数を変えた版に入れ替えたときは、`/reload` ではなく **ワールドを開き直して** ください。

---

## 1. バーを作るコマンド

### `/rt:timer` タイマー（バー＋時計）

```
/rt:timer <秒数> [ラベル] [digits] [開始メッセージ] [終了メッセージ] [style]
```

| 引数 | 型 | 使える値 |
|---|---|---|
| 秒数 | 整数 | `0` 以上。`0` で表示中のタイマーの数字とラベルを消す。時計を出すときは `5999`（99:59）まで |
| ラベル | 文字 | 自由。`0` でなし。末尾の `:` `：` は自動で取り除かれる |
| digits | 文字 | `on` `show` `1` `true`（数字を出す・既定）／ `off` `hide` `0` `false`（数字を出さない） |
| 開始メッセージ | 文字 | 自由。`0` でなし |
| 終了メッセージ | 文字 | 自由。`0` でなし |
| style | 文字 | `boss` `default` `normal`（ボスバー風・既定）／ `xp`（経験値バー風） |

例: `/rt:timer 60 残り時間`　`/rt:timer 60 残り時間 off`　`/rt:timer 60 残り on 0 0 xp`

### `/rt:countdownbar` ・ `/rt:countupbar` 時間連動のバー

```
/rt:countdownbar <秒数> [ラベル] [digits] [開始メッセージ] [終了メッセージ] [最大] [up|down] [style]
/rt:countupbar   <秒数> [ラベル] [digits] [開始メッセージ] [終了メッセージ] [最大] [up|down] [style]
```

`countdownbar` はバーが減り、`countupbar` はバーが増えます。

| 引数 | 型 | 使える値 |
|---|---|---|
| 秒数 | 整数 | `1` 以上。digits が on のときは `5999` まで |
| ラベル / digits / 開始 / 終了 | | `/rt:timer` と同じ |
| 最大 | 整数 | `1` 以上。バーの段階数（省略時は秒数と同じ）。`rt_bar` / `rt_bar_max` にも出る |
| up\|down | 文字 | 時計の数字の向き。`up`（増える）／ `down`（減る・既定） |
| style | 文字 | `boss`（既定）／ `xp` |

例: `/rt:countdownbar 60 残り on 開始 終了 50 down`

### `/rt:countdown` ・ `/rt:countup` スコアボード・統計連動のカウンター

```
/rt:countdown <使う値> <最大数> <タイトル> <表示> [色]
/rt:countup   <使う値> <最大数> <タイトル> <表示> [色]
```

| 引数 | 型 | 使える値 |
|---|---|---|
| 使う値 | 文字 | スコアボード名、または `stat:統計.対象.タグ`（下の「統計」） |
| 最大数 | 整数 | `1` 以上 |
| タイトル | 文字 | 自由。`0` または `-` でなし |
| 表示 | 文字 | `count`（現在値/最大値）／ `none`（数字なし）／ `d秒`（時計・減る。例 `d60`）／ `a秒`（時計・増える。例 `a60`）。秒は `1`〜`5999` |
| 色 | 文字 | `blue` `red` `green` `yellow` `purple` `orange` `white` `xp`（省略可） |

例: `/rt:countup test_count 100 テスト count`　`/rt:countup stat:mob_kills 20 討伐 count xp`

### `/rt:ratio` 割合バー

```
/rt:ratio <使う値> <チーム> <タイトル> [秒数]
```

| 引数 | 型 | 使える値 |
|---|---|---|
| 使う値 | 文字 | スコアボード名、または `stat:...` |
| チーム | 文字 | `1`〜`8`（赤・青・黄・緑・水色・紫・橙・桃の先頭から N 色）／ `all`（8色）／ `red_blue` のように `_` でつないだ色名（`red` `blue` `yellow` `green` `cyan` `purple` `orange` `pink`。同じ色の重複は不可。順番は自動で上の並びにそろう） |
| タイトル | 文字 | 自由 |
| 秒数 | 整数 | `0`〜`5999`。付けたときだけ時計が出る |

例: `/rt:ratio team_count red_blue テスト`　`/rt:ratio stat:kills.zombie 4 討伐対決 300`

---

## 2. バーの操作

| コマンド | 引数 | 内容 |
|---|---|---|
| `/rt:play` | なし | 開始（数える対象の人の統計は 0 に戻る） |
| `/rt:stop` | なし | 一時停止 |
| `/rt:remove` | なし | バーを削除 |
| `/rt:hudtest` | なし | 実行した人（コマンドブロックなら全員）に HUD のテスト表示 |

---

## 3. 名前を付けた統計 `/rt:stat`

```
/rt:stat <名前> <式...>       作る・置き換える（式は空白区切りで7個まで。長い式は "..." で囲む）
/rt:stat <名前> delete        削除
/rt:stat list                 一覧
```

- 名前: 24文字まで、日本語可。空白と `. : + , = @ / \ " '` は使えない。組み込みの統計名・チームの色・`list`・`delete` は名前にできない。
- 式の書き方（演算子・関数）は `behavior_pack/explanation.txt` の【式の書き方】【関数の一覧】を参照。計算は **左から順**（掛け算の優先なし）。
- 使うときは `stat:名前` または `stat:名前.タグ`。

---

## 4. チーム

チームはプレイヤーのタグ `team_red` `team_blue` `team_yellow` `team_green` `team_cyan` `team_purple` `team_orange` `team_pink` で管理しています。1人につき1色で、別の色にすると前の色のタグは外れます。

### 色ごとのコマンド

```
/rt:red    [プレイヤー]
/rt:blue   [プレイヤー]
/rt:yellow [プレイヤー]
/rt:green  [プレイヤー]
/rt:cyan   [プレイヤー]
/rt:purple [プレイヤー]
/rt:orange [プレイヤー]
/rt:pink   [プレイヤー]
```

プレイヤーはセレクタ（`@s` `@a[r=5]` や名前）。省略すると実行した人。

### `/rt:team` まとめたチームコマンド（explanation.txt に書かれていないもの）

```
/rt:team <操作> [プレイヤー] [チーム数]
```

| 操作 | 内容 |
|---|---|
| `red` `blue` `yellow` `green` `cyan` `purple` `orange` `pink` | その色にする（プレイヤー省略で自分） |
| `clear` | チームのタグを外す（プレイヤー省略で自分） |
| `check` | 指定した人のチームを表示。2色付いている人は両方外す |
| `list` | 全員のチームを表示 |
| `random` | ランダムにチーム分け。プレイヤー省略で全員、チーム数は `2`〜`8`（省略時 `4`） |
| `base_set` | チーム分けエリアを8色で作る（`/rt:base set` と同じ。プレイヤーが実行したときだけ） |
| `base_remove` | チーム分けエリアを消す（`/rt:base remove` と同じ） |

例: `/rt:team random @a 2`　`/rt:team clear @a`　`/rt:team list`

### `/rt:base` チーム分けエリア

```
/rt:base [操作] [チーム数]
```

| 操作 | 内容 |
|---|---|
| `set` `on` `start`（省略時） | 実行した人の場所にエリアを作る。チーム数 `2`〜`8`（省略時 `8`）。すでにあるときはエラー |
| `remove` `off` `stop` | エリアを消す |
| `info` `status` | 状態（エリア数・ディメンション・中心座標）を表示 |

アイテム `bar_addon:team_area_tool` を使っても、エリアを作る・消すができます（`/give @s bar_addon:team_area_tool`）。

---

## 5. ゲーム管理

| コマンド | 引数 | 内容 |
|---|---|---|
| `/rt:game <操作>` | `start` `play` ／ `stop` `pause` ／ `reset` `restart` | 開始・停止・リセット（reset はバーの設定とチームを残す） |
| `/rt:reset` | なし | アドオンのワールド状態を完全に初期化（名前を付けた統計は残る） |
| `/rt:debug` | なし | 実行状態を表示 |

---

## 6. 統計（`stat:統計.対象.タグ`）

- **対象**: モブ・ブロック・アイテムの名前（`minecraft.` は省略可）。例 `kills.zombie` `blocks_broken.stone`
- **追加パックのモブなど**: 名前空間を `:` でつなぐ。例 `kills.mypack:giant`、`kills.mypack:giant.red`。`kills.mypack.giant` と書くと `giant` がタグとして読まれて数えられない。
- **倒した数として数えるもの**: プレイヤーが直接、または飛び道具（弓・トライデントなど）で倒したとき。飼い慣らしたオオカミ・TNT・溶岩・落下などで倒れたときは数えない。
- **タグ**: `all`（全員・省略時）／ チームの色（`red` など）／ `team`（チームに入っている人全員）／ 自分で付けたタグ名。プレイヤー名は使えない。

### 数えていく統計

| 種類 | 名前 |
|---|---|
| 討伐 | `mob_kills`（別名 `kills` `mobkills`）, `player_kills`（別名 `playerkills`）, `kills.<モブ>`, `deaths`, `killed_by.<モブ>`, `respawns`, `totem_pops`（別名 `totem`） |
| ダメージ | `damage_dealt`, `damage_taken`, `hits_dealt`, `hits_taken`, `max_single_hit`, `max_damage_taken`, `healing_events`, `healing_total` |
| ブロック | `blocks_broken`, `blocks_placed`, `blocks_broken_with`, `tools_broken`（`.<名前>` で個別） |
| アイテム | `items_used`, `items_picked_up`, `items_picked_up_stacks`, `items_dropped`, `items_dropped_stacks`, `containers_opened`, `entity_containers_opened` |
| 移動 | `distance`, `distance.horizontal`, `distance.sprinting`, `distance.swimming`, `distance.gliding`, `distance.in_water`, `distance.ascent`, `distance.descent`, `jumps`, `sneak_presses`, `max_speed_bps`, `highest_y`, `lowest_y`, `dimension_changes` |
| 時間 | `play_time_ticks` / `_seconds` / `_minutes` / `_hours`, `life_time_ticks` / `_seconds`, `session_time_ticks` / `_seconds`, `longest_life_ticks` / `_seconds`, `longest_session_ticks` / `_seconds`, `joins` |
| その他 | `emotes`, `highest_xp_level`, `highest_xp_total` |

### 今の値（リアルタイム）

| 種類 | 名前 |
|---|---|
| 体力 | `health`（別名 `hp`）, `health_max`, `health_percent` |
| 経験値 | `xp.total`（別名 `xp`）, `xp.level`（別名 `level`）, `xp.at_current_level`, `xp.needed_next_level` |
| 位置・速さ | `position.x` / `.y` / `.z`, `velocity.x` / `.y` / `.z`, `speed.blocks_per_second`（別名 `speed`）, `speed.horizontal_bps` |
| 状態（1 か 0） | `state.sneaking` `sprinting` `swimming` `gliding` `flying` `on_ground` `in_water` `falling` `climbing` `sleeping` `jumping` |
| 明るさなど | `light.level`, `light.sky`, `block.redstone_power`（足元のブロック） |
| 持ち物 | `inventory.<項目>`, `hotbar.<項目>`, `container.<項目>`（開いている箱）, `target_container.<項目>`（見ている箱）, `held.container.<項目>` |
| 　└ 項目 | `total_items`（別名 `total` `count`）, `used_slots`, `empty_slots`, `size`, `unique_types`, `full_stacks`, `largest_stack`, `fill_percent`, `weight`, `present`, `item.<アイテム>.count` |
| 手に持った物 | `held.count`, `held.max_stack`, `held.weight`, `held.durability_damage`, `held.durability_max`（別名 `held.max_durability`）, `held.durability_remaining`（別名 `held.durability`）, `held.durability_percent` |
| 装備 | `equipment.<head|chest|legs|feet|offhand>.<count|weight|durability_*>`, `armor.points`, `armor.toughness`, `armor.equipped_slots`, `armor.durability_remaining` / `_max` / `_percent` |
| まわり | `nearby.entities.<半径>`, `nearby.players.<半径>`, `nearby.entity.<モブ>.<半径>`（半径 1〜128） |

`inventory.` `held.` `armor.` などで始まる今の値には、タグを付けられません。

---

## 7. コマンドブロック用のスコアボード

プレイヤーごとに書き込まれます（`@a[scores={rt_timer=0}]` のように使えます）。

| スコア | 中身 |
|---|---|
| `rt_timer` | 残り秒（カウンターでは表示している値） |
| `rt_elapsed` / `rt_total` / `rt_percent` | 経過秒 / 全体の秒数 / 進み具合(%) |
| `rt_running` / `rt_paused` / `rt_finished` | 動いている / 一時停止中 / 終わった（1 か 0） |
| `rt_run` | 実行ごとの番号（開始するたびに変わる） |
| `rt_bar` / `rt_bar_max` | バーの今の値 / 最大 |
| `rt_event` `rt_time_event` `rt_percent_event` `rt_bar_event` `rt_finish_event` | その瞬間だけ値が入るイベント用（毎回書き込み） |

割合バーは、偽プレイヤー `red` `blue` … `pink` に書き込まれます。

| スコア | 中身 |
|---|---|
| `rt_ratio` | その色の割合（%）。全色の合計が 100 |
| `rt_ratio_value` | その色の元の値（合計） |
| `rt_ratio_active` | その色のプレイヤーがいれば 1 |
| `rt_ratio_event` | 区切りの % を越えた瞬間だけ値、それ以外は -1 |

---

## 8. ボスバーとの重なりを避けるタグ

| タグ | 付ける相手 | 内容 |
|---|---|---|
| `rt_pad1` `rt_pad2` `rt_pad3` | プレイヤー | その段数（1段 20px）ぶん、常にバーを下げる |
| `rt_boss` | エンティティ | 64ブロック以内にいると、ボスとして1段下げる |
