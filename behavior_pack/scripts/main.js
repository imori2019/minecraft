import { EnchantmentTypes, ItemStack, ItemTypes, Potions, system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";
import { JA_ITEM_NAMES } from "./ja_names.js";

const PANEL_ID = "shopuilook2:panel";
const PROBE_ID = "shopuilook2:decision_probe";
// Legacy twin probe (v9-v13 swapped A<->B on every name change; B turned
// out NOT to display its name). Never created any more; still recognised
// so leftover B stacks keep working and get converted back to A.
const PROBE_B_ID = "shopuilook2:decision_probe_b";

// v59-61: real-item display for landing cells (icon + native hover tooltip).
// NOTE: ItemStack.setDynamicProperty only works on non-stackable items (per
// the official docs), so it silently fails for a plain, stackable sample
// item like a diamond - the marker would never actually be set, and every
// landing rebuild would then misread the clone as "gone" (clicked),
// reopening that product in an endless loop. Mark it in the nameTag
// instead. v61: a raw zero-width Unicode character isn't guaranteed to be
// truly invisible on every client font, and could be part of why nothing
// showed. Format codes (§0 etc.) ARE always parsed out by Minecraft's own
// text renderer - proven throughout this whole project - so use two of
// those back to back as the marker instead: guaranteed invisible, and an
// exact match is vanishingly unlikely in a real product/item name.
const DISPLAY_MARKER_CHAR = "\u00a70\u00a71";
const UNKNOWN_PRODUCT_ID = "shopuilook2:decision_probe_unknown";
// Tried first for "no item configured" products: minecraft's own internal
// placeholder block (shown when a block ID fails to resolve). It cannot be
// obtained via /give, but the Script API may still be able to construct
// it directly - worth trying, with our own safe custom item as fallback
// if it throws or the engine refuses to hand back a usable stack.
const VANILLA_UNKNOWN_ID = "minecraft:unknown";

function isDisplayClone(item) {
    return typeof item?.nameTag === "string" && item.nameTag.startsWith(DISPLAY_MARKER_CHAR);
}

function formatPriceText(settings) {
    const raw = settings?.["price"];
    const n = Number(toHalfWidthDigits(String(raw ?? "")));
    if (!raw || !Number.isFinite(n) || n <= 0) return "価格: 未設定";
    return `価格: ${n.toLocaleString("ja-JP")}`;
}

function savedChoice(settings, prop, max, fallback = 0) {
    const n = Math.trunc(Number(settings?.[prop]));
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
}

function saleTypeText(settings) {
    return ["単数", "複数セット", "くじ"][savedChoice(settings, "shop_sale_type", 2)] ?? "単数";
}

function transactionText(settings) {
    const method = savedChoice(settings, "shop_payment_method", 3);
    if (method === 0) {
        const raw = settings?.["price"];
        const n = Number(toHalfWidthDigits(String(raw ?? "")));
        return `取引内容: 通貨 ${raw && Number.isFinite(n) && n > 0 ? n.toLocaleString("ja-JP") : "未設定"}`;
    }
    if (method === 1) {
        const raw = settings?.["required_xp"];
        return `取引内容: レベル ${raw || "未設定"}`;
    }
    if (method === 2) {
        const parts = [];
        for (let i = 1; i <= 8; i++) {
            const idKey = i === 1 ? "required_item" : `payment_required_item_${i}`;
            const countKey = i === 1 ? "required_item_count" : `payment_required_count_${i}`;
            const id = settings?.[idKey];
            if (!id) continue;
            const count = Math.max(1, Math.trunc(Number(settings?.[countKey]) || 1));
            parts.push(`${jaItemName(id)} ×${count}`);
        }
        return `取引内容: アイテム ${parts.length ? parts.join("、") : "未設定"}`;
    }

    const pointType = savedChoice(settings, "shop_payment_point_type", 2);
    if (pointType === 0) return `取引内容: ショップポイント ${settings?.["payment_shop_points"] || "未設定"}`;
    if (pointType === 1) return `取引内容: チェーンポイント ${settings?.["payment_chain_points"] || "未設定"}`;
    const name = settings?.["payment_custom_point_name"] || "カスタムポイント";
    return `取引内容: ${name} ${settings?.["payment_custom_points"] || "未設定"}`;
}

// "販売内容" line: what the product actually contains (all configured
// items, regardless of role - sample/bonus/lastOne - each with its count).
function saleContentText(record) {
    const items = record.items ?? [];
    if (items.length === 0) return "販売内容: 未設定";
    const parts = items.map(it => `${it.name ? it.name : jaItemName(it.id)} ×${it.count}`);
    return "販売内容: " + parts.join("、");
}

// Builds the real item shown in a landing product cell: a 1-count clone of
// the product's first configured item (or the unknown-block placeholder).
// Tooltip layout (native Minecraft hover, no custom UI needed):
//   商品名          <- nameTag (title)
//   販売内容: ...   <- lore line 1
//   価格: ...       <- lore line 2
function makeLandingDisplayItem(record) {
    const first = [...(record.items ?? [])]
        .filter(it => it.role === "sample")
        .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999))[0] ?? record.items?.[0];

    let item;
    // v66: use the exact ItemStack captured from the FIRST sample slot at save time.
    // This avoids trying to infer a set-product icon from its serialized contents.
    try {
        item = record.icon ? restoreItemStack(record.icon) : undefined;
        if (item) item.amount = 1;
    } catch { item = undefined; }

    try {
        if (!item) item = first?.id ? new ItemStack(first.id, 1) : undefined;
    } catch { item = undefined; }

    if (!item) {
        try {
            const u = new ItemStack(VANILLA_UNKNOWN_ID, 1);
            if (u && u.typeId) item = u;
        } catch {}
    }
    if (!item) item = new ItemStack(UNKNOWN_PRODUCT_ID, 1);

    const name = record.settings?.["shop_product_name"];
    const shown = name ? `§r${name}` : (first ? (first.name ?? "") : "§7未設定の商品");
    item.nameTag = DISPLAY_MARKER_CHAR + shown;
    try {
        item.setLore([
            saleContentText(record),
            `販売形式: ${saleTypeText(record.settings)}`,
            transactionText(record.settings)
        ]);
    } catch {}
    return item;
}

function isProbe(item) {
    return item?.typeId === PROBE_ID || item?.typeId === PROBE_B_ID;
}

const SHARED_CHOICE_SLOTS = [27, 28, 29, 30, 31];

const DROPDOWNS = [
    { id: "product_type", slot: 26, prop: "shop_type_bind_choice", count: 5 },
    { id: "discount_condition", slot: 38, prop: "shop_discount_condition", count: 3 },
    { id: "discount_time_type", slot: 39, prop: "shop_discount_time_type", count: 2 },
    { id: "daily_time_type", slot: 39, prop: "shop_daily_time_type", count: 2 },
    { id: "sale_type", slot: 41, prop: "shop_sale_type", count: 3 },
    { id: "payment_method", slot: 42, prop: "shop_payment_method", count: 4 },
    { id: "payment_point_type", slot: 43, prop: "shop_payment_point_type", count: 3 },
    { id: "grant_point_type", slot: 44, prop: "shop_grant_point_type", count: 3 },
    { id: "required_point_type", slot: 45, prop: "shop_required_point_type", count: 3 },
    { id: "stock_replenish", slot: 46, prop: "shop_stock_replenish", count: 4 },
    // おまけの渡し方 (単数・複数のみ):
    //   0 = 各スロット1個ずつ: おまけ欄の埋まっている各スロットから1個ずつ
    //   1 = ランダムで1種    : 埋まっているスロットから1つ選び、そこから1個
    { id: "bonus_mode", slot: 51, prop: "shop_bonus_mode", count: 2 }
];

const DROPDOWN_BY_ID = new Map(DROPDOWNS.map((d) => [d.id, d]));
const OPEN_AMOUNT = 2;
const CLOSED_BASE_AMOUNT = 3;

// Weekday multi-select. 27..31 are shared with normal dropdowns.
const WEEKDAY_SHARED_SLOTS = [27, 28, 29, 30, 31, 32, 33];
const WEEKDAY_STATE_SLOT = 34;
const WEEKDAY_OPEN_AMOUNT = 2;
const WEEKDAY_CLOSED_AMOUNT = 3;
const WEEKDAY_RESTORE_SLOTS = [35, 36];

// Vanilla-style toggle state slots.
const TOGGLES = [
    { id: "notify_sold", slot: 47, prop: "shop_notify_sold" },
    { id: "give_history", slot: 48, prop: "shop_give_history" }
];

// + item buttons.
const ACTIONS = [
    {
        id: "multi",
        saleChoice: 1,
        prop: "shop_multi_item_rows"
    },
    {
        id: "random",
        saleChoice: 2,
        prop: "shop_random_item_rows"
    }
];

const ADD_SIGNAL_SLOT = 49;
const ROW_STATE_SLOT = 50; // legacy name: now the SALE LAYOUT mirror

// ------------------------------------------------------------
// Real item slots (v23 layout). Every mode uses all 19 real slots;
// only the ROLE of 17..25 changes. 0..8,16 are ALWAYS stock.
//
//   slot       単数      複数      くじ
//   0-8,16     在庫      在庫      在庫
//   17         見本      見本      ラストワン賞
//   18,19      見本      見本      在庫
//   20,21      おまけ    見本      在庫
//   22-25      おまけ    おまけ    在庫
//
// Slot50 count mirrors the sale type for the UI: 2 単数 / 3 複数 / 4 くじ
// (never 1: a stack of 1 displays no count, so the UI could not read it).
// ------------------------------------------------------------
const SALE_LAYOUT_SLOT = 50;
const SAMPLE_SLOTS_ALL = [17, 18, 19, 20, 21];
const BONUS_SLOTS = [22, 23, 24, 25];
const LAYOUT_MIGRATION_PROP = "shop_layout_v2";

const SALE_LAYOUTS = {
    0: { // 単数: 在庫10 (5x2) / 見本3 (1 row) / おまけ6 (3x2)
        stock: [0, 1, 2, 3, 4, 5, 6, 7, 8, 16],
        sample: [17, 18, 19],
        bonus: [20, 21, 22, 23, 24, 25],
        lastOne: []
    },
    1: { // 複数
        stock: [0, 1, 2, 3, 4, 5, 6, 7, 8, 16],
        sample: [17, 18, 19, 20, 21],
        bonus: [22, 23, 24, 25],
        lastOne: []
    },
    2: { // くじ: shared store stock only (v53); 18..25 unused
        stock: [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 18, 19, 20, 21, 22, 23, 24, 25],
        sample: [],
        bonus: [],
        lastOne: [17]
    }
};

function slotRole(saleType, slot) {
    const layout = SALE_LAYOUTS[saleType] ?? SALE_LAYOUTS[0];
    for (const role of ["stock", "sample", "bonus", "lastOne"]) {
        if (layout[role].includes(slot)) return role;
    }
    return undefined;
}

// Slots whose role differs between the two sale types: their items would
// silently change meaning, so they are returned to the player.
function slotsWithChangedRole(fromType, toType) {
    const result = [];
    for (const slot of [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]) {
        if (slotRole(fromType, slot) !== slotRole(toType, slot)) result.push(slot);
    }
    return result;
}

function giveOrDrop(player, item) {
    let rest = item;
    try {
        const inv = player?.getComponent("minecraft:inventory")?.container;
        if (inv) rest = inv.addItem(item);
    } catch {}
    if (rest) {
        try { player.dimension.spawnItem(rest, player.location); } catch {}
    }
}

// Moves real items out of the given slots into the player's inventory.
function returnSlotItems(player, container, slots) {
    let moved = 0;
    for (const slot of slots) {
        try {
            const item = container.getItem(slot);
            if (!item || isProbe(item)) continue;
            container.setItem(slot, undefined);
            giveOrDrop(player, item);
            moved++;
        } catch {}
    }
    return moved;
}
const REMOVE_SIGNAL_SLOT = 51;
const MAX_ITEM_ROWS = 8;

const PAYMENT_ITEM_ROW_STATE_SLOT = 43;
const PAYMENT_ITEM_ADD_SIGNAL_SLOT = 52;
const PAYMENT_ITEM_REMOVE_SIGNAL_SLOT = 53;
const PROP_PAYMENT_ITEM_ROWS = "shop_payment_item_rows";

const FOOTER_CANCEL_SLOT = 37;
const FOOTER_SAVE_SLOT = 40;
const PRODUCT_DELETE_SIGNAL_SLOT = 31;
const PRODUCT_DELETE_NO_SLOT = 32;
const PRODUCT_DELETE_STATE_SLOT = 33;
const ALL_TEXT_EDIT_SIGNAL_SLOT = 40;

// ============================================================
// No-blink text display (v20)
//
// Observed on device:
//  - Labels use binding_condition "visibility_changed": a VISIBLE label
//    never re-reads, so rewriting its slot never blanks it.
//  - A label reads the slot name at the moment it becomes visible.
//  - A name the script rewrote is readable only after the PLAYER'S
//    inventory has changed once (the client re-reads names then).
//    Reading before that gives an empty/old text.
// So every change is done in this order:
//   1. write the names of the fields that will appear (still hidden)
//   2. touch the player's inventory (insert a probe; next tick removes it)
//   3. two ticks later, flip the state that makes the fields visible
// Opening the shop uses a gate (slot40 count): all labels hidden (1),
// names written + inventory touched, then shown (2).
// ============================================================
const TEXT_GATE_SLOT = ALL_TEXT_EDIT_SIGNAL_SLOT;
const TEXT_GATE_HIDDEN = 1;
const TEXT_GATE_SHOWN = 2;
const VISUAL_COMMIT_DELAY_TICKS = 2;
const TRANSITION_HIDDEN_MODE = 1; // no shop_layout_* uses this value

function setTextGate(container, shown) {
    if (!container) return;
    setProbe(container, TEXT_GATE_SLOT, shown ? TEXT_GATE_SHOWN : TEXT_GATE_HIDDEN);
}

// Tick in which each player's inventory was last touched. The probe must
// survive at least one tick, otherwise the client sees no change.
const lastTouchTick = new Map();

// Step 2: make the client re-read slot names.
function touchPlayerInventory(player) {
    try {
        const inv = player?.getComponent("minecraft:inventory")?.container;
        if (!inv) return;
        for (let i = 0; i < inv.size; i++) {
            if (!inv.getItem(i)) {
                inv.setItem(i, new ItemStack(PROBE_ID, 1));
                const id = player.id;
                lastTouchTick.set(id, system.currentTick);
                // tickSession() removes it next tick; this is a safety net.
                system.runTimeout(() => clearProbeFromPlayer(findPlayer(id)), 3);
                return;
            }
        }
    } catch {}
}

// Step 3: run `apply` (the visibility flip) after the re-read happened.
// While pending, tickSession() ignores clicks (they are handled after).
function deferVisualCommit(player, rec, apply) {
    touchPlayerInventory(player);
    rec.pendingVisual = {
        due: system.currentTick + VISUAL_COMMIT_DELAY_TICKS,
        apply
    };
}

function scheduleTextGateOpen(player, rec) {
    touchPlayerInventory(player);
    const playerId = player.id;
    system.runTimeout(() => {
        try {
            if (active.get(playerId) !== rec) return;
            const block = resolve(rec);
            if (!block || block.typeId !== PANEL_ID) return;
            setTextGate(getContainer(block), true);
        } catch {}
    }, VISUAL_COMMIT_DELAY_TICKS);
}

const MAX_USED_SLOT = 53;
// ------------------------------------------------------------
// Text fields (54-slot container, no extra slots).
//
// DISPLAY: the UI reads the NAME of the hidden probe in a slot. The UI
// state logic only looks at stack COUNTS, so every probe name is free.
// Each channel = one slot = one text box on screen at a time. Fields that
// are never visible together (same section, different dropdown choice)
// share a channel. The name is the value itself: no packing, no slicing.
//
// CLICK: one dedicated slot per divider section (9..15, 50). No dropdown,
// toggle or +/- control uses these, so a text click can't be misread.
// ------------------------------------------------------------
const TEXT_CHANNELS = [{"slot": 9, "group": 0, "fields": ["shop_product_name"]}, {"slot": 10, "group": 0, "fields": ["shop_product_genre"]}, {"slot": 11, "group": 1, "fields": ["special_weekday_rate", "special_purchase_count", "special_time_start", "daily_time_start", "limited_period"]}, {"slot": 12, "group": 1, "fields": ["special_count_rate", "special_time_end", "daily_time_end", "limited_total_count"]}, {"slot": 13, "group": 1, "fields": ["special_time_rate", "limited_per_player_count"]}, {"slot": 33, "group": 3, "fields": ["price", "required_xp", "pay_row_1", "payment_shop_points", "payment_chain_points", "payment_custom_point_name"]}, {"slot": 34, "group": 3, "fields": ["pay_row_2", "payment_custom_points"]}, {"slot": 35, "group": 3, "fields": ["pay_row_3"]}, {"slot": 36, "group": 3, "fields": ["pay_row_4"]}, {"slot": 51, "group": 3, "fields": ["pay_row_5"]}, {"slot": 38, "group": 3, "fields": ["pay_row_6"]}, {"slot": 39, "group": 3, "fields": ["pay_row_7"]}, {"slot": 52, "group": 3, "fields": ["pay_row_8"]}, {"slot": 41, "group": 4, "fields": ["grant_shop_points", "grant_chain_points", "grant_custom_point_name"]}, {"slot": 42, "group": 4, "fields": ["grant_custom_points"]}, {"slot": 43, "group": 4, "fields": ["required_shop_total", "required_chain_total", "required_custom_point_name"]}, {"slot": 44, "group": 4, "fields": ["required_custom_total"]}, {"slot": 45, "group": 5, "fields": ["stock_count"]}, {"slot": 46, "group": 5, "fields": ["stock_replenish_time", "stock_replenish_seconds"]}, {"slot": 47, "group": 6, "fields": ["coupon_max_rate"]}, {"slot": 48, "group": 6, "fields": ["coupon_max_count"]}, {"slot": 49, "group": 7, "fields": ["buyer_message"]}, {"slot": 14, "group": 2, "fields": ["kuji_summary"]}, {"slot": 15, "group": 3, "fields": ["pay_icon_1"]}, {"slot": 26, "group": 3, "fields": ["pay_icon_2"]}, {"slot": 27, "group": 3, "fields": ["pay_icon_3"]}, {"slot": 28, "group": 3, "fields": ["pay_icon_4"]}, {"slot": 29, "group": 3, "fields": ["pay_icon_5"]}, {"slot": 30, "group": 3, "fields": ["pay_icon_6"]}, {"slot": 50, "group": 3, "fields": ["pay_icon_7"]}, {"slot": 53, "group": 3, "fields": ["pay_icon_8"]}];
const TEXT_INPUT_SIGNAL_SLOTS = [9, 10, 11, 12, 13, 14, 15, 49];
const FORM_OPEN_MAX_WAIT_TICKS = 100; // UserBusy retry window (~5s)
const ALL_TEXT_GROUPS = -1;
const TEXT_DISPLAY_MAX_WIDTH = 26; // half-width units that fit in the box

// 日配商品: 定番商品の通常設定に、曜日別販売時間と段階割引だけを上乗せする。
const DAILY_SUPPLY_PROP = "shop_daily_supply_schedule_v1";
const DAILY_SUPPLY_ACTION_SLOT = 31;
const DAILY_SUPPLY_DAYS = [
    { key: "mon", label: "月曜" },
    { key: "tue", label: "火曜" },
    { key: "wed", label: "水曜" },
    { key: "thu", label: "木曜" },
    { key: "fri", label: "金曜" },
    { key: "sat", label: "土曜" },
    { key: "sun", label: "日曜" }
];
const DAILY_SUPPLY_DISCOUNT_STEPS = 3;

// ------------------------------------------------------------
// TEMPORARY diagnostics: prints what the SCRIPT actually wrote into the
// slot names, so we can tell "wrong data" from "UI not refreshing".
// Set to false once the display is confirmed.
// ------------------------------------------------------------
const DEBUG_TEXT = false;

function debugTextSlots(player, block, tag) {
    if (!DEBUG_TEXT || !player || !block) return;
    try {
        const container = getContainer(block);
        if (!container) { tell(player, `§d[DBG ${tag}] コンテナなし`); return; }

        const draft = getTextDraft(block, false);
        const lines = [];
        for (const channel of TEXT_CHANNELS) {
            const visible = new Set(textFieldsForGroup(block, channel.group));
            const field = channel.fields.find(f =>
                f.startsWith("pay_row_")
                    ? visible.has(paymentPairNames(Number(f.slice(8)))[0])
                    : visible.has(f)
            );
            if (!field) continue;

            const item = container.getItem(channel.slot);
            const real = isProbe(item)
                ? `${JSON.stringify(item.nameTag ?? "(名前なし)")}[${item.typeId === PROBE_ID ? "A" : "B"}]`
                : (item ? item.typeId : "(空)");
            const expect = channelText(block, channel, visible);
            if (expect === PLACEHOLDER && item?.nameTag === PLACEHOLDER) continue;

            lines.push(`slot${channel.slot} ${field}: 実際=${real} 期待=${JSON.stringify(expect)}`);
        }

        tell(player, `§d[DBG ${tag}] 下書き${draft?.size ?? 0}件 / 入力済みの欄${lines.length}件`);
        for (const line of lines.slice(0, 8)) tell(player, "§d  " + line);
    } catch (e) {
        tell(player, `§d[DBG ${tag}] エラー: ${String(e)}`);
    }
}
const TEXT_INPUT_GROUP_NAMES = [
    "商品名・ジャンル",
    "商品タイプ関連",
    "販売内容",
    "支払い",
    "ポイント条件",
    "在庫",
    "クーポン",
    "購入者メッセージ"
];
const active = new Map();

// ============================================================
// Text bridge draft
//
// Form submit = temporary UI draft only.
// Final persistence = shop UI Save / normal close.
// UI Cancel = discard the temporary text draft.
// ============================================================
const textDrafts = new Map();

function textDraftKey(block) {
    if (!block) return "";
    return `${block.dimension.id}|${block.location.x}|${block.location.y}|${block.location.z}`;
}

function getTextDraft(block, create = false) {
    const key = textDraftKey(block);
    if (!key) return undefined;

    let draft = textDrafts.get(key);

    if (!draft && create) {
        draft = new Map();
        textDrafts.set(key, draft);
    }

    return draft;
}

function discardTextDraft(block) {
    const key = textDraftKey(block);
    if (key) textDrafts.delete(key);
}

function setPersistedStringProp(block, name, value) {
    try {
        const props = getProps(block);
        if (!props) return false;

        props.set(name, String(value ?? ""));
        return true;
    } catch {
        return false;
    }
}

function commitTextDraft(block) {
    const key = textDraftKey(block);
    if (!key) return 0;

    const draft = textDrafts.get(key);
    if (!draft || draft.size === 0) {
        textDrafts.delete(key);
        return 0;
    }

    let committed = 0;

    for (const [name, value] of draft.entries()) {
        if (setPersistedStringProp(block, name, value)) {
            committed++;
        }
    }

    textDrafts.delete(key);
    return committed;
}



function findPlayer(playerId) {
    return world.getAllPlayers().find(p => p.id === playerId);
}

function tell(player, text) {
    try { player?.sendMessage(text); } catch {}
}

// Never silently overwrite a real item that ended up in a signal slot
// (e.g. shift-clicked in while 9..15 were still empty in older versions).
function evictForeignItem(container, slot, block, player) {
    try {
        const item = container.getItem(slot);
        if (!item || isProbe(item)) return;

        container.setItem(slot, undefined);

        let rest = item;
        try {
            const inv = player?.getComponent("minecraft:inventory")?.container;
            if (inv) rest = inv.addItem(item);
        } catch {}

        if (rest) {
            const at = {
                x: block.location.x + 0.5,
                y: block.location.y + 1,
                z: block.location.z + 0.5
            };
            block.dimension.spawnItem(rest, at);
        }
    } catch {}
}

function textSignalExpectedAmount(block, slot) {
    return 1;
}

function armTextInputSignals(container, block, player) {
    for (const slot of TEXT_INPUT_SIGNAL_SLOTS) {
        evictForeignItem(container, slot, block, player);
        setProbe(container, slot, 1);
    }
    setProbe(container, ALL_TEXT_EDIT_SIGNAL_SLOT, 1);
}

// Returns group index, ALL_TEXT_GROUPS for the pencil, or null.
function findClickedTextSignal(container, block) {
    if (!isProbe(container.getItem(ALL_TEXT_EDIT_SIGNAL_SLOT))) {
        return ALL_TEXT_GROUPS;
    }
    for (let i = 0; i < TEXT_INPUT_SIGNAL_SLOTS.length; i++) {
        const slot = TEXT_INPUT_SIGNAL_SLOTS[i];
        if (!signalIntact(container, slot, textSignalExpectedAmount(block, slot))) {
            return i;
        }
    }
    return null;
}

function restoreTextSignal(container, block, groupIndex) {
    if (groupIndex === ALL_TEXT_GROUPS) {
        setProbe(container, ALL_TEXT_EDIT_SIGNAL_SLOT, 1);
        refreshTextDisplaySlot(block, container, ALL_TEXT_EDIT_SIGNAL_SLOT);
        return;
    }

    const slot = TEXT_INPUT_SIGNAL_SLOTS[groupIndex];

    setProbe(container, slot, 1);

    // The click consumed only this source stack.
    // Repair only this text channel, not every displayed string.
    refreshTextDisplaySlot(block, container, slot);
}


// Called from the tick loop once a text signal slot was clicked.
function openTextInput(player, rec, block, container, groupIndex) {
    // 1. Put the signal back FIRST, so the container captured by
    //    forceCloseScreen() is already clean when it is written back.
    restoreTextSignal(container, block, groupIndex);
    clearProbeFromPlayer(player);

    // 2. Leave the session. blockContainerClosed must NOT commit here.
    active.delete(player.id);

    const playerId = player.id;
    const opened = forceCloseScreen(player, block, () => {
        showTextInputForm(playerId, rec, groupIndex);
    });
    if (!opened) {
        // Keep the session (and its Cancel snapshot) alive.
        active.set(player.id, rec);
        tell(player, "§c[文字入力] 画面を閉じられませんでした。Escで閉じてから開き直してください");
        return;
    }

    // 3. The form opens from the callback above, right after the block is
    //    fully restored; UserBusy is then retried every tick.
}


function displayWidth(ch) {
    const cp = ch.codePointAt(0);
    return cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
}

function cleanText(value) {
    return String(value ?? "")
        .replace(/[\t\r\n]/g, " ")
        .replace(/§/g, "")
        .trim();
}

function fitWidth(text, maxWidth = TEXT_DISPLAY_MAX_WIDTH) {
    let out = "";
    let width = 0;
    for (const ch of text) {
        const w = displayWidth(ch);
        if (width + w > maxWidth - 1) return out + "…";
        out += ch;
        width += w;
    }
    return out;
}

const PLACEHOLDER = "§7未入力";

// Text for one channel, given the fields currently visible in its section.
// Payment item icons (v45): the probe NAME is a texture path, read by an
// image in the UI ("#texture"). Empty -> transparent, unknown id -> the
// unknown-block icon, so the owner can see whether the id was recognised.
const PAY_ICON_CLEAR = "textures/shopuilook2/items/decision_probe_clear_v2";
const PAY_ROW_TEXT_WIDTH = 22; // text leaves room for the icon on the right

function payIconPath(block, n, visible) {
    const [itemName] = paymentPairNames(n);
    if (!visible.has(itemName)) return PAY_ICON_CLEAR;
    const id = normalizeItemId(getStringProp(block, itemName, ""));
    if (!id) return PAY_ICON_CLEAR;
    return isKnownItemId(id) ? itemIconPath(id) : SHOP_ICON_UNKNOWN;
}

function channelText(block, channel, visible) {
    if (channel.fields[0].startsWith("pay_icon_")) {
        return payIconPath(block, Number(channel.fields[0].slice(9)), visible);
    }
    for (const field of channel.fields) {
        if (field.startsWith("pay_row_")) {
            const [itemName, countName] = paymentPairNames(Number(field.slice(8)));
            if (!visible.has(itemName)) continue;

            const rawItem = cleanText(getStringProp(block, itemName, ""));
            const itemId = normalizeItemId(rawItem);
            // known id -> Japanese name ("ダイヤモンド"); otherwise as typed
            const item = itemId && isKnownItemId(itemId) ? jaItemName(itemId) : rawItem.replace(/^minecraft:/, "");
            const count = cleanText(getStringProp(block, countName, ""));
            if (!item && !count) return PLACEHOLDER;
            if (!count) return fitWidth(item, PAY_ROW_TEXT_WIDTH);
            // Keep the "×count" part visible even for long names.
            const suffix = ` ×${count}`;
            let head = "";
            let width = 0;
            for (const ch of suffix) width += displayWidth(ch);
            for (const ch of item || "未入力") {
                const w = displayWidth(ch);
                if (width + w > PAY_ROW_TEXT_WIDTH - 1) { head += "…"; break; }
                head += ch;
                width += w;
            }
            return head + suffix;
        }

        if (field === KUJI_SUMMARY_FIELD) {
            if (!visible.has(field)) continue;
            return kujiSummaryText(block);
        }

        if (visible.has(field)) {
            const text = cleanText(getStringProp(block, field, ""));
            return text ? fitWidth(formatFieldDisplay(field, text)) : PLACEHOLDER;
        }
    }
    return PLACEHOLDER; // box is hidden right now
}

// Writes each channel's text into the NAME of the probe already in its
// slot. Stack counts (the UI state) are never touched here.
function writeTextChannel(block, container, channel, visible) {
    if (!block || !container || !channel) return false;

    const item = container.getItem(channel.slot);
    if (!isProbe(item)) return false;

    const wanted = channelText(block, channel, visible);

    if (item.nameTag === wanted && item.typeId === PROBE_ID) {
        return false;
    }

    // Keep the current state amount. Only repair this channel's name.
    const probe = new ItemStack(PROBE_ID, item.amount);
    probe.nameTag = wanted;
    container.setItem(channel.slot, probe);
    return true;
}

function refreshTextDisplaySlot(block, container, slot) {
    if (!block || !container || container.size <= MAX_USED_SLOT) return;

    for (const channel of TEXT_CHANNELS) {
        if (channel.slot !== slot) continue;

        const visible = new Set(textFieldsForGroup(block, channel.group));
        writeTextChannel(block, container, channel, visible);
        return;
    }
}

function refreshTextDisplaySlots(block, container, slots) {
    if (!Array.isArray(slots)) return;

    const unique = new Set(slots);
    for (const slot of unique) {
        refreshTextDisplaySlot(block, container, slot);
    }
}

function refreshTextDisplayGroup(block, container, groupIndex) {
    if (!block || !container || container.size <= MAX_USED_SLOT) return;

    const visible = new Set(textFieldsForGroup(block, groupIndex));

    for (const channel of TEXT_CHANNELS) {
        if (channel.group !== groupIndex) continue;
        writeTextChannel(block, container, channel, visible);
    }
}

// Full refresh is reserved for initial arm / form reflection.
// Normal dropdown/button operations use the targeted helpers above.
function refreshTextDisplayPayloads(block, container) {
    if (!block || !container || container.size <= MAX_USED_SLOT) return;
    if (storeModeBlocks.has(blockKey(block))) return;
    if (!getCurrentProduct(block) && loadProductIndex(block) !== undefined && getProps(block)?.get(PRODUCT_INDEX_PROP) !== undefined) return;
    if (getPersistedNumberProp(block, KUJI_EDITING_PROP, 0) === 1) return;

    const visibleByGroup = new Map();

    for (const channel of TEXT_CHANNELS) {
        let visible = visibleByGroup.get(channel.group);
        if (!visible) {
            visible = new Set(textFieldsForGroup(block, channel.group));
            visibleByGroup.set(channel.group, visible);
        }

        writeTextChannel(block, container, channel, visible);
    }
}

function textGroupForDropdownId(id) {
    if (
        id === "product_type"
        || id === "discount_condition"
        || id === "discount_time_type"
        || id === "daily_time_type"
    ) return 1;

    if (id === "sale_type") return 2;

    if (
        id === "payment_method"
        || id === "payment_point_type"
    ) return 3;

    if (
        id === "grant_point_type"
        || id === "required_point_type"
    ) return 4;

    if (id === "stock_replenish") return 5;

    return -1;
}


const TEXT_FIELD_DEFS = {"shop_product_name":{"label":"商品名","max":32},"shop_product_genre":{"label":"商品ジャンル","max":32},"special_weekday_rate":{"label":"曜日割引率","max":8},"special_purchase_count":{"label":"購入回数（N回目ごとに割引）","max":8},"special_count_rate":{"label":"回数割引率","max":8},"special_time_start":{"label":"特売 開始時間","max":16},"special_time_end":{"label":"特売 終了時間","max":16},"special_time_rate":{"label":"時間割引率","max":8},"daily_time_start":{"label":"日替わり 開始時間","max":16},"daily_time_end":{"label":"日替わり 終了時間","max":16},"limited_period":{"label":"販売期間（開始日～終了日）","max":23},"limited_total_count":{"label":"販売総数","max":12},"limited_per_player_count":{"label":"1人あたり購入上限","max":8},"single_item":{"label":"販売アイテム","max":64},"single_count":{"label":"個数","max":8},"multi_item":{"label":"複数販売 アイテム 1","max":64},"multi_count":{"label":"複数販売 個数 1","max":8},"multi_item_2":{"label":"複数販売 アイテム 2","max":64},"multi_count_2":{"label":"複数販売 個数 2","max":8},"multi_item_3":{"label":"複数販売 アイテム 3","max":64},"multi_count_3":{"label":"複数販売 個数 3","max":8},"multi_item_4":{"label":"複数販売 アイテム 4","max":64},"multi_count_4":{"label":"複数販売 個数 4","max":8},"multi_item_5":{"label":"複数販売 アイテム 5","max":64},"multi_count_5":{"label":"複数販売 個数 5","max":8},"multi_item_6":{"label":"複数販売 アイテム 6","max":64},"multi_count_6":{"label":"複数販売 個数 6","max":8},"multi_item_7":{"label":"複数販売 アイテム 7","max":64},"multi_count_7":{"label":"複数販売 個数 7","max":8},"multi_item_8":{"label":"複数販売 アイテム 8","max":64},"multi_count_8":{"label":"複数販売 個数 8","max":8},"random_item":{"label":"ランダム販売 アイテム 1","max":64},"random_count":{"label":"ランダム販売 個数 1","max":8},"random_item_2":{"label":"ランダム販売 アイテム 2","max":64},"random_count_2":{"label":"ランダム販売 個数 2","max":8},"random_item_3":{"label":"ランダム販売 アイテム 3","max":64},"random_count_3":{"label":"ランダム販売 個数 3","max":8},"random_item_4":{"label":"ランダム販売 アイテム 4","max":64},"random_count_4":{"label":"ランダム販売 個数 4","max":8},"random_item_5":{"label":"ランダム販売 アイテム 5","max":64},"random_count_5":{"label":"ランダム販売 個数 5","max":8},"random_item_6":{"label":"ランダム販売 アイテム 6","max":64},"random_count_6":{"label":"ランダム販売 個数 6","max":8},"random_item_7":{"label":"ランダム販売 アイテム 7","max":64},"random_count_7":{"label":"ランダム販売 個数 7","max":8},"random_item_8":{"label":"ランダム販売 アイテム 8","max":64},"random_count_8":{"label":"ランダム販売 個数 8","max":8},"bonus_count":{"label":"おまけ個数","max":8},"price":{"label":"価格","max":16},"required_xp":{"label":"消費経験値","max":16},"required_item":{"label":"必要アイテム 1：アイテムID","max":64},"required_item_count":{"label":"必要アイテム 1：数","max":8},"payment_required_item_2":{"label":"必要アイテム 2：アイテムID","max":64},"payment_required_count_2":{"label":"必要アイテム 2：数","max":8},"payment_required_item_3":{"label":"必要アイテム 3：アイテムID","max":64},"payment_required_count_3":{"label":"必要アイテム 3：数","max":8},"payment_required_item_4":{"label":"必要アイテム 4：アイテムID","max":64},"payment_required_count_4":{"label":"必要アイテム 4：数","max":8},"payment_required_item_5":{"label":"必要アイテム 5：アイテムID","max":64},"payment_required_count_5":{"label":"必要アイテム 5：数","max":8},"payment_required_item_6":{"label":"必要アイテム 6：アイテムID","max":64},"payment_required_count_6":{"label":"必要アイテム 6：数","max":8},"payment_required_item_7":{"label":"必要アイテム 7：アイテムID","max":64},"payment_required_count_7":{"label":"必要アイテム 7：数","max":8},"payment_required_item_8":{"label":"必要アイテム 8：アイテムID","max":64},"payment_required_count_8":{"label":"必要アイテム 8：数","max":8},"payment_shop_points":{"label":"必要ショップポイント","max":16},"payment_chain_points":{"label":"必要チェーンポイント","max":16},"payment_custom_point_name":{"label":"支払いポイント名","max":32},"payment_custom_points":{"label":"必要カスタムポイント","max":16},"grant_shop_points":{"label":"獲得ショップポイント","max":16},"grant_chain_points":{"label":"獲得チェーンポイント","max":16},"grant_custom_point_name":{"label":"獲得ポイント名","max":32},"grant_custom_points":{"label":"獲得カスタムポイント","max":16},"required_shop_total":{"label":"必要累計ショップポイント","max":16},"required_chain_total":{"label":"必要累計チェーンポイント","max":16},"required_custom_point_name":{"label":"条件ポイント名","max":32},"required_custom_total":{"label":"必要累計カスタムポイント","max":16},"stock_count":{"label":"販売在庫数","max":12},"stock_replenish_time":{"label":"在庫補充時間（分・30分ごと）","max":16},"stock_replenish_seconds":{"label":"在庫補充秒数（秒・15秒ごと）","max":16},"coupon_max_rate":{"label":"クーポン最大割引率","max":8},"coupon_max_count":{"label":"クーポン最大使用枚数","max":8},"buyer_message":{"label":"購入者メッセージ","max":256}};
const TEXT_FIELD_NAMES = ["shop_product_name","shop_product_genre","special_weekday_rate","special_purchase_count","special_count_rate","special_time_start","special_time_end","special_time_rate","daily_time_start","daily_time_end","limited_period","limited_total_count","limited_per_player_count","single_item","single_count","multi_item","multi_count","multi_item_2","multi_count_2","multi_item_3","multi_count_3","multi_item_4","multi_count_4","multi_item_5","multi_count_5","multi_item_6","multi_count_6","multi_item_7","multi_count_7","multi_item_8","multi_count_8","random_item","random_count","random_item_2","random_count_2","random_item_3","random_count_3","random_item_4","random_count_4","random_item_5","random_count_5","random_item_6","random_count_6","random_item_7","random_count_7","random_item_8","random_count_8","bonus_count","price","required_xp","required_item","required_item_count","payment_required_item_2","payment_required_count_2","payment_required_item_3","payment_required_count_3","payment_required_item_4","payment_required_count_4","payment_required_item_5","payment_required_count_5","payment_required_item_6","payment_required_count_6","payment_required_item_7","payment_required_count_7","payment_required_item_8","payment_required_count_8","payment_shop_points","payment_chain_points","payment_custom_point_name","payment_custom_points","grant_shop_points","grant_chain_points","grant_custom_point_name","grant_custom_points","required_shop_total","required_chain_total","required_custom_point_name","required_custom_total","stock_count","stock_replenish_time","stock_replenish_seconds","coupon_max_rate","coupon_max_count","buyer_message"];


// ============================================================
// Form input kinds (v29)
//   text   : textField
//   number : slider(min..max)                 stored as "n"
//   time   : 2 sliders (時 0-23 / 分 0-59)      stored as "HH:MM"
//   item   : textField, validated item id     stored as "minecraft:xxx"
//   integer: textField, digits only (min..max) stored as "n"
// ============================================================
// Every number accepts 0. 0 = that feature is OFF (purchase logic must skip it).
const POINT_SLIDER = { kind: "number", min: 0, max: 500 };
const RATE_SLIDER = { kind: "number", min: 0, max: 100 };
const ITEM_COUNT_SLIDER = { kind: "number", min: 0, max: 64 };

const FIELD_INPUTS = {
    special_weekday_rate: RATE_SLIDER,
    special_count_rate: RATE_SLIDER,
    special_time_rate: RATE_SLIDER,
    special_time_start: { kind: "time", timeType: "discount_time_type" },
    special_time_end: { kind: "time", timeType: "discount_time_type" },
    daily_time_start: { kind: "time", timeType: "daily_time_type" },
    daily_time_end: { kind: "time", timeType: "daily_time_type" },
    limited_period: { kind: "date_range" },
    limited_total_count: { kind: "integer", min: 0, max: 999999 },
    limited_per_player_count: { kind: "integer", min: 0, max: 9999 },

    payment_shop_points: POINT_SLIDER,
    payment_chain_points: POINT_SLIDER,
    payment_custom_points: POINT_SLIDER,
    grant_shop_points: POINT_SLIDER,
    grant_chain_points: POINT_SLIDER,
    grant_custom_points: POINT_SLIDER,
    required_shop_total: POINT_SLIDER,
    required_chain_total: POINT_SLIDER,
    required_custom_total: POINT_SLIDER,

    stock_count: { kind: "number", min: 0, max: 64 },

    price: { kind: "integer", min: 0, max: 999999999 },
    // 割引条件「購入回数」: N回目, 2N回目, ... の購入のときだけ割引
    // (purchase logic: per-player count; discount when (count + 1) % N === 0)
    special_purchase_count: { kind: "integer", min: 0, max: 9999 },
    required_xp: { kind: "number", min: 0, max: 100 },
    // 一定時間で: every N minutes (30-minute steps, up to 12 hours)
    stock_replenish_time: { kind: "number", min: 0, max: 720, step: 30, format: "duration" },
    // 秒数ごとに: every N seconds (15-second steps, up to 900 s)
    stock_replenish_seconds: { kind: "number", min: 0, max: 900, step: 15, format: "seconds" },
    coupon_max_rate: { kind: "number", min: 0, max: 100 },
    coupon_max_count: { kind: "number", min: 0, max: 10 }
};
for (let i = 1; i <= 8; i++) {
    const [itemName, countName] = paymentPairNames(i);
    FIELD_INPUTS[itemName] = { kind: "item" };
    FIELD_INPUTS[countName] = ITEM_COUNT_SLIDER;
}

// How a stored value is shown on the shop screen.
function formatFieldDisplay(name, text) {
    const spec = FIELD_INPUTS[name];
    const n = Number.parseInt(text, 10);
    if ((spec?.kind === "number" || spec?.kind === "integer") && n === 0 && /^\s*0+\s*$/.test(text)) {
        return "0（無効）";
    }
    if (!spec?.format || !Number.isFinite(n)) return text;
    if (spec.format === "duration") {
        const h = Math.floor(n / 60), m = n % 60;
        if (h && m) return `${h}時間${m}分`;
        return h ? `${h}時間` : `${m}分`;
    }
    if (spec.format === "seconds") return `${n}秒`;
    return text;
}

function fieldInput(name) {
    return FIELD_INPUTS[name] ?? { kind: "text" };
}

// "12:30" / "1230" / "12" -> minutes of day, or undefined
function parseClock(text) {
    const m = String(text ?? "").trim().match(/^(\d{1,2})(?::|：)?(\d{2})?$/);
    if (!m) return undefined;
    const h = Number(m[1]);
    const min = m[2] === undefined ? 0 : Number(m[2]);
    if (h > 23 || min > 59) return undefined;
    return h * 60 + min;
}

function formatClock(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeLimitedPeriod(text) {
    const raw = String(text ?? "")
        .trim()
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/[／]/g, "/");
    if (!raw) return "";

    const m = raw.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})\s*[～~]\s*(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})$/);
    if (!m) return undefined;

    const parts = m.slice(1).map(Number);
    const validDate = (y, mo, d) => {
        const dt = new Date(Date.UTC(y, mo - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    };
    if (!validDate(parts[0], parts[1], parts[2]) || !validDate(parts[3], parts[4], parts[5])) return undefined;

    const start = `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
    const end = `${String(parts[3]).padStart(4, "0")}-${String(parts[4]).padStart(2, "0")}-${String(parts[5]).padStart(2, "0")}`;
    if (start > end) return undefined;
    return `${start}～${end}`;
}

// Minecraft day: tick 0 = 06:00, 1000 ticks per hour, 24000 per day.
function clockToMinecraftTicks(minutes) {
    return (Math.round(minutes * 1000 / 60) + 18000) % 24000;
}

// For purchase logic: how a time field should be read.
//   { minutes, text, kind: "minecraft" | "real", ticks }
//   ticks is set only for Minecraft time (compare with world.getTimeOfDay()).
function getShopTime(block, field) {
    const spec = fieldInput(field);
    const minutes = parseClock(getStringProp(block, field, ""));
    if (minutes === undefined) return undefined;
    // time-type dropdowns: 0 = 現実時間, 1 = マイクラ世界時間
    const isMinecraft = spec.timeType
        ? getChoiceById(block, spec.timeType) === 1
        : false;
    return {
        minutes,
        text: formatClock(minutes),
        kind: isMinecraft ? "minecraft" : "real",
        ticks: isMinecraft ? clockToMinecraftTicks(minutes) : undefined
    };
}

// Japanese name for an item id (via the game's localization key);
// falls back to the id without "minecraft:" when unknown.
const jaNameCache = new Map();
function jaItemName(id) {
    if (jaNameCache.has(id)) return jaNameCache.get(id);
    let name;
    try {
        const key = new ItemStack(id, 1).localizationKey;
        name = JA_ITEM_NAMES[key];
    } catch {}
    name = name ?? String(id).replace(/^minecraft:/, "");
    jaNameCache.set(id, name);
    return name;
}

function normalizeItemId(text) {
    const raw = String(text ?? "").trim().toLowerCase();
    if (!raw) return "";
    return raw.includes(":") ? raw : `minecraft:${raw}`;
}

function isKnownItemId(id) {
    try { return !!ItemTypes.get(id); } catch { return false; }
}

function heldItemId(player) {
    try {
        const inv = player?.getComponent("minecraft:inventory")?.container;
        const item = inv?.getItem(player.selectedSlotIndex);
        if (item && !isProbe(item)) return item.typeId;
    } catch {}
    return "";
}

function getStringProp(block, name, fallback = "") {
    // Temporary form input has priority while the shop is being edited.
    const draft = getTextDraft(block, false);
    if (draft?.has(name)) {
        return String(draft.get(name) ?? "");
    }

    try {
        const props = getProps(block);
        if (!props) return fallback;

        const raw = props.get(name);
        return typeof raw === "string" ? raw : fallback;
    } catch {
        return fallback;
    }
}

function setStringProp(block, name, value) {
    try {
        const draft = getTextDraft(block, true);
        if (!draft) return false;

        draft.set(name, String(value ?? ""));
        return true;
    } catch {
        return false;
    }
}

function pairNames(prefix, i) {
    if (i === 1) return [prefix + "_item", prefix + "_count"];
    return [prefix + "_item_" + i, prefix + "_count_" + i];
}

function paymentPairNames(i) {
    if (i === 1) return ["required_item", "required_item_count"];
    return ["payment_required_item_" + i, "payment_required_count_" + i];
}


function saleContentTextFields(block) {
    // v22: 単数・複数 are defined by the sample slots (item + stack size),
    // so there are no count fields. くじ gets its own form (next step).
    // v24: no text fields here any more (おまけ個数 removed).
    // v33: くじ shows a summary box; clicking it opens the くじ editor.
    return getChoiceById(block, "sale_type") === 2 ? [KUJI_SUMMARY_FIELD] : [];
}

function textFieldsForGroup(block, groupIndex) {
    // 固定エリア: 商品名・ジャンル
    if (groupIndex === 0) {
        return ["shop_product_name", "shop_product_genre"];
    }

    // 区切り線1まで: 商品タイプ関連
    if (groupIndex === 1) {
        const productType = getChoiceById(block, "product_type");

        if (productType === 1) {
            const condition = getChoiceById(block, "discount_condition");
            if (condition === 0) return ["special_weekday_rate"];
            if (condition === 1) return ["special_purchase_count", "special_count_rate"];
            if (condition === 2) {
                return ["special_time_start", "special_time_end", "special_time_rate"];
            }
        }

        if (productType === 2) {
            return ["limited_period", "limited_total_count", "limited_per_player_count"];
        }

        if (productType === 3) {
            return ["daily_time_start", "daily_time_end"];
        }

        return [];
    }

    // 区切り線1〜2: 販売内容
    if (groupIndex === 2) {
        return saleContentTextFields(block);
    }

    // 区切り線2〜3: 支払い
    if (groupIndex === 3) {
        const method = getChoiceById(block, "payment_method");
        const result = [];

        if (method === 0) {
            result.push("price");
        } else if (method === 1) {
            result.push("required_xp");
        } else if (method === 2) {
            const rows = getPaymentItemRowCount(block);
            for (let i = 1; i <= rows; i++) result.push(...paymentPairNames(i));
        } else if (method === 3) {
            const pointType = getChoiceById(block, "payment_point_type");
            if (pointType === 0) result.push("payment_shop_points");
            else if (pointType === 1) result.push("payment_chain_points");
            else result.push("payment_custom_point_name", "payment_custom_points");
        }

        return result;
    }

    // 区切り線3〜4: ポイント条件
    if (groupIndex === 4) {
        const result = [];

        const grant = getChoiceById(block, "grant_point_type");
        if (grant === 0) result.push("grant_shop_points");
        else if (grant === 1) result.push("grant_chain_points");
        else result.push("grant_custom_point_name", "grant_custom_points");

        const required = getChoiceById(block, "required_point_type");
        if (required === 0) result.push("required_shop_total");
        else if (required === 1) result.push("required_chain_total");
        else result.push("required_custom_point_name", "required_custom_total");

        return result;
    }

    // 区切り線4〜5: 在庫
    if (groupIndex === 5) {
        const result = ["stock_count"];
        const replenish = getChoiceById(block, "stock_replenish");

        if (replenish === 1) result.push("stock_replenish_time");
        if (replenish === 3) result.push("stock_replenish_seconds");

        return result;
    }

    // 区切り線5〜6: クーポン
    if (groupIndex === 6) {
        return ["coupon_max_rate", "coupon_max_count"];
    }

    // 最後の区切り線より下: 購入者メッセージ
    if (groupIndex === 7) {
        return ["buyer_message"];
    }

    return [];
}


function allCurrentTextFields(block) {
    const result = [];
    const seen = new Set();

    for (let groupIndex = 0; groupIndex < TEXT_INPUT_GROUP_NAMES.length; groupIndex++) {
        for (const name of textFieldsForGroup(block, groupIndex)) {
            if (!TEXT_FIELD_DEFS[name] || seen.has(name)) continue;
            seen.add(name);
            result.push({ name, groupIndex });
        }
    }

    return result;
}

// Builds the form and remembers the element index of every text field.
// server-ui 2.x may return formValues with an entry for EVERY element
// (label/divider -> undefined). Indexing by "n-th text field" then shifts
// every value onto the wrong field, which showed up as "未入力" in the UI.
function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function buildTextInputForm(block, groupIndex, player) {
    const isAll = groupIndex === ALL_TEXT_GROUPS;

    const entries = isAll
        ? allCurrentTextFields(block)
        : textFieldsForGroup(block, groupIndex)
            .filter(name => TEXT_FIELD_DEFS[name])
            .map(name => ({ name, groupIndex }));

    if (entries.length === 0) return undefined;

    const title = isAll
        ? "文字入力（一括編集）"
        : (TEXT_INPUT_GROUP_NAMES[groupIndex] ?? "文字入力");

    const form = new ModalFormData().title(title);
    // server-ui may return formValues for EVERY element (labels/dividers
    // as undefined) or only for inputs: track both indices.
    let elementCount = 0;
    let inputCount = 0;
    const addInput = (entry) => {
        entry.elements.push(elementCount++);
        entry.inputs.push(inputCount++);
    };
    let lastGroup = null;
    // Only the FIRST empty item-id field gets the held item as a default;
    // otherwise submitting unchanged would fill every empty row with it.
    let heldItemOffered = false;

    for (const entry of entries) {
        entry.elements = [];
        entry.inputs = [];

        if (isAll && entry.groupIndex !== lastGroup) {
            if (lastGroup !== null) {
                form.divider();
                elementCount++;
            }
            form.label(`§e${TEXT_INPUT_GROUP_NAMES[entry.groupIndex]}`);
            elementCount++;
            lastGroup = entry.groupIndex;
        }

        const def = TEXT_FIELD_DEFS[entry.name];
        const spec = fieldInput(entry.name);
        const stored = getStringProp(block, entry.name, "");
        entry.kind = spec.kind;

        if (spec.kind === "number") {
            const step = spec.step ?? 1;
            let current = clampInt(stored, spec.min, spec.max, spec.min);
            current = spec.min + Math.round((current - spec.min) / step) * step;
            form.slider(`${def.label}`, spec.min, spec.max, {
                valueStep: step,
                defaultValue: Math.min(spec.max, current)
            });
            addInput(entry);
        } else if (spec.kind === "date_range") {
            form.textField(def.label, "例: 2026-10-07～2026-10-31", { defaultValue: stored });
            addInput(entry);
        } else if (spec.kind === "integer") {
            form.textField(def.label, "数字で入力", { defaultValue: stored });
            addInput(entry);
        } else if (spec.kind === "time") {
            const minutes = parseClock(stored) ?? 0;
            const typeName = spec.timeType
                ? (getChoiceById(block, spec.timeType) === 1 ? "マイクラ時間" : "現実時間")
                : "";
            const suffix = typeName ? `（${typeName}）` : "";
            form.slider(`${def.label}${suffix} 時`, 0, 23, {
                valueStep: 1, defaultValue: Math.floor(minutes / 60)
            });
            addInput(entry);
            form.slider(`${def.label}${suffix} 分`, 0, 59, {
                valueStep: 1, defaultValue: minutes % 60
            });
            addInput(entry);
        } else if (spec.kind === "item") {
            let current = stored;
            if (!current && !heldItemOffered) {
                current = heldItemId(player);
                heldItemOffered = true;
            }
            form.textField(def.label, "例: diamond", { defaultValue: current });
            addInput(entry);
        } else {
            form.textField(def.label, "未入力", { defaultValue: stored });
            addInput(entry);
        }
    }

    form.submitButton("UIへ反映");
    return { form, entries, elementCount, inputCount, title };
}

// Returns, per entry, the raw values of its controls (1 or 2).
function readTextFieldValues(result, built) {
    const values = result.formValues ?? [];
    const byElement =
        values.length === built.elementCount
        && built.elementCount !== built.inputCount;

    return built.entries.map((entry) =>
        (byElement ? entry.elements : entry.inputs).map((i) => values[i])
    );
}

function applyTextFormResult(player, rec, built, result) {
    const target = resolve(rec);
    if (!target || target.typeId !== PANEL_ID) {
        tell(player, "§c[文字入力] 反映先のショップが見つかりません");
        return;
    }

    const values = readTextFieldValues(result, built);
    let applied = 0;
    const errors = [];

    built.entries.forEach((entry, i) => {
        const raw = values[i];
        const def = TEXT_FIELD_DEFS[entry.name];
        const spec = fieldInput(entry.name);
        let value;

        // Never clobber a stored value with a misaligned / missing entry.
        if (spec.kind === "number") {
            if (typeof raw[0] !== "number") return;
            value = String(Math.round(raw[0]));
        } else if (spec.kind === "time") {
            if (typeof raw[0] !== "number" || typeof raw[1] !== "number") return;
            value = formatClock(Math.round(raw[0]) * 60 + Math.round(raw[1]));
        } else if (spec.kind === "date_range") {
            if (typeof raw[0] !== "string") return;
            value = normalizeLimitedPeriod(raw[0]);
            if (value === undefined) {
                errors.push(`${def.label}「${raw[0]}」は 2026-10-07～2026-10-31 の形式で、開始日≦終了日にしてください`);
                return;
            }
        } else if (spec.kind === "integer") {
            if (typeof raw[0] !== "string") return;
            const text = raw[0].trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            if (text === "") {
                value = "";
            } else if (!/^\d+$/.test(text) || Number(text) < spec.min || Number(text) > spec.max) {
                errors.push(`${def.label}「${raw[0]}」は${spec.min}以上の数字で入力してください`);
                return; // keep the previous value
            } else {
                value = String(Number(text));
            }
        } else if (spec.kind === "item") {
            if (typeof raw[0] !== "string") return;
            value = normalizeItemId(raw[0]);
            if (value && !isKnownItemId(value)) {
                errors.push(`${def.label}「${raw[0]}」は存在しないアイテムIDです`);
                return; // keep the previous value
            }
        } else {
            if (typeof raw[0] !== "string") return;
            value = raw[0].slice(0, Math.max(1, def.max ?? 256));
        }

        setStringProp(target, entry.name, value);
        applied++;
    });

    for (const message of errors) tell(player, `§c[文字入力] ${message}`);

    // Write the new payload into the container NOW, so the very first frame
    // of the reopened shop already shows the new text.
    refreshTextDisplayPayloads(target, getContainer(target));
    debugTextSlots(player, target, "フォーム反映直後");

    tell(
        player,
        `§a[文字入力] ${built.title}: ${applied}項目を反映しました §7（ショップを開くと表示／保存で確定）`
    );
}

function showTextInputForm(playerId, rec, groupIndex, firstTick = system.currentTick, errors = 0) {
    const player = findPlayer(playerId);
    if (!player) return;

    const block = resolve(rec);
    if (!block || block.typeId !== PANEL_ID) {
        tell(player, "§c[文字入力] ショップブロックを取得できませんでした");
        return;
    }

    if (groupIndex === 2 && getChoiceById(block, "sale_type") === 2) {
        startKujiEditor(player, rec, block);
        return;
    }

    const built = buildTextInputForm(block, groupIndex, player);
    if (!built) {
        const name = groupIndex === ALL_TEXT_GROUPS
            ? "一括編集"
            : TEXT_INPUT_GROUP_NAMES[groupIndex];
        tell(player, `§7[文字入力] ${name}: 現在の設定では入力項目がありません`);
        return;
    }

    const retry = (nextErrors) => {
        if (system.currentTick - firstTick >= FORM_OPEN_MAX_WAIT_TICKS) {
            tell(player, "§c[文字入力] フォームを表示できませんでした（画面がビジー）");
            return;
        }
        system.run(() => showTextInputForm(playerId, rec, groupIndex, firstTick, nextErrors));
    };

    let promise;
    try {
        promise = built.form.show(player);
    } catch (error) {
        if (errors < 3) { retry(errors + 1); return; }
        tell(player, `§c[文字入力] フォーム表示失敗: ${String(error)}`);
        return;
    }

    promise.then(result => {
        if (result.canceled) {
            // The shop screen is still closing on the client: try next tick.
            if (result.cancelationReason === FormCancelationReason.UserBusy) {
                retry(errors);
                return;
            }
            tell(player, `§7[文字入力] ${built.title} をキャンセルしました`);
            return;
        }

        applyTextFormResult(player, rec, built, result);
    }).catch(error => {
        if (errors < 3) { retry(errors + 1); return; }
        tell(player, `§c[文字入力] フォーム表示失敗: ${String(error)}`);
    });
}


// ============================================================
// 日配商品設定
// 定番商品と同じ通常設定を使い、以下だけを追加:
//   - 月〜日の販売開始/終了時刻
//   - 共通の時間帯割引（最大3段階）
// 空欄の曜日は販売しない。割引率0/空欄はその段階を無効にする。
// ============================================================

function emptyDailySupplySettings() {
    const days = {};
    for (const day of DAILY_SUPPLY_DAYS) {
        days[day.key] = { start: "", end: "" };
    }
    return {
        version: 1,
        timeBasis: "real",
        days,
        discounts: Array.from(
            { length: DAILY_SUPPLY_DISCOUNT_STEPS },
            () => ({ time: "", rate: 0 })
        )
    };
}

function readDailySupplySettings(block) {
    const fallback = emptyDailySupplySettings();
    const raw = getStringProp(block, DAILY_SUPPLY_PROP, "");
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        const out = emptyDailySupplySettings();

        for (const day of DAILY_SUPPLY_DAYS) {
            const src = parsed?.days?.[day.key];
            if (!src || typeof src !== "object") continue;
            out.days[day.key] = {
                start: typeof src.start === "string" ? src.start : "",
                end: typeof src.end === "string" ? src.end : ""
            };
        }

        if (Array.isArray(parsed?.discounts)) {
            for (let i = 0; i < DAILY_SUPPLY_DISCOUNT_STEPS; i++) {
                const src = parsed.discounts[i];
                if (!src || typeof src !== "object") continue;
                out.discounts[i] = {
                    time: typeof src.time === "string" ? src.time : "",
                    rate: Number.isFinite(Number(src.rate))
                        ? Math.max(0, Math.min(100, Math.trunc(Number(src.rate))))
                        : 0
                };
            }
        }

        return out;
    } catch {
        return fallback;
    }
}

function normalizeDailySupplyClock(raw) {
    const text = String(raw ?? "")
        .trim()
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/：/g, ":");

    if (!text) return "";
    const minutes = parseClock(text);
    if (minutes === undefined) return undefined;
    return formatClock(minutes);
}

function normalizeDailySupplyRate(raw) {
    const text = String(raw ?? "")
        .trim()
        .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

    if (!text) return 0;
    if (!/^\d+$/.test(text)) return undefined;

    const value = Number(text);
    if (!Number.isInteger(value) || value < 0 || value > 100) return undefined;
    return value;
}

function dailySupplyFormSeed(settings) {
    const values = [];
    for (const day of DAILY_SUPPLY_DAYS) {
        values.push(settings.days[day.key].start ?? "");
        values.push(settings.days[day.key].end ?? "");
    }
    for (let i = 0; i < DAILY_SUPPLY_DISCOUNT_STEPS; i++) {
        const rule = settings.discounts[i] ?? { time: "", rate: 0 };
        values.push(rule.time ?? "");
        values.push(rule.rate ? String(rule.rate) : "");
    }
    return values;
}

function buildDailySupplySettingsForm(block, seedValues) {
    const settings = readDailySupplySettings(block);
    const defaults = Array.isArray(seedValues)
        ? seedValues.map(v => String(v ?? ""))
        : dailySupplyFormSeed(settings);

    const form = new ModalFormData().title("日配商品設定");
    let n = 0;

    for (const day of DAILY_SUPPLY_DAYS) {
        form.textField(
            `${day.label} 販売開始`,
            "例: 10:00（開始/終了を空欄でその曜日は販売しない）",
            { defaultValue: defaults[n++] ?? "" }
        );
        form.textField(
            `${day.label} 販売終了`,
            "例: 21:00",
            { defaultValue: defaults[n++] ?? "" }
        );
    }

    for (let i = 0; i < DAILY_SUPPLY_DISCOUNT_STEPS; i++) {
        form.textField(
            `割引${i + 1} 開始時刻`,
            "例: 18:00（空欄で無効）",
            { defaultValue: defaults[n++] ?? "" }
        );
        form.textField(
            `割引${i + 1} 割引率（%）`,
            "0～100（空欄/0で無効）",
            { defaultValue: defaults[n++] ?? "" }
        );
    }

    return form;
}

function parseDailySupplyFormValues(values) {
    const raw = Array.isArray(values) ? values.map(v => String(v ?? "")) : [];
    const settings = emptyDailySupplySettings();
    const errors = [];
    let n = 0;

    for (const day of DAILY_SUPPLY_DAYS) {
        const rawStart = raw[n++] ?? "";
        const rawEnd = raw[n++] ?? "";
        const start = normalizeDailySupplyClock(rawStart);
        const end = normalizeDailySupplyClock(rawEnd);

        if (start === undefined) {
            errors.push(`${day.label}の販売開始「${rawStart}」は HH:MM で入力してください`);
            continue;
        }
        if (end === undefined) {
            errors.push(`${day.label}の販売終了「${rawEnd}」は HH:MM で入力してください`);
            continue;
        }
        if ((start && !end) || (!start && end)) {
            errors.push(`${day.label}は販売開始と販売終了を両方入力するか、両方空欄にしてください`);
            continue;
        }
        if (start && end && start === end) {
            errors.push(`${day.label}の販売開始と販売終了は同じ時刻にできません`);
            continue;
        }

        settings.days[day.key] = { start, end };
    }

    let previousMinutes = -1;
    for (let i = 0; i < DAILY_SUPPLY_DISCOUNT_STEPS; i++) {
        const rawTime = raw[n++] ?? "";
        const rawRate = raw[n++] ?? "";
        const time = normalizeDailySupplyClock(rawTime);
        const rate = normalizeDailySupplyRate(rawRate);

        if (time === undefined) {
            errors.push(`割引${i + 1}の開始時刻「${rawTime}」は HH:MM で入力してください`);
            continue;
        }
        if (rate === undefined) {
            errors.push(`割引${i + 1}の割引率「${rawRate}」は 0～100 の数字で入力してください`);
            continue;
        }

        if (!time && rate === 0) {
            settings.discounts[i] = { time: "", rate: 0 };
            continue;
        }
        if (!time && rate > 0) {
            errors.push(`割引${i + 1}は割引率を設定した場合、開始時刻も入力してください`);
            continue;
        }
        if (time && rate === 0) {
            // 0% is explicitly disabled; discard the unused time.
            settings.discounts[i] = { time: "", rate: 0 };
            continue;
        }

        const minutes = parseClock(time);
        if (minutes <= previousMinutes) {
            errors.push(`割引${i + 1}の開始時刻は前の割引より後の時刻にしてください`);
            continue;
        }
        previousMinutes = minutes;
        settings.discounts[i] = { time, rate };
    }

    return { settings, errors, raw };
}

function openDailySupplySettings(player, rec, block, container) {
    // The same slot is the 5th product-type choice while that dropdown is open.
    // Restore it before closing so the captured container is clean.
    setProbe(container, DAILY_SUPPLY_ACTION_SLOT, 1);
    clearProbeFromPlayer(player);

    active.delete(player.id);

    const playerId = player.id;
    const opened = forceCloseScreen(player, block, () => {
        showDailySupplySettingsForm(playerId, rec);
    });

    if (!opened) {
        active.set(player.id, rec);
        tell(player, "§c[日配商品] 設定フォームを開けませんでした。Escで閉じてから開き直してください");
    }
}

function showDailySupplySettingsForm(
    playerId,
    rec,
    firstTick = system.currentTick,
    errors = 0,
    seedValues = undefined
) {
    const player = findPlayer(playerId);
    if (!player) return;

    const block = resolve(rec);
    if (!block || block.typeId !== PANEL_ID) {
        tell(player, "§c[日配商品] ショップブロックを取得できませんでした");
        return;
    }

    const retry = (nextErrors, values = seedValues) => {
        if (system.currentTick - firstTick >= FORM_OPEN_MAX_WAIT_TICKS) {
            tell(player, "§c[日配商品] 設定フォームを表示できませんでした（画面がビジー）");
            return;
        }
        system.run(() => showDailySupplySettingsForm(
            playerId,
            rec,
            firstTick,
            nextErrors,
            values
        ));
    };

    let promise;
    try {
        promise = buildDailySupplySettingsForm(block, seedValues).show(player);
    } catch (error) {
        if (errors < 3) { retry(errors + 1); return; }
        tell(player, `§c[日配商品] フォーム表示失敗: ${String(error)}`);
        return;
    }

    promise.then(result => {
        if (result.canceled) {
            if (result.cancelationReason === FormCancelationReason.UserBusy) {
                retry(errors);
                return;
            }
            tell(player, "§7[日配商品] 設定をキャンセルしました");
            return;
        }

        const parsed = parseDailySupplyFormValues(result.formValues);
        if (parsed.errors.length > 0) {
            for (const message of parsed.errors) {
                tell(player, `§c[日配商品] ${message}`);
            }
            // Keep what the player typed. Validation is user-driven, so reset
            // the UserBusy retry window instead of reusing the original open tick.
            system.run(() => showDailySupplySettingsForm(
                playerId,
                rec,
                system.currentTick,
                0,
                parsed.raw
            ));
            return;
        }

        const target = resolve(rec);
        if (!target || target.typeId !== PANEL_ID) {
            tell(player, "§c[日配商品] 反映先のショップが見つかりません");
            return;
        }

        setStringProp(
            target,
            DAILY_SUPPLY_PROP,
            JSON.stringify(parsed.settings)
        );

        tell(
            player,
            "§a[日配商品] 曜日別販売時間と時間帯割引を反映しました §7（ショップの保存で確定）"
        );
    }).catch(error => {
        if (errors < 3) { retry(errors + 1); return; }
        tell(player, `§c[日配商品] フォーム表示失敗: ${String(error)}`);
    });
}


// ============================================================
// くじ (v33)
//
// Presets are stored as JSON in the block property KUJI_PROP:
//   [{ name, tickets, remaining, items: [{ id, count }] }]
// Editing flow (forms, the shop screen is closed meanwhile):
//   list (ModalForm) --＋ / 中身を選び直す--> selector (ActionForm)
//   selector --このプリセットを保存 / 戻る--> list
//   list --保存 (no toggle on)--> persist, stock check, reset remaining
// tickets = 0 means the preset is OFF (never drawn).
// The ラストワン賞 is the real item in slot 17 (not part of presets).
// ============================================================
const KUJI_PROP = "shop_kuji_presets";
const KUJI_SUMMARY_FIELD = "kuji_summary";
const KUJI_MAX_PRESETS = 12;
const KUJI_NAME_MAX = 16;

const SHOP_ICON_DIR = "textures/shop_icons/";
const SHOP_ICON_UNKNOWN = SHOP_ICON_DIR + "_unknown";
const SHOP_ICON_NAMES = new Set(["acacia_boat", "acacia_boat_with_chest", "acacia_button", "acacia_door", "acacia_fence", "acacia_fence_gate", "acacia_hanging_sign", "acacia_leaves", "acacia_log", "acacia_planks", "acacia_pressure_plate", "acacia_sapling", "acacia_shelf", "acacia_sign", "acacia_slab", "acacia_stairs", "acacia_trapdoor", "acacia_wood", "activator_rail", "allium", "amethyst_block", "amethyst_cluster", "amethyst_shard", "ancient_debris", "andesite", "andesite_wall", "angler_pottery_sherd", "anvil", "apple", "archer_pottery_sherd", "armadillo_scute", "armor_stand", "arms_up_pottery_sherd", "arrow", "arrow_of_decay", "arrow_of_fire_resistance", "arrow_of_harming", "arrow_of_healing", "arrow_of_infestation", "arrow_of_invisibility", "arrow_of_leaping", "arrow_of_luck", "arrow_of_night_vision", "arrow_of_oozing", "arrow_of_poison", "arrow_of_regeneration", "arrow_of_slow_falling", "arrow_of_slowness", "arrow_of_strength", "arrow_of_swiftness", "arrow_of_the_turtle_master", "arrow_of_water_breathing", "arrow_of_weakness", "arrow_of_weaving", "arrow_of_wind_charging", "axolotl_bucket", "azalea", "azalea_leaves", "azure_bluet", "baked_potato", "bamboo", "bamboo_button", "bamboo_door", "bamboo_fence", "bamboo_fence_gate", "bamboo_hanging_sign", "bamboo_mosaic", "bamboo_mosaic_slab", "bamboo_mosaic_stairs", "bamboo_planks", "bamboo_pressure_plate", "bamboo_raft", "bamboo_raft_with_chest", "bamboo_shelf", "bamboo_sign", "bamboo_slab", "bamboo_stairs", "bamboo_trapdoor", "barrel", "basalt", "beacon", "bed", "bedrock", "bee_nest", "beehive", "beetroot", "beetroot_seeds", "beetroot_soup", "bell", "big_dripleaf", "birch_boat", "birch_boat_with_chest", "birch_button", "birch_door", "birch_fence", "birch_fence_gate", "birch_hanging_sign", "birch_leaves", "birch_log", "birch_planks", "birch_pressure_plate", "birch_sapling", "birch_shelf", "birch_sign", "birch_slab", "birch_stairs", "birch_trapdoor", "birch_wood", "black_banner", "black_bed", "black_bundle", "black_candle", "black_carpet", "black_concrete", "black_concrete_powder", "black_firework_star", "black_glazed_terracotta", "black_harness", "black_shulker_box", "black_stained_glass", "black_stained_glass_pane", "black_terracotta", "black_wool", "blackstone", "blackstone_wall", "blade_pottery_sherd", "blast_furnace", "blaze_powder", "blaze_rod", "block_of_amethyst", "block_of_bamboo", "block_of_coal", "block_of_copper", "block_of_diamond", "block_of_emerald", "block_of_gold", "block_of_iron", "block_of_lapis_lazuli", "block_of_netherite", "block_of_quartz", "block_of_raw_copper", "block_of_raw_gold", "block_of_raw_iron", "block_of_redstone", "block_of_resin", "block_of_stripped_bamboo", "blue_banner", "blue_bed", "blue_bundle", "blue_candle", "blue_carpet", "blue_concrete", "blue_concrete_powder", "blue_egg", "blue_firework_star", "blue_glazed_terracotta", "blue_harness", "blue_ice", "blue_orchid", "blue_shulker_box", "blue_stained_glass", "blue_stained_glass_pane", "blue_terracotta", "blue_wool", "bolt_armor_trim", "bone", "bone_block", "bone_meal", "book", "book_and_quill", "bookshelf", "bottle_o_enchanting", "bow", "bowl", "brain_coral", "brain_coral_block", "brain_coral_fan", "bread", "breeze_rod", "brewer_pottery_sherd", "brewing_stand", "brick", "brick_wall", "bricks", "brown_banner", "brown_bed", "brown_bundle", "brown_candle", "brown_carpet", "brown_concrete", "brown_concrete_powder", "brown_egg", "brown_firework_star", "brown_glazed_terracotta", "brown_harness", "brown_mushroom", "brown_mushroom_block", "brown_shulker_box", "brown_stained_glass", "brown_stained_glass_pane", "brown_terracotta", "brown_wool", "brush", "bubble_coral", "bubble_coral_block", "bubble_coral_fan", "bucket", "bucket_of_axolotl", "bucket_of_cod", "bucket_of_pufferfish", "bucket_of_salmon", "bucket_of_tadpole", "bucket_of_tropical_fish", "budding_amethyst", "bundle", "burn_pottery_sherd", "bush", "cactus", "cactus_flower", "cake", "calcite", "calibrated_sculk_sensor", "campfire", "carrot", "carrot_on_a_stick", "cartography_table", "carved_pumpkin", "cauldron", "chainmail_boots", "chainmail_chestplate", "chainmail_helmet", "chainmail_leggings", "charcoal", "cherry_boat", "cherry_boat_with_chest", "cherry_button", "cherry_door", "cherry_fence", "cherry_fence_gate", "cherry_hanging_sign", "cherry_leaves", "cherry_log", "cherry_planks", "cherry_pressure_plate", "cherry_sapling", "cherry_shelf", "cherry_sign", "cherry_slab", "cherry_stairs", "cherry_trapdoor", "cherry_wood", "chest", "chipped_anvil", "chiseled_bookshelf", "chiseled_copper", "chiseled_deepslate", "chiseled_nether_bricks", "chiseled_polished_blackstone", "chiseled_quartz_block", "chiseled_red_sandstone", "chiseled_resin_bricks", "chiseled_sandstone", "chiseled_stone_bricks", "chiseled_tuff", "chiseled_tuff_bricks", "chorus_flower", "chorus_fruit", "chorus_plant", "clay", "clay_ball", "clock", "closed_eyeblossom", "coal", "coal_ore", "coarse_dirt", "coast_armor_trim", "cobbled_deepslate", "cobbled_deepslate_wall", "cobblestone", "cobblestone_wall", "cobweb", "cocoa_beans", "cod_bucket", "comparator", "compass", "composter", "conduit", "cooked_beef", "cooked_chicken", "cooked_cod", "cooked_mutton", "cooked_porkchop", "cooked_rabbit", "cooked_salmon", "cookie", "copper_axe", "copper_bars", "copper_block", "copper_boots", "copper_bulb", "copper_chain", "copper_chest", "copper_chestplate", "copper_door", "copper_golem_statue", "copper_grate", "copper_helmet", "copper_hoe", "copper_horse_armor", "copper_ingot", "copper_lantern", "copper_leggings", "copper_nautilus_armor", "copper_nugget", "copper_ore", "copper_pickaxe", "copper_shovel", "copper_sword", "copper_torch", "copper_trapdoor", "cornflower", "cracked_deepslate_bricks", "cracked_deepslate_tiles", "cracked_nether_bricks", "cracked_polished_blackstone_bricks", "cracked_stone_bricks", "crafter", "crafting_table", "creaking_heart", "creeper_head", "crimson_button", "crimson_door", "crimson_fence", "crimson_fence_gate", "crimson_fungus", "crimson_hanging_sign", "crimson_hyphae", "crimson_nylium", "crimson_planks", "crimson_pressure_plate", "crimson_roots", "crimson_shelf", "crimson_sign", "crimson_slab", "crimson_stairs", "crimson_stem", "crimson_trapdoor", "crossbow", "crying_obsidian", "cut_copper", "cut_copper_slab", "cut_copper_stairs", "cut_red_sandstone", "cut_sandstone", "cyan_banner", "cyan_bed", "cyan_bundle", "cyan_candle", "cyan_carpet", "cyan_concrete", "cyan_concrete_powder", "cyan_firework_star", "cyan_glazed_terracotta", "cyan_harness", "cyan_shulker_box", "cyan_stained_glass", "cyan_stained_glass_pane", "cyan_terracotta", "cyan_wool", "damaged_anvil", "dandelion", "danger_pottery_sherd", "dark_oak_boat", "dark_oak_boat_with_chest", "dark_oak_button", "dark_oak_door", "dark_oak_fence", "dark_oak_fence_gate", "dark_oak_hanging_sign", "dark_oak_leaves", "dark_oak_log", "dark_oak_planks", "dark_oak_pressure_plate", "dark_oak_sapling", "dark_oak_shelf", "dark_oak_sign", "dark_oak_slab", "dark_oak_stairs", "dark_oak_trapdoor", "dark_oak_wood", "dark_prismarine", "daylight_detector", "dead_brain_coral", "dead_brain_coral_block", "dead_brain_coral_fan", "dead_bubble_coral", "dead_bubble_coral_block", "dead_bubble_coral_fan", "dead_bush", "dead_fire_coral", "dead_fire_coral_block", "dead_fire_coral_fan", "dead_horn_coral", "dead_horn_coral_block", "dead_horn_coral_fan", "dead_tube_coral", "dead_tube_coral_block", "dead_tube_coral_fan", "decorated_pot", "deepslate", "deepslate_brick_wall", "deepslate_bricks", "deepslate_coal_ore", "deepslate_copper_ore", "deepslate_diamond_ore", "deepslate_emerald_ore", "deepslate_gold_ore", "deepslate_iron_ore", "deepslate_lapis_lazuli_ore", "deepslate_lapis_ore", "deepslate_redstone_ore", "deepslate_tile_wall", "deepslate_tiles", "detector_rail", "diamond", "diamond_axe", "diamond_block", "diamond_boots", "diamond_chestplate", "diamond_helmet", "diamond_hoe", "diamond_horse_armor", "diamond_leggings", "diamond_nautilus_armor", "diamond_ore", "diamond_pickaxe", "diamond_shovel", "diamond_sword", "diorite", "diorite_wall", "dirt", "dirt_path", "disc_fragment_5", "dispenser", "dragon_egg", "dragon_head", "dragons_breath", "dried_ghast", "dried_kelp", "dried_kelp_block", "dripstone_block", "dropper", "dune_armor_trim", "echo_shard", "egg", "elytra", "emerald", "emerald_block", "emerald_ore", "enchanted_book", "enchanted_golden_apple", "enchanting_table", "end_crystal", "end_rod", "end_stone", "end_stone_brick_wall", "end_stone_bricks", "ender_chest", "ender_pearl", "explorer_pottery_sherd", "exposed_chiseled_copper", "exposed_copper", "exposed_copper_bars", "exposed_copper_bulb", "exposed_copper_chain", "exposed_copper_chest", "exposed_copper_door", "exposed_copper_golem_statue", "exposed_copper_grate", "exposed_copper_lantern", "exposed_copper_trapdoor", "exposed_cut_copper", "exposed_cut_copper_slab", "exposed_cut_copper_stairs", "exposed_lightning_rod", "eye_armor_trim", "eye_of_ender", "feather", "fermented_spider_eye", "fern", "fire_charge", "fire_coral", "fire_coral_block", "fire_coral_fan", "firefly_bush", "firework_rocket", "firework_star", "fishing_rod", "fletching_table", "flint", "flint_and_steel", "flow_armor_trim", "flow_pottery_sherd", "flower_pot", "flowering_azalea", "flowering_azalea_leaves", "friend_pottery_sherd", "frogspawn", "frosted_ice", "furnace", "ghast_tear", "gilded_blackstone", "glass", "glass_bottle", "glass_pane", "glistering_melon_slice", "glow_berries", "glow_ink_sac", "glow_item_frame", "glow_lichen", "glowstone", "glowstone_dust", "goat_horn", "gold_block", "gold_ingot", "gold_nugget", "gold_ore", "golden_apple", "golden_axe", "golden_boots", "golden_carrot", "golden_chestplate", "golden_dandelion", "golden_helmet", "golden_hoe", "golden_horse_armor", "golden_leggings", "golden_nautilus_armor", "golden_pickaxe", "golden_shovel", "golden_sword", "granite", "granite_wall", "grass_block", "gravel", "gray_banner", "gray_bed", "gray_bundle", "gray_candle", "gray_carpet", "gray_concrete", "gray_concrete_powder", "gray_firework_star", "gray_glazed_terracotta", "gray_harness", "gray_shulker_box", "gray_stained_glass", "gray_stained_glass_pane", "gray_terracotta", "gray_wool", "green_banner", "green_bed", "green_bundle", "green_candle", "green_carpet", "green_concrete", "green_concrete_powder", "green_firework_star", "green_glazed_terracotta", "green_harness", "green_shulker_box", "green_stained_glass", "green_stained_glass_pane", "green_terracotta", "green_wool", "grindstone", "gunpowder", "guster_pottery_sherd", "hanging_roots", "hay_bale", "heart_of_the_sea", "heart_pottery_sherd", "heartbreak_pottery_sherd", "heavy_core", "heavy_weighted_pressure_plate", "honey_block", "honey_bottle", "honeycomb", "honeycomb_block", "hopper", "horn_coral", "horn_coral_block", "horn_coral_fan", "host_armor_trim", "howl_pottery_sherd", "ice", "ink_sac", "iron_axe", "iron_bars", "iron_block", "iron_boots", "iron_chain", "iron_chestplate", "iron_door", "iron_helmet", "iron_hoe", "iron_horse_armor", "iron_ingot", "iron_leggings", "iron_nautilus_armor", "iron_nugget", "iron_ore", "iron_pickaxe", "iron_shovel", "iron_sword", "iron_trapdoor", "item_frame", "itemsprite_bordure_indented_banner_pattern", "itemsprite_copper_spear", "itemsprite_creeper_charge_banner_pattern", "itemsprite_diamond_spear", "itemsprite_field_masoned_banner_pattern", "itemsprite_flow_banner_pattern", "itemsprite_flower_charge_banner_pattern", "itemsprite_globe_banner_pattern", "itemsprite_golden_spear", "itemsprite_guster_banner_pattern", "itemsprite_iron_spear", "itemsprite_netherite_spear", "itemsprite_skull_charge_banner_pattern", "itemsprite_snout_banner_pattern", "itemsprite_stone_spear", "itemsprite_thing_banner_pattern", "itemsprite_trial_key", "itemsprite_wooden_spear", "jack_olantern", "jukebox", "jungle_boat", "jungle_boat_with_chest", "jungle_button", "jungle_door", "jungle_fence", "jungle_fence_gate", "jungle_hanging_sign", "jungle_leaves", "jungle_log", "jungle_planks", "jungle_pressure_plate", "jungle_sapling", "jungle_shelf", "jungle_sign", "jungle_slab", "jungle_stairs", "jungle_trapdoor", "jungle_wood", "kelp", "ladder", "lantern", "lapis_block", "lapis_lazuli", "lapis_lazuli_ore", "lapis_ore", "large_amethyst_bud", "large_fern", "lava_bucket", "lead", "leaf_litter", "leather", "leather_boots", "leather_cap", "leather_chestplate", "leather_helmet", "leather_horse_armor", "leather_leggings", "leather_pants", "leather_tunic", "lectern", "lever", "light_blue_banner", "light_blue_bed", "light_blue_bundle", "light_blue_candle", "light_blue_carpet", "light_blue_concrete", "light_blue_concrete_powder", "light_blue_firework_star", "light_blue_glazed_terracotta", "light_blue_harness", "light_blue_shulker_box", "light_blue_stained_glass", "light_blue_stained_glass_pane", "light_blue_terracotta", "light_blue_wool", "light_gray_banner", "light_gray_bed", "light_gray_bundle", "light_gray_candle", "light_gray_carpet", "light_gray_concrete", "light_gray_concrete_powder", "light_gray_firework_star", "light_gray_glazed_terracotta", "light_gray_harness", "light_gray_shulker_box", "light_gray_stained_glass", "light_gray_stained_glass_pane", "light_gray_terracotta", "light_gray_wool", "light_weighted_pressure_plate", "lightning_rod", "lilac", "lily_of_the_valley", "lily_pad", "lime_banner", "lime_bed", "lime_bundle", "lime_candle", "lime_carpet", "lime_concrete", "lime_concrete_powder", "lime_firework_star", "lime_glazed_terracotta", "lime_harness", "lime_shulker_box", "lime_stained_glass", "lime_stained_glass_pane", "lime_terracotta", "lime_wool", "lingering_potion_of_decay", "lingering_potion_of_fire_resistance", "lingering_potion_of_harming", "lingering_potion_of_healing", "lingering_potion_of_infestation", "lingering_potion_of_invisibility", "lingering_potion_of_leaping", "lingering_potion_of_luck", "lingering_potion_of_night_vision", "lingering_potion_of_oozing", "lingering_potion_of_poison", "lingering_potion_of_regeneration", "lingering_potion_of_slow_falling", "lingering_potion_of_slowness", "lingering_potion_of_strength", "lingering_potion_of_swiftness", "lingering_potion_of_the_turtle_master", "lingering_potion_of_water_breathing", "lingering_potion_of_weakness", "lingering_potion_of_weaving", "lingering_potion_of_wind_charging", "lingering_water_bottle", "lodestone", "loom", "mace", "magenta_banner", "magenta_bed", "magenta_bundle", "magenta_candle", "magenta_carpet", "magenta_concrete", "magenta_concrete_powder", "magenta_firework_star", "magenta_glazed_terracotta", "magenta_harness", "magenta_shulker_box", "magenta_stained_glass", "magenta_stained_glass_pane", "magenta_terracotta", "magenta_wool", "magma_block", "magma_cream", "mangrove_boat", "mangrove_boat_with_chest", "mangrove_button", "mangrove_door", "mangrove_fence", "mangrove_fence_gate", "mangrove_hanging_sign", "mangrove_leaves", "mangrove_log", "mangrove_planks", "mangrove_pressure_plate", "mangrove_propagule", "mangrove_roots", "mangrove_shelf", "mangrove_sign", "mangrove_slab", "mangrove_stairs", "mangrove_trapdoor", "mangrove_wood", "map", "medium_amethyst_bud", "melon", "melon_block", "melon_seeds", "melon_slice", "milk_bucket", "minecart", "minecart_with_chest", "minecart_with_hopper", "minecart_with_tnt", "miner_pottery_sherd", "moss_block", "moss_carpet", "mossy_cobblestone", "mossy_cobblestone_wall", "mossy_stone_brick_wall", "mossy_stone_bricks", "mourner_pottery_sherd", "mud", "mud_brick_wall", "mud_bricks", "muddy_mangrove_roots", "mushroom_stem", "mushroom_stew", "music_disc_11", "music_disc_13", "music_disc_5", "music_disc_blocks", "music_disc_cat", "music_disc_chirp", "music_disc_creator", "music_disc_creator_music_box", "music_disc_far", "music_disc_lava_chicken", "music_disc_mall", "music_disc_mellohi", "music_disc_otherside", "music_disc_pigstep", "music_disc_precipice", "music_disc_relic", "music_disc_stal", "music_disc_strad", "music_disc_tears", "music_disc_wait", "music_disc_ward", "mycelium", "name_tag", "nautilus_shell", "nether_brick", "nether_brick_fence", "nether_brick_wall", "nether_bricks", "nether_gold_ore", "nether_quartz", "nether_quartz_ore", "nether_sprouts", "nether_star", "nether_wart", "nether_wart_block", "netherite_axe", "netherite_boots", "netherite_chestplate", "netherite_helmet", "netherite_hoe", "netherite_horse_armor", "netherite_ingot", "netherite_leggings", "netherite_nautilus_armor", "netherite_pickaxe", "netherite_scrap", "netherite_shovel", "netherite_sword", "netherite_upgrade", "netherrack", "note_block", "oak_boat", "oak_boat_with_chest", "oak_button", "oak_door", "oak_fence", "oak_fence_gate", "oak_hanging_sign", "oak_leaves", "oak_log", "oak_planks", "oak_pressure_plate", "oak_sapling", "oak_shelf", "oak_sign", "oak_slab", "oak_stairs", "oak_trapdoor", "oak_wood", "observer", "obsidian", "ochre_froglight", "ominous_banner", "ominous_bottle", "ominous_trial_key", "open_eyeblossom", "orange_banner", "orange_bed", "orange_bundle", "orange_candle", "orange_carpet", "orange_concrete", "orange_concrete_powder", "orange_firework_star", "orange_glazed_terracotta", "orange_harness", "orange_shulker_box", "orange_stained_glass", "orange_stained_glass_pane", "orange_terracotta", "orange_tulip", "orange_wool", "oxeye_daisy", "oxidized_chiseled_copper", "oxidized_copper", "oxidized_copper_bars", "oxidized_copper_bulb", "oxidized_copper_chain", "oxidized_copper_chest", "oxidized_copper_door", "oxidized_copper_golem_statue", "oxidized_copper_grate", "oxidized_copper_lantern", "oxidized_copper_trapdoor", "oxidized_cut_copper", "oxidized_cut_copper_slab", "oxidized_cut_copper_stairs", "oxidized_lightning_rod", "packed_ice", "packed_mud", "painting", "pale_hanging_moss", "pale_moss_block", "pale_moss_carpet", "pale_oak_boat", "pale_oak_boat_with_chest", "pale_oak_button", "pale_oak_door", "pale_oak_fence", "pale_oak_fence_gate", "pale_oak_hanging_sign", "pale_oak_leaves", "pale_oak_log", "pale_oak_planks", "pale_oak_pressure_plate", "pale_oak_sapling", "pale_oak_shelf", "pale_oak_sign", "pale_oak_slab", "pale_oak_stairs", "pale_oak_trapdoor", "pale_oak_wood", "paper", "pearlescent_froglight", "peony", "phantom_membrane", "piglin_head", "pink_banner", "pink_bed", "pink_bundle", "pink_candle", "pink_carpet", "pink_concrete", "pink_concrete_powder", "pink_firework_star", "pink_glazed_terracotta", "pink_harness", "pink_petals", "pink_shulker_box", "pink_stained_glass", "pink_stained_glass_pane", "pink_terracotta", "pink_tulip", "pink_wool", "piston", "pitcher_plant", "pitcher_pod", "plenty_pottery_sherd", "podzol", "pointed_dripstone", "poisonous_potato", "polished_andesite", "polished_basalt", "polished_blackstone", "polished_blackstone_brick_wall", "polished_blackstone_bricks", "polished_blackstone_button", "polished_blackstone_pressure_plate", "polished_blackstone_wall", "polished_deepslate", "polished_deepslate_wall", "polished_diorite", "polished_granite", "polished_tuff", "polished_tuff_wall", "poplar_boat", "poplar_door", "poplar_fence", "poplar_log", "popped_chorus_fruit", "poppy", "potato", "potion_of_decay", "potion_of_fire_resistance", "potion_of_harming", "potion_of_healing", "potion_of_infestation", "potion_of_invisibility", "potion_of_leaping", "potion_of_luck", "potion_of_night_vision", "potion_of_oozing", "potion_of_poison", "potion_of_regeneration", "potion_of_slow_falling", "potion_of_slowness", "potion_of_strength", "potion_of_swiftness", "potion_of_the_turtle_master", "potion_of_water_breathing", "potion_of_weakness", "potion_of_weaving", "potion_of_wind_charging", "powder_snow_bucket", "powered_rail", "prismarine", "prismarine_bricks", "prismarine_crystals", "prismarine_shard", "prismarine_wall", "prize_pottery_sherd", "pufferfish", "pufferfish_bucket", "pumpkin", "pumpkin_pie", "pumpkin_seeds", "purple_banner", "purple_bed", "purple_bundle", "purple_candle", "purple_carpet", "purple_concrete", "purple_concrete_powder", "purple_firework_star", "purple_glazed_terracotta", "purple_harness", "purple_shulker_box", "purple_stained_glass", "purple_stained_glass_pane", "purple_terracotta", "purple_wool", "purpur_block", "purpur_pillar", "quartz", "quartz_block", "quartz_bricks", "quartz_pillar", "rabbit_hide", "rabbit_stew", "rabbits_foot", "rail", "raiser_armor_trim", "raw_beef", "raw_chicken", "raw_cod", "raw_copper", "raw_copper_block", "raw_gold", "raw_gold_block", "raw_iron", "raw_iron_block", "raw_mutton", "raw_porkchop", "raw_rabbit", "raw_salmon", "recovery_compass", "red_banner", "red_bed", "red_bundle", "red_candle", "red_carpet", "red_concrete", "red_concrete_powder", "red_firework_star", "red_glazed_terracotta", "red_harness", "red_mushroom", "red_mushroom_block", "red_nether_brick_wall", "red_nether_bricks", "red_sand", "red_sandstone", "red_sandstone_wall", "red_shulker_box", "red_stained_glass", "red_stained_glass_pane", "red_terracotta", "red_tulip", "red_wool", "redstone", "redstone_block", "redstone_comparator", "redstone_lamp", "redstone_ore", "redstone_repeater", "redstone_torch", "reinforced_deepslate", "repeater", "resin_brick", "resin_brick_wall", "resin_bricks", "resin_clump", "respawn_anchor", "rib_armor_trim", "rooted_dirt", "rose_bush", "rotten_flesh", "saddle", "salmon_bucket", "sand", "sandstone", "sandstone_wall", "scaffolding", "scrape_pottery_sherd", "sculk", "sculk_catalyst", "sculk_sensor", "sculk_shrieker", "sculk_vein", "sea_lantern", "sea_pickle", "seagrass", "sentry_armor_trim", "shaper_armor_trim", "sheaf_pottery_sherd", "shears", "shelter_pottery_sherd", "shield", "short_dry_grass", "short_grass", "shroomlight", "shulker_shell", "silence_armor_trim", "skeleton_skull", "skull_pottery_sherd", "slime", "slime_ball", "slime_block", "slimeball", "small_amethyst_bud", "small_dripleaf", "smithing_table", "smoker", "smooth_basalt", "smooth_quartz", "smooth_red_sandstone", "smooth_sandstone", "smooth_stone", "sniffer_egg", "snort_pottery_sherd", "snout_armor_trim", "snow_block", "snowball", "soul_campfire", "soul_lantern", "soul_sand", "soul_soil", "soul_torch", "spider_eye", "spire_armor_trim", "splash_potion_of_decay", "splash_potion_of_fire_resistance", "splash_potion_of_harming", "splash_potion_of_healing", "splash_potion_of_infestation", "splash_potion_of_invisibility", "splash_potion_of_leaping", "splash_potion_of_luck", "splash_potion_of_night_vision", "splash_potion_of_oozing", "splash_potion_of_poison", "splash_potion_of_regeneration", "splash_potion_of_slow_falling", "splash_potion_of_slowness", "splash_potion_of_strength", "splash_potion_of_swiftness", "splash_potion_of_the_turtle_master", "splash_potion_of_water_breathing", "splash_potion_of_weakness", "splash_potion_of_weaving", "splash_potion_of_wind_charging", "splash_water_bottle", "sponge", "spore_blossom", "spruce_boat", "spruce_boat_with_chest", "spruce_button", "spruce_door", "spruce_fence", "spruce_fence_gate", "spruce_hanging_sign", "spruce_leaves", "spruce_log", "spruce_planks", "spruce_pressure_plate", "spruce_sapling", "spruce_shelf", "spruce_sign", "spruce_slab", "spruce_stairs", "spruce_trapdoor", "spruce_wood", "spyglass", "stick", "sticky_piston", "stone", "stone_axe", "stone_brick_wall", "stone_bricks", "stone_button", "stone_hoe", "stone_pickaxe", "stone_pressure_plate", "stone_shovel", "stone_sword", "stonecutter", "string", "stripped_acacia_log", "stripped_acacia_wood", "stripped_birch_log", "stripped_birch_wood", "stripped_cherry_log", "stripped_cherry_wood", "stripped_crimson_hyphae", "stripped_crimson_stem", "stripped_dark_oak_log", "stripped_dark_oak_wood", "stripped_jungle_log", "stripped_jungle_wood", "stripped_mangrove_log", "stripped_mangrove_wood", "stripped_oak_log", "stripped_oak_wood", "stripped_pale_oak_log", "stripped_pale_oak_wood", "stripped_spruce_log", "stripped_spruce_wood", "stripped_warped_hyphae", "stripped_warped_stem", "sugar", "sugar_cane", "sunflower", "suspicious_stew", "sweet_berries", "tadpole_bucket", "tall_dry_grass", "tall_grass", "target", "terracotta", "tide_armor_trim", "tinted_glass", "tnt", "torch", "torchflower", "torchflower_seeds", "totem_of_undying", "trapped_chest", "trident", "tripwire_hook", "tropical_fish", "tropical_fish_bucket", "tube_coral", "tube_coral_block", "tube_coral_fan", "tuff", "tuff_brick_wall", "tuff_bricks", "tuff_wall", "turtle_egg", "turtle_scute", "turtle_shell", "twisting_vines", "verdant_froglight", "vex_armor_trim", "vines", "ward_armor_trim", "warped_button", "warped_door", "warped_fence", "warped_fence_gate", "warped_fungus", "warped_fungus_on_a_stick", "warped_hanging_sign", "warped_hyphae", "warped_nylium", "warped_planks", "warped_pressure_plate", "warped_roots", "warped_shelf", "warped_sign", "warped_slab", "warped_stairs", "warped_stem", "warped_trapdoor", "warped_wart_block", "water_bottle", "water_bucket", "waxed_copper_golem_statue", "waxed_exposed_copper_golem_statue", "waxed_oxidized_copper_golem_statue", "waxed_weathered_copper_golem_statue", "wayfinder_armor_trim", "weathered_chiseled_copper", "weathered_copper", "weathered_copper_bars", "weathered_copper_bulb", "weathered_copper_chain", "weathered_copper_chest", "weathered_copper_door", "weathered_copper_golem_statue", "weathered_copper_grate", "weathered_copper_lantern", "weathered_copper_trapdoor", "weathered_cut_copper", "weathered_cut_copper_slab", "weathered_cut_copper_stairs", "weathered_lightning_rod", "weeping_vines", "wet_sponge", "wheat", "wheat_seeds", "white_banner", "white_bed", "white_bundle", "white_candle", "white_carpet", "white_concrete", "white_concrete_powder", "white_firework_star", "white_glazed_terracotta", "white_harness", "white_shulker_box", "white_stained_glass", "white_stained_glass_pane", "white_terracotta", "white_tulip", "white_wool", "wild_armor_trim", "wildflowers", "wind_charge", "wither_rose", "wither_skeleton_skull", "wolf_armor", "wooden_axe", "wooden_hoe", "wooden_pickaxe", "wooden_shovel", "wooden_sword", "writable_book", "yellow_banner", "yellow_bed", "yellow_bundle", "yellow_candle", "yellow_carpet", "yellow_concrete", "yellow_concrete_powder", "yellow_firework_star", "yellow_glazed_terracotta", "yellow_harness", "yellow_shulker_box", "yellow_stained_glass", "yellow_stained_glass_pane", "yellow_terracotta", "yellow_wool", "zombie_head"]);
// Bedrock id -> icon file name, where the icon set uses another name.
const SHOP_ICON_ALIASES = {
    experience_bottle: "bottle_o_enchanting",
    empty_map: "map",
    filled_map: "map",
    chain: "iron_chain"
};
// Dyes are not in the icon set: use the game's own textures.
const DYE_TEXTURES = {
    black_dye: "dye_powder_black_new", brown_dye: "dye_powder_brown_new",
    blue_dye: "dye_powder_blue_new", white_dye: "dye_powder_white_new",
    red_dye: "dye_powder_red", green_dye: "dye_powder_green",
    purple_dye: "dye_powder_purple", cyan_dye: "dye_powder_cyan",
    light_gray_dye: "dye_powder_silver", gray_dye: "dye_powder_gray",
    pink_dye: "dye_powder_pink", lime_dye: "dye_powder_lime",
    yellow_dye: "dye_powder_yellow", light_blue_dye: "dye_powder_light_blue",
    magenta_dye: "dye_powder_magenta", orange_dye: "dye_powder_orange"
};

function itemIconPath(typeId) {
    const [ns, name] = String(typeId).includes(":") ? String(typeId).split(":") : ["minecraft", String(typeId)];
    if (ns !== "minecraft") return SHOP_ICON_UNKNOWN;
    if (DYE_TEXTURES[name]) return "textures/items/" + DYE_TEXTURES[name];
    const file = SHOP_ICON_ALIASES[name] ?? name;
    return SHOP_ICON_NAMES.has(file) ? SHOP_ICON_DIR + file : SHOP_ICON_UNKNOWN;
}

function itemShortName(typeId) {
    return String(typeId).replace(/^minecraft:/, "");
}

// Localized item name for forms (falls back to the id).
function itemNameRaw(typeId) {
    try {
        const key = new ItemStack(typeId, 1).localizationKey;
        if (key) return { translate: key };
    } catch {}
    return { text: itemShortName(typeId) };
}

// ------------------------------------------------------------
// Item identity for くじ (v48): two stacks are the SAME prize item only if
// type, custom name, lore, enchantments, damage and potion all match.
// A plain item's key is just its type id (old saved presets keep working).
// ------------------------------------------------------------
function itemKey(item) {
    const parts = [item.typeId];
    try { if (item.nameTag) parts.push("n=" + item.nameTag); } catch {}
    try { const lore = item.getLore?.(); if (lore?.length) parts.push("l=" + lore.join("\n")); } catch {}
    try {
        const ench = item.getComponent?.("minecraft:enchantable")?.getEnchantments?.();
        if (ench?.length) parts.push("e=" + ench.map(e => `${e.type?.id ?? e.type}:${e.level}`).sort().join(","));
    } catch {}
    try {
        const d = item.getComponent?.("minecraft:durability");
        if (d && d.damage > 0) parts.push("d=" + d.damage);
    } catch {}
    try {
        const pot = item.getComponent?.("minecraft:potion");
        if (pot) parts.push("p=" + (pot.potionEffectType?.id ?? "") + "/" + (pot.potionDeliveryType?.id ?? ""));
    } catch {}
    return parts.join("|");
}

function itemEntry(item, count) {
    const entry = { id: item.typeId, key: itemKey(item), count };
    try { if (item.nameTag) entry.name = item.nameTag; } catch {}
    if (entry.key.includes("|e=")) entry.enchanted = true;
    return entry;
}

function entryKey(it) {
    return it.key ?? it.id;
}

function itemsRaw(items) {
    if (!items?.length) return [{ text: "§7（中身なし）" }];
    const out = [];
    items.forEach((it, i) => {
        if (i > 0) out.push({ text: " / " });
        out.push(it.name ? { text: `『${it.name}』` } : itemNameRaw(it.id));
        out.push({ text: `${it.enchanted ? "✦" : ""} ×${it.count}` });
    });
    return out;
}

function loadKujiPresets(block) {
    try {
        const raw = getProps(block)?.get(KUJI_PROP);
        const list = typeof raw === "string" ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) return [];
        return list.map((p, i) => ({
            name: String(p?.name ?? KUJI_DEFAULT_NAMES[i] ?? `賞${i + 1}`).slice(0, KUJI_NAME_MAX),
            tickets: Math.max(0, Math.trunc(Number(p?.tickets) || 0)),
            remaining: Math.max(0, Math.trunc(Number(p?.remaining) || 0)),
            items: Array.isArray(p?.items)
                ? p.items.filter(it => it && typeof it.id === "string" && Number(it.count) > 0)
                    .map(it => {
                        const e = { id: it.id, count: Math.trunc(Number(it.count)) };
                        if (typeof it.key === "string") e.key = it.key;
                        if (typeof it.name === "string") e.name = it.name;
                        if (it.enchanted) e.enchanted = true;
                        return e;
                    })
                : []
        }));
    } catch {
        return [];
    }
}

function saveKujiPresets(block, presets) {
    try {
        getProps(block)?.set(KUJI_PROP, JSON.stringify(presets.map(p => ({
            name: p.name, tickets: p.tickets, remaining: p.remaining, items: p.items
        }))));
        return true;
    } catch {
        return false;
    }
}

// typeId -> total amount in the くじ stock slots (in slot order).
function kujiStockTotals(block) {
    const totals = new Map();
    const container = getContainer(block);
    if (!container) return totals;
    for (const slot of SALE_LAYOUTS[2].stock) {
        try {
            const item = container.getItem(slot);
            if (!item || isProbe(item)) continue;
            const key = itemKey(item);
            totals.set(key, (totals.get(key) ?? 0) + item.amount);
        } catch {}
    }
    return totals;
}

// How many draws of a prize the stock can pay: for every item of one
// ticket, floor(total / needed); the smallest of those. null = no contents.
function kujiCapacity(items, totals) {
    if (!items?.length) return null;
    let cap = Infinity;
    for (const it of items) {
        if (!(it.count > 0)) continue;
        cap = Math.min(cap, Math.floor((totals.get(entryKey(it)) ?? 0) / it.count));
    }
    return cap === Infinity ? null : cap;
}

function kujiSummaryText(block) {
    const presets = loadKujiPresets(block).filter(p => p.items.length > 0);
    if (presets.length === 0) return "§7未設定";
    const total = presets.reduce((a, p) => a + p.tickets, 0);
    const remaining = presets.reduce((a, p) => a + Math.min(p.remaining, p.tickets), 0);
    const stock = kujiStockTotals(block);
    const short = presets.some(p => {
        const cap = kujiCapacity(p.items, stock);
        return p.tickets > 0 && cap !== null && cap < Math.min(p.remaining, p.tickets);
    });
    // color codes must not count toward the width limit
    return fitWidth(`${presets.length}種 残り${remaining}/${total}本`) + (short ? " §c在庫不足" : "");
}

function toHalfWidthDigits(text) {
    return String(text ?? "").trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// Show a form; retry while the client is busy (e.g. the shop is closing).
function showFormWithRetry(player, form, firstTick = system.currentTick, errors = 0) {
    return new Promise((resolve) => {
        const attempt = (errs) => {
            let promise;
            try {
                promise = form.show(player);
            } catch {
                if (errs < 3) { system.run(() => attempt(errs + 1)); return; }
                resolve(undefined);
                return;
            }
            promise.then((result) => {
                if (result.canceled && result.cancelationReason === FormCancelationReason.UserBusy) {
                    if (system.currentTick - firstTick < FORM_OPEN_MAX_WAIT_TICKS) {
                        system.run(() => attempt(errs));
                    } else {
                        resolve(undefined);
                    }
                    return;
                }
                resolve(result);
            }).catch(() => {
                if (errs < 3) { system.run(() => attempt(errs + 1)); return; }
                resolve(undefined);
            });
        };
        attempt(errors);
    });
}

// Values per control: formValues may contain entries for labels/dividers.
function makeFormIndexer() {
    let elements = 0;
    let inputs = 0;
    return {
        input() { return { el: elements++, inp: inputs++ }; },
        other() { elements++; },
        read(result, ref) {
            const values = result.formValues ?? [];
            const byElement = values.length === elements && elements !== inputs;
            return values[byElement ? ref.el : ref.inp];
        }
    };
}

function startKujiEditor(player, rec, block) {
    const presets = loadKujiPresets(block).map(p => ({
        ...p, items: p.items.map(it => ({ ...it })), dirty: false
    }));
    showKujiList(player, rec, { presets });
}

async function showKujiList(player, rec, work) {
    const block = resolve(rec);
    if (!block || block.typeId !== PANEL_ID) {
        tell(player, "§c[くじ] ショップブロックを取得できませんでした");
        return;
    }

    const form = new ModalFormData().title("くじの設定");
    const ix = makeFormIndexer();
    const refs = [];

    if (work.presets.length === 0) {
        form.label("まだプリセットがありません。\n下の「＋ 新しいプリセットを作る」をオンにして保存すると、在庫からアイテムを選べます。");
        ix.other();
    }

    work.presets.forEach((p, i) => {
        if (i > 0) { form.divider(); ix.other(); }
        form.label({ rawtext: [{ text: `§e${p.name}§r：` }, ...itemsRaw(p.items)] });
        ix.other();
        const ref = {};
        form.textField("名前", "例: A賞", { defaultValue: p.name }); ref.name = ix.input();
        form.textField("本数（数字・0で無効）", "例: 2", { defaultValue: String(p.tickets) }); ref.tickets = ix.input();
        form.toggle("中身を選び直す", { defaultValue: false }); ref.reselect = ix.input();
        form.toggle("§cこのプリセットを削除", { defaultValue: false }); ref.remove = ix.input();
        refs.push(ref);
    });

    form.divider(); ix.other();
    let newRef;
    if (work.presets.length < KUJI_MAX_PRESETS) {
        form.toggle("＋ 新しいプリセットを作る", { defaultValue: false });
        newRef = ix.input();
    }
    form.submitButton("保存");

    const result = await showFormWithRetry(player, form);
    if (!result) {
        tell(player, "§c[くじ] フォームを表示できませんでした");
        return;
    }
    if (result.canceled) {
        tell(player, "§7[くじ] 保存せずに閉じました");
        return;
    }

    const errors = [];
    let reselectIndex = -1;
    const keep = [];

    work.presets.forEach((p, i) => {
        const ref = refs[i];
        const name = ix.read(result, ref.name);
        if (typeof name === "string" && name.trim()) p.name = name.trim().slice(0, KUJI_NAME_MAX);

        const ticketsText = ix.read(result, ref.tickets);
        if (typeof ticketsText === "string") {
            const t = toHalfWidthDigits(ticketsText);
            if (/^\d+$/.test(t) && Number(t) <= 99999) {
                if (Number(t) !== p.tickets) { p.tickets = Number(t); p.dirty = true; }
            } else {
                errors.push(`${p.name}の本数「${ticketsText}」は0以上の数字で入力してください`);
            }
        }

        if (ix.read(result, ref.remove) === true) return; // deleted
        if (ix.read(result, ref.reselect) === true && reselectIndex < 0) reselectIndex = keep.length;
        keep.push(p);
    });
    work.presets = keep;
    for (const message of errors) tell(player, `§c[くじ] ${message}`);

    const wantsNew = newRef && ix.read(result, newRef) === true;
    if (wantsNew) {
        showKujiSelector(player, rec, work, { editIndex: -1, counts: new Map(), current: null });
        return;
    }
    if (reselectIndex >= 0) {
        const p = work.presets[reselectIndex];
        showKujiSelector(player, rec, work, {
            editIndex: reselectIndex,
            counts: new Map(p.items.map(it => [it.id, it.count])),
            current: null
        });
        return;
    }

    finishKujiEditor(player, rec, work);
}

function finishKujiEditor(player, rec, work) {
    const block = resolve(rec);
    if (!block || block.typeId !== PANEL_ID) {
        tell(player, "§c[くじ] ショップブロックを取得できませんでした");
        return;
    }

    for (const p of work.presets) {
        if (p.dirty) p.remaining = p.tickets;          // changed -> start over
        p.remaining = Math.min(p.remaining, p.tickets);
    }
    saveKujiPresets(block, work.presets);
    refreshTextDisplayPayloads(block, getContainer(block));

    // Stock check: every ticket must be payable.
    const need = new Map();
    for (const p of work.presets) {
        for (const it of p.items) need.set(it.id, (need.get(it.id) ?? 0) + it.count * p.tickets);
    }
    const stock = kujiStockTotals(block);
    const short = [...need].filter(([id, n]) => (stock.get(id) ?? 0) < n);

    const total = work.presets.reduce((a, p) => a + p.tickets, 0);
    tell(player, `§a[くじ] ${work.presets.length}種・全${total}本で保存しました §7（ショップを開くと表示）`);
    for (const [id, n] of short) {
        player.sendMessage({ rawtext: [
            { text: "§e[くじ] 在庫が足りません: " }, itemNameRaw(id),
            { text: ` 必要${n}個 / 在庫${stock.get(id) ?? 0}個` }
        ] });
    }
}

async function showKujiSelector(player, rec, work, state) {
    const block = resolve(rec);
    if (!block || block.typeId !== PANEL_ID) {
        tell(player, "§c[くじ] ショップブロックを取得できませんでした");
        return;
    }

    const stock = kujiStockTotals(block);
    const ids = [...stock.keys()];
    for (const id of state.counts.keys()) if (!stock.has(id)) ids.push(id);

    const title = state.editIndex >= 0
        ? `${work.presets[state.editIndex].name}の中身`
        : `プリセット${work.presets.length + 1}の中身`;
    const form = new ActionFormData().title(title);
    const selected = [...state.counts].filter(([, n]) => n > 0);
    form.body(selected.length
        ? { rawtext: [{ text: "選択中: " }, ...itemsRaw(selected.map(([id, count]) => ({ id, count })))] }
        : "アイテムを押して選び、＋／－で数を決めます");

    const actions = [];
    if (ids.length === 0) {
        form.body("在庫にアイテムがありません。先にショップの在庫欄にアイテムを入れてください。");
    }
    for (const id of ids) {
        const count = state.counts.get(id) ?? 0;
        const have = stock.get(id) ?? 0;
        const isCurrent = state.current === id;
        const head = isCurrent ? "§a▶ " : count > 0 ? "§r✔ " : "§r";
        const tail = count > 0 ? ` ×${count}` : "";
        form.button({ rawtext: [{ text: head }, itemNameRaw(id), { text: `${tail}\n§8在庫 ${have}` }] }, itemIconPath(id));
        actions.push({ type: "pick", id });
        if (isCurrent) {
            form.button("§a＋ 増やす"); actions.push({ type: "inc" });
            form.button("§c－ 減らす"); actions.push({ type: "dec" });
        }
    }
    form.button("選び直す"); actions.push({ type: "clear" });
    form.button("§2このプリセットを保存"); actions.push({ type: "save" });
    form.button("戻る（保存しない）"); actions.push({ type: "back" });

    const result = await showFormWithRetry(player, form);
    if (!result) {
        tell(player, "§c[くじ] フォームを表示できませんでした");
        return;
    }
    const action = result.canceled ? { type: "back" } : actions[result.selection];
    if (!action) { showKujiList(player, rec, work); return; }

    const have = (id) => stock.get(id) ?? 0;
    switch (action.type) {
        case "pick":
            state.current = action.id;
            if (!state.counts.get(action.id)) {
                if (have(action.id) > 0) state.counts.set(action.id, 1);
                else tell(player, "§e[くじ] このアイテムは在庫がありません");
            }
            break;
        case "inc": {
            const n = state.counts.get(state.current) ?? 0;
            if (n >= have(state.current)) tell(player, "§e[くじ] 在庫の数より多くはできません");
            else state.counts.set(state.current, n + 1);
            break;
        }
        case "dec": {
            const n = (state.counts.get(state.current) ?? 0) - 1;
            if (n <= 0) { state.counts.delete(state.current); state.current = null; }
            else state.counts.set(state.current, n);
            break;
        }
        case "clear":
            state.counts.clear();
            state.current = null;
            break;
        case "save": {
            const items = [...state.counts].filter(([, n]) => n > 0).map(([id, count]) => ({ id, count }));
            if (items.length === 0) {
                tell(player, "§e[くじ] アイテムが選ばれていません");
                break;
            }
            let name;
            if (state.editIndex >= 0) {
                const p = work.presets[state.editIndex];
                p.items = items; p.dirty = true; name = p.name;
            } else {
                name = `プリセット${work.presets.length + 1}`;
                work.presets.push({ name, tickets: 1, remaining: 1, items, dirty: true });
            }
            tell(player, `§a[くじ] ${name}を保存しました`);
            showKujiList(player, rec, work);
            return;
        }
        case "back":
            showKujiList(player, rec, work);
            return;
    }
    showKujiSelector(player, rec, work, state);
}

// ============================================================
// くじ 編集モード (v36) — edited INSIDE the shop screen, no re-seat.
//
// Slot50 = 5 shows the edit layout (settings panel + pencil hidden,
// くじ stock and the 3 くじ toggles on the right).
//   A..G賞 contents : KUJI_TIER_SLOTS (7 x 3, real items dragged in)
//   A..G賞 names    : 9..15 (probe names "A賞（2本）")
//   48/52/53 = くじ toggles / 49 = 名前・本数を編集 (pencil)
//   保存 (closes) = save & finish / キャンセル = stop without saving
// Tier slots hold the contents of ONE ticket. Leaving edit mode records
// them and moves the items back to the stock.
// KUJI_EDITING_PROP keeps the mode across the names form and crashes:
// arm() resumes edit mode instead of writing control probes over items.
// ============================================================
const KUJI_EDIT_MODE = 5;
const KUJI_EDITING_PROP = "shop_kuji_editing";
const KUJI_DEFAULT_NAMES = ["A賞", "B賞", "C賞", "D賞", "E賞", "F賞", "G賞"];
const KUJI_TIER_SLOTS = [
    [26, 27, 28], [29, 30, 31], [32, 33, 34], [35, 36, 38],
    [39, 41, 42], [43, 44, 45], [46, 47, 51]
];
const KUJI_ALL_TIER_SLOTS = KUJI_TIER_SLOTS.flat();
const KUJI_NAME_SLOTS = [9, 10, 11, 12, 13, 14, 15];
const KUJI_EDIT_NAMES_SLOT = 49;
// Toggles shown at the top of the right column while editing.
// (Their effect belongs to the purchase logic.)
//   show_remaining: buyers can see each prize's remaining tickets
//   announce      : broadcast every draw result to all players
//   revive        : a prize at 0 left comes back (up to its tickets)
//                   as long as the stock can pay one more ticket
const KUJI_TOGGLES = [
    { slot: 48, prop: "shop_kuji_show_remaining", defaultOn: true },
    { slot: 52, prop: "shop_kuji_announce", defaultOn: false },
    { slot: 53, prop: "shop_kuji_revive", defaultOn: false }
];
function kujiToggleOn(block, t) {
    const v = getPersistedNumberProp(block, t.prop, t.defaultOn ? 1 : 0);
    return v === 1;
}

function loadKujiTiers(block) {
    const list = loadKujiPresets(block);
    return KUJI_DEFAULT_NAMES.map((def, i) => list[i] ?? { name: def, tickets: 1, remaining: 1, items: [] });
}

function kujiTierLabel(t) {
    return t.tickets === 0 ? `${t.name}（無効）` : `${t.name}（${t.tickets}本）`;
}

function stackLimit(item) {
    try { return item.maxAmount ?? 64; } catch { return 64; }
}

function canStack(a, b) {
    try { if (typeof a.isStackableWith === "function") return a.isStackableWith(b); } catch {}
    return a.typeId === b.typeId && a.nameTag === b.nameTag;
}

// Puts `item` into the given slots (merge first, then empty). Returns leftover.
function putIntoSlots(container, slots, item) {
    let rest = item;
    for (const slot of slots) {
        if (!rest) return undefined;
        const cur = container.getItem(slot);
        if (!cur || isProbe(cur) || !canStack(cur, rest)) continue;
        const room = stackLimit(cur) - cur.amount;
        if (room <= 0) continue;
        const move = Math.min(room, rest.amount);
        cur.amount += move;
        container.setItem(slot, cur);
        if (move >= rest.amount) return undefined;
        rest = rest.clone(); rest.amount -= move;
    }
    for (const slot of slots) {
        if (!rest) return undefined;
        const cur = container.getItem(slot);
        if (cur && !isProbe(cur)) continue;
        container.setItem(slot, rest);
        return undefined;
    }
    return rest;
}

function dropAtBlock(block, item) {
    try {
        const l = block.location;
        block.dimension.spawnItem(item, { x: l.x + 0.5, y: l.y + 1, z: l.z + 0.5 });
    } catch {}
}

function returnToKujiStock(block, container, player, item) {
    const rest = putIntoSlots(container, SALE_LAYOUTS[2].stock, item);
    if (!rest) return false;
    if (player) giveOrDrop(player, rest); else dropAtBlock(block, rest);
    return true;
}

// Removes up to `count` of the item with identity `key` from the stock.
function takeFromKujiStock(container, key, count) {
    const pieces = [];
    for (const slot of SALE_LAYOUTS[2].stock) {
        if (count <= 0) break;
        const item = container.getItem(slot);
        if (!item || isProbe(item) || itemKey(item) !== key) continue;
        const n = Math.min(item.amount, count);
        const piece = item.clone(); piece.amount = n;
        pieces.push(piece);
        if (n >= item.amount) container.setItem(slot, undefined);
        else { item.amount -= n; container.setItem(slot, item); }
        count -= n;
    }
    return pieces;
}

function tierItemsFromSlots(container, k) {
    const byKey = new Map();
    for (const slot of KUJI_TIER_SLOTS[k]) {
        const item = container.getItem(slot);
        if (!item || isProbe(item)) continue;
        const key = itemKey(item);
        const cur = byKey.get(key);
        if (cur) cur.count += item.amount;
        else byKey.set(key, itemEntry(item, item.amount));
    }
    return [...byKey.values()];
}

function kujiEditTotals(container) {
    const totals = new Map();
    for (const slot of [...SALE_LAYOUTS[2].stock, ...KUJI_ALL_TIER_SLOTS]) {
        const item = container.getItem(slot);
        if (!item || isProbe(item)) continue;
        const key = itemKey(item);
        totals.set(key, (totals.get(key) ?? 0) + item.amount);
    }
    return totals;
}

// "A賞 2本・16回分" (red when the stock cannot pay every ticket)
function kujiEditLabel(t, cap) {
    if (t.tickets === 0) return fitWidth(`${t.name}（無効）`, 20);
    if (cap === null) return fitWidth(`${t.name} ${t.tickets}本`, 20);
    const color = cap < t.tickets ? "§c" : "";
    return color + fitWidth(`${t.name} ${t.tickets}本・${cap}回分`, 20);
}

function kujiEditSignature(container) {
    const parts = [];
    for (const slot of [...SALE_LAYOUTS[2].stock, ...KUJI_ALL_TIER_SLOTS]) {
        const item = container.getItem(slot);
        parts.push(item && !isProbe(item) ? `${item.typeId}:${item.amount}` : "");
    }
    return parts.join("|");
}

function writeKujiEditLabels(block, container) {
    const tiers = loadKujiTiers(block);
    const totals = kujiEditTotals(container);
    tiers.forEach((t, k) => {
        const probe = new ItemStack(PROBE_ID, 1);
        probe.nameTag = kujiEditLabel(t, kujiCapacity(tierItemsFromSlots(container, k), totals));
        container.setItem(KUJI_NAME_SLOTS[k], probe);
    });
}

// Items moved while editing: rewrite the labels, let the client re-read,
// then hide (slot40=1) and show (=2) the name labels once so they read the
// new text ("visibility_changed" labels never re-read while visible).
function refreshKujiEditLabels(player, rec, block, container) {
    writeKujiEditLabels(block, container);
    touchPlayerInventory(player);
    rec.kujiLabelsPending = true;
    const playerId = player.id;
    system.runTimeout(() => {
        if (active.get(playerId) !== rec || !rec.kujiEditing) { rec.kujiLabelsPending = false; return; }
        const c = getContainer(resolve(rec));
        if (c) setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_HIDDEN);
    }, VISUAL_COMMIT_DELAY_TICKS);
    system.runTimeout(() => {
        rec.kujiLabelsPending = false;
        if (active.get(playerId) !== rec || !rec.kujiEditing) return;
        const c = getContainer(resolve(rec));
        if (c) setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);
    }, VISUAL_COMMIT_DELAY_TICKS + 1);
}

// Prepares the edit slots; the layout is shown 2 ticks later (after the
// client re-read the names), like every other visibility switch.
function armKujiEdit(player, rec, block, container) {
    rec.kujiEditing = true;
    setProbe(container, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE); // hide all layouts until edit UI is ready
    setTextGate(container, false);
    for (const slot of KUJI_ALL_TIER_SLOTS) {
        const item = container.getItem(slot);
        if (item && isProbe(item)) container.setItem(slot, undefined); // real items stay
    }
    writeKujiEditLabels(block, container);
    setProbe(container, KUJI_EDIT_NAMES_SLOT, 1);
    for (const t of KUJI_TOGGLES) setProbe(container, t.slot, kujiToggleOn(block, t) ? 3 : 2);
    setProbe(container, FOOTER_CANCEL_SLOT, 1);
    setProbe(container, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);   // edit name labels visible with the layout
    rec.kujiSignature = kujiEditSignature(container);
    deferVisualCommit(player, rec, (b, c) => {
        setProbe(c, SALE_LAYOUT_SLOT, KUJI_EDIT_MODE);
        touchPlayerInventory(player);
    });
}

function enterKujiEdit(player, rec, block, container) {
    setPersistedNumberProp(block, KUJI_EDITING_PROP, 1);
    for (const slot of KUJI_ALL_TIER_SLOTS) {
        const item = container.getItem(slot);
        if (item && isProbe(item)) container.setItem(slot, undefined);
    }
    // Put the saved contents back into the tier slots (taken from stock).
    const missing = [];
    loadKujiTiers(block).forEach((t, k) => {
        for (const it of t.items) {
            const pieces = takeFromKujiStock(container, entryKey(it), it.count);
            const got = pieces.reduce((a, p) => a + p.amount, 0);
            if (got < it.count) missing.push(`${t.name}: ${it.name ? `『${it.name}』` : itemShortName(it.id)} ${it.count - got}個`);
            for (const piece of pieces) {
                const rest = putIntoSlots(container, KUJI_TIER_SLOTS[k], piece);
                if (rest) returnToKujiStock(block, container, player, rest);
            }
        }
    });
    armKujiEdit(player, rec, block, container);
    tell(player, "§a[くじ] 編集モード：在庫から各賞の枠へアイテムを置いてください（1回分の中身）");
    for (const m of missing) tell(player, `§e[くじ] 在庫に足りず並べられなかった分: ${m}`);
}

function exitKujiEdit(player, rec, block, container, save, rebuild) {
    const tiers = loadKujiTiers(block);
    if (save) {
        tiers.forEach((t, k) => {
            const items = tierItemsFromSlots(container, k);
            if (JSON.stringify(items) !== JSON.stringify(t.items)) {
                t.items = items;
                t.remaining = t.tickets;
            }
        });
        saveKujiPresets(block, tiers);
    }
    let overflow = false;
    for (const slot of KUJI_ALL_TIER_SLOTS) {
        const item = container.getItem(slot);
        if (!item) continue;
        container.setItem(slot, undefined);
        if (!isProbe(item) && returnToKujiStock(block, container, player, item)) overflow = true;
    }
    setPersistedNumberProp(block, KUJI_EDITING_PROP, 0);
    if (rec) rec.kujiEditing = false;

    if (save) {
        const used = tiers.filter(t => t.items.length > 0);
        const total = used.reduce((a, t) => a + t.tickets, 0);
        tell(player, `§a[くじ] ${used.length}種・全${total}本で保存しました`);
        const need = new Map();
        for (const t of used) for (const it of t.items) {
            const key = entryKey(it);
            const cur = need.get(key) ?? { item: it, n: 0 };
            cur.n += it.count * t.tickets;
            need.set(key, cur);
        }
        const stock = kujiStockTotals(block);
        for (const [key, { item, n }] of need) {
            if ((stock.get(key) ?? 0) < n) {
                try {
                    player?.sendMessage({ rawtext: [{ text: "§e[くじ] 在庫が足りません: " },
                        ...itemsRaw([{ ...item, count: n }]).slice(0, 1),
                        { text: `${item.enchanted ? "✦" : ""} 必要${n}個 / 在庫${stock.get(key) ?? 0}個` }] });
                } catch {}
            }
        }
    } else {
        tell(player, "§7[くじ] 保存せずに編集をやめました");
    }
    if (overflow) tell(player, "§e[くじ] 在庫に入りきらないアイテムは手持ちに戻しました");

    if (rebuild && player) arm(player, block);   // back to the normal screen
}

// Runs instead of the normal tick while editing.
function tickKujiEdit(player, rec, block, container) {
    if (!rec.kujiLabelsPending) {
        const sig = kujiEditSignature(container);
        if (sig !== rec.kujiSignature) {
            rec.kujiSignature = sig;
            refreshKujiEditLabels(player, rec, block, container);
        }
    }
    for (const t of KUJI_TOGGLES) {
        const on = kujiToggleOn(block, t);
        if (!signalIntact(container, t.slot, on ? 3 : 2)) {
            setPersistedNumberProp(block, t.prop, on ? 0 : 1);
            setProbe(container, t.slot, on ? 2 : 3);
            return true;
        }
    }
    if (!isProbe(container.getItem(FOOTER_CANCEL_SLOT))) {
        exitKujiEdit(player, rec, block, container, false, true);
        return true;
    }
    if (!isProbe(container.getItem(KUJI_EDIT_NAMES_SLOT))) {
        setProbe(container, KUJI_EDIT_NAMES_SLOT, 1);
        openKujiNamesForm(player, rec, block);
        return true;
    }
    return false;
}

function openKujiNamesForm(player, rec, block) {
    active.delete(player.id);   // screen closes; the flag keeps edit mode
    const playerId = player.id;
    const ok = forceCloseScreen(player, block, () => showKujiNamesForm(playerId, rec));
    if (!ok) {
        active.set(player.id, rec);
        tell(player, "§c[くじ] 画面を閉じられませんでした");
    }
}

async function showKujiNamesForm(playerId, rec) {
    const player = findPlayer(playerId);
    const block = resolve(rec);
    if (!player || !block || block.typeId !== PANEL_ID) return;
    const container = getContainer(block);
    const tiers = loadKujiTiers(block);

    const form = new ModalFormData().title("くじ：名前・本数");
    const ix = makeFormIndexer();
    const refs = [];
    tiers.forEach((t, k) => {
        if (k > 0) { form.divider(); ix.other(); }
        const items = container ? tierItemsFromSlots(container, k) : t.items;
        const cap = container ? kujiCapacity(items, kujiEditTotals(container)) : null;
        const capText = cap === null ? "" : `  §7（在庫で${cap}回分）`;
        form.label({ rawtext: [{ text: `§e${KUJI_DEFAULT_NAMES[k]}の枠§r：` }, ...itemsRaw(items), { text: capText }] }); ix.other();
        const ref = {};
        form.textField("名前", KUJI_DEFAULT_NAMES[k], { defaultValue: t.name }); ref.name = ix.input();
        form.textField("本数（数字・0で無効）", "例: 2", { defaultValue: String(t.tickets) }); ref.tickets = ix.input();
        refs.push(ref);
    });
    form.submitButton("決定");

    const result = await showFormWithRetry(player, form);
    if (!result || result.canceled) {
        tell(player, "§7[くじ] 名前・本数は変更していません §8（ショップを開くと編集の続きに戻ります）");
        return;
    }
    const errors = [];
    tiers.forEach((t, k) => {
        const name = ix.read(result, refs[k].name);
        if (typeof name === "string" && name.trim()) t.name = name.trim().slice(0, KUJI_NAME_MAX);
        const raw = ix.read(result, refs[k].tickets);
        if (typeof raw === "string") {
            const v = toHalfWidthDigits(raw);
            if (/^\d+$/.test(v) && Number(v) <= 99999) {
                if (Number(v) !== t.tickets) { t.tickets = Number(v); t.remaining = t.tickets; }
            } else {
                errors.push(`${t.name}の本数「${raw}」は0以上の数字で入力してください`);
            }
        }
    });
    saveKujiPresets(block, tiers);
    for (const m of errors) tell(player, `§c[くじ] ${m}`);
    tell(player, "§a[くじ] 名前・本数を保存しました §7（ショップを開くと編集の続きに戻ります）");
}

// ============================================================
// 店舗 (v50) — stage 1 foundation
//   world property STORE_REGISTRY_PROP : { nextId, stores: { id: {
//       id, name, description, owner: { id, name }, createdAt } } }
//   block property BLOCK_STORE_PROP    : the store this product belongs to
// Sneak + interact with a shop block opens the store menu (no slot used).
// A product in a store can only be edited by the store owner / operators;
// everyone else will get the purchase screen (stage 2).
// A product in no store keeps the old behaviour (anyone can edit).
// ============================================================
const STORE_REGISTRY_PROP = "shop_store_registry";
const BLOCK_STORE_PROP = "shop_store_id";
const BLOCK_DEPT_PROP = "shop_dept_id";   // 売り場 (department) of this product
const DEPT_NAME_MAX = 16;
const GROUP_NAME_MAX = 24;
const STORE_NAME_MAX = 24;
const STORE_DESC_MAX = 80;

function loadStores() {
    try {
        const raw = world.getDynamicProperty(STORE_REGISTRY_PROP);
        const d = typeof raw === "string" ? JSON.parse(raw) : null;
        const reg = {
            nextId: Number(d?.nextId) || 1,
            stores: d?.stores && typeof d.stores === "object" ? d.stores : {},
            nextGroupId: Number(d?.nextGroupId) || 1,
            groups: d?.groups && typeof d.groups === "object" ? d.groups : {}
        };
        for (const st of Object.values(reg.stores)) {
            if (!Array.isArray(st.departments)) st.departments = [];
            if (!st.nextDeptId) st.nextDeptId = 1;
        }
        return reg;
    } catch {
            try {
        for (const store of Object.values(data.stores ?? {})) {
            if (store && String(store.name ?? "").trim() === "新しい店舗") store.name = "";
        }
    } catch {}
return { nextId: 1, stores: {}, nextGroupId: 1, groups: {} };
    }
}

function saveStores(reg) {
    try {
        world.setDynamicProperty(STORE_REGISTRY_PROP, JSON.stringify(reg));
        return true;
    } catch {
        return false;
    }
}

function getBlockStoreId(block) {
    try {
        const v = getProps(block)?.get(BLOCK_STORE_PROP);
        return typeof v === "string" && v ? v : undefined;
    } catch {
        return undefined;
    }
}

function setBlockStoreId(block, id) {
    const dp = getProps(block);
    if (!dp) return false;
    try {
        if (id) dp.set(BLOCK_STORE_PROP, id);
        else if (dp.get(BLOCK_STORE_PROP) !== undefined) dp.set(BLOCK_STORE_PROP, undefined);
        return true;
    } catch {
        return false;
    }
}

function getBlockDeptId(block) {
    try {
        const v = getProps(block)?.get(BLOCK_DEPT_PROP);
        return typeof v === "string" && v ? v : undefined;
    } catch {
        return undefined;
    }
}

function setBlockDeptId(block, id) {
    const dp = getProps(block);
    if (!dp) return false;
    try {
        if (id) dp.set(BLOCK_DEPT_PROP, id);
        else if (dp.get(BLOCK_DEPT_PROP) !== undefined) dp.set(BLOCK_DEPT_PROP, undefined);
        return true;
    } catch {
        return false;
    }
}

// The product's department, only if it still exists in its store.
function blockDept(block, store) {
    const id = getBlockDeptId(block);
    return id && store ? store.departments.find(d => d.id === id) : undefined;
}

function canManageGroup(player, group) {
    return !!group && (group.owner?.id === player.id || isOperator(player));
}

function isOperator(player) {
    try { if (player.playerPermissionLevel === 2) return true; } catch {}
    try { if (typeof player.isOp === "function" && player.isOp()) return true; } catch {}
    return false;
}

function canManageStore(player, store) {
    return !!store && (store.owner?.id === player.id || isOperator(player));
}

function blockStore(block) {
    const id = getBlockStoreId(block);
    return id ? loadStores().stores[id] : undefined;
}

// May this player open the product settings screen?
function canEditBlock(player, block) {
    const store = blockStore(block);
    return !store || canManageStore(player, store);
}

async function showStoreMenu(player, dimension, location) {
    let block;
    try { block = dimension.getBlock(location); } catch {}
    if (!player || !block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const sid = getBlockStoreId(block);
    const store = sid ? reg.stores[sid] : undefined;
    const manage = !store || canManageStore(player, store);
    const group = store?.groupId ? reg.groups[store.groupId] : undefined;
    const dept = blockDept(block, store);

    const lines = [];
    if (store) {
        lines.push(`この商品の店舗: §e${store.name}§r`);
        lines.push(`オーナー: ${store.owner?.name ?? "不明"}`);
        if (group) lines.push(`系列: ${group.name}（${group.headId === store.id ? "本店" : "支店"}）`);
        lines.push(`売り場: ${dept ? dept.name : "なし"}`);
        if (store.description) lines.push("", store.description);
    } else {
        lines.push("この商品は、どの店舗にも入っていません。");
    }
    const form = new ActionFormData().title("店舗設定").body(lines.join("\n"));
    const actions = [];
    if (manage) { form.button("店舗を選ぶ・作る"); actions.push("pick"); }
    if (store && manage) {
        form.button("売り場を選ぶ"); actions.push("dept");
        form.button("売り場の管理"); actions.push("depts");
        form.button("系列店・支店"); actions.push("group");
        form.button("店舗の基本情報を編集"); actions.push("info");
    }
    form.button("閉じる"); actions.push("close");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const act = actions[res.selection];
    if (act === "pick") return showStorePicker(player, dimension, location);
    if (act === "dept") return showDeptPicker(player, dimension, location);
    if (act === "depts") return showDeptManager(player, dimension, location);
    if (act === "group") return showGroupMenu(player, dimension, location);
    if (act === "info") return showStoreInfoForm(player, dimension, location, store.id);
}

// ---------------- 売り場 ----------------
async function showDeptPicker(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    const current = blockDept(block, store)?.id;

    const form = new ActionFormData().title("売り場を選ぶ").body(`店舗「${store.name}」の売り場から選んでください。`);
    const actions = [];
    for (const d of store.departments) {
        form.button(`${d.id === current ? "§a▶ " : ""}${d.name}`);
        actions.push({ type: "set", id: d.id });
    }
    form.button("＋ 新しい売り場を作る"); actions.push({ type: "new" });
    form.button(`${current ? "" : "§a▶ "}売り場なし`); actions.push({ type: "set", id: undefined });
    form.button("戻る"); actions.push({ type: "back" });
    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const act = actions[res.selection];
    if (!act || act.type === "back") return storeFormDone(player);
    if (act.type === "new") {
        const name = await askName(player, "新しい売り場", "売り場名", "例: 食料品", "", DEPT_NAME_MAX);
        if (name) {
            const fresh = loadStores();
            const st = fresh.stores[store.id];
            const id = `d${st.nextDeptId}`;
            st.nextDeptId += 1;
            st.departments.push({ id, name });
            saveStores(fresh);
            setBlockDeptId(dimension.getBlock(location), id);
            tell(player, `§a[店舗] 売り場「${name}」を作り、この商品を入れました`);
        }
        return storeFormDone(player);
    }
    setBlockDeptId(dimension.getBlock(location), act.id);
    tell(player, act.id ? `§a[店舗] この商品を売り場「${store.departments.find(d => d.id === act.id)?.name}」に入れました`
                        : "§7[店舗] この商品を売り場から外しました");
    return storeFormDone(player);
}

async function showDeptManager(player, dimension, location) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(dimension.getBlock(location))];
    if (!store || !canManageStore(player, store)) return;
    const form = new ActionFormData().title("売り場の管理")
        .body(store.departments.length ? "編集する売り場を選んでください。" : "売り場がありません。");
    for (const d of store.departments) form.button(d.name);
    form.button("戻る");
    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const d = store.departments[res.selection];
    if (!d) return storeFormDone(player);

    const f2 = new ModalFormData().title(`売り場「${d.name}」`);
    f2.textField("売り場名", "例: 食料品", { defaultValue: d.name });
    f2.toggle("§cこの売り場を削除する", { defaultValue: false });
    f2.submitButton("保存");
    const r2 = await showFormWithRetry(player, f2);
    if (!r2 || r2.canceled) return showDeptManager(player, dimension, location);
    const vals = r2.formValues ?? [];
    const name = String(vals.find(v => typeof v === "string") ?? "").trim().replace(/§/g, "").slice(0, DEPT_NAME_MAX);
    const remove = vals.some(v => v === true);
    const fresh = loadStores();
    const st = fresh.stores[store.id];
    if (remove) {
        st.departments = st.departments.filter(x => x.id !== d.id);
        tell(player, `§7[店舗] 売り場「${d.name}」を削除しました（この売り場の商品は「売り場なし」になります）`);
    } else if (name) {
        const target = st.departments.find(x => x.id === d.id);
        if (target) target.name = name;
        tell(player, `§a[店舗] 売り場名を「${name}」にしました`);
    }
    saveStores(fresh);
    return showDeptManager(player, dimension, location);
}

// ---------------- 系列店・支店 ----------------
async function showGroupMenu(player, dimension, location) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(dimension.getBlock(location))];
    if (!store || !canManageStore(player, store)) return;
    const group = store.groupId ? reg.groups[store.groupId] : undefined;
    const form = new ActionFormData().title("系列店・支店");
    const actions = [];
    if (group) {
        const members = Object.values(reg.stores).filter(st => st.groupId === group.id);
        form.body([`グループ: §e${group.name}§r（オーナー: ${group.owner?.name ?? "不明"}）`, "",
            ...members.map(st => `${st.id === group.headId ? "【本店】" : "【支店】"} ${st.name}`)].join("\n"));
        if (canManageGroup(player, group)) {
            form.button("グループ名を変更"); actions.push("rename");
            if (group.headId !== store.id) { form.button("この店舗を本店にする"); actions.push("head"); }
        }
        form.button("この店舗をグループから抜く"); actions.push("leave");
    } else {
        form.body("この店舗は、どの系列グループにも入っていません。");
        form.button("新しい系列グループを作る\n§8（この店舗が本店）"); actions.push("create");
        form.button("既存のグループに支店として入る"); actions.push("join");
    }
    form.button("戻る"); actions.push("back");
    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const act = actions[res.selection];
    if (!act || act === "back") return storeFormDone(player);

    const fresh = loadStores();
    const st = fresh.stores[store.id];
    if (act === "create") {
        const name = await askName(player, "新しい系列グループ", "グループ名", "例: 中央マーケットグループ", `${store.name}グループ`.slice(0, GROUP_NAME_MAX), GROUP_NAME_MAX);
        if (name) {
            const f = loadStores();
            const gid = `g${f.nextGroupId}`;
            f.nextGroupId += 1;
            f.groups[gid] = { id: gid, name, owner: { id: player.id, name: player.name }, headId: store.id };
            f.stores[store.id].groupId = gid;
            saveStores(f);
            tell(player, `§a[店舗] 系列グループ「${name}」を作り、「${store.name}」を本店にしました`);
        }
    } else if (act === "join") {
        const groups = Object.values(fresh.groups).filter(g => canManageGroup(player, g));
        if (groups.length === 0) {
            tell(player, "§e[店舗] 参加できる系列グループがありません（グループのオーナーだけが支店を追加できます）");
        } else {
            const f2 = new ActionFormData().title("支店として入るグループ");
            for (const g of groups) f2.button(`${g.name}\n§8本店: ${fresh.stores[g.headId]?.name ?? "なし"}`);
            f2.button("戻る");
            const r2 = await showFormWithRetry(player, f2);
            const g = r2 && !r2.canceled ? groups[r2.selection] : undefined;
            if (g) {
                const f = loadStores();
                f.stores[store.id].groupId = g.id;
                if (!f.stores[g.headId]) f.groups[g.id].headId = store.id;
                saveStores(f);
                tell(player, `§a[店舗] 「${store.name}」を「${g.name}」の支店にしました`);
            }
        }
    } else if (act === "rename") {
        const g = fresh.groups[st.groupId];
        const name = await askName(player, "グループ名の変更", "グループ名", "", g.name, GROUP_NAME_MAX);
        if (name) { const f = loadStores(); f.groups[g.id].name = name; saveStores(f); tell(player, `§a[店舗] グループ名を「${name}」にしました`); }
    } else if (act === "head") {
        fresh.groups[st.groupId].headId = st.id;
        saveStores(fresh);
        tell(player, `§a[店舗] 「${st.name}」を本店にしました`);
    } else if (act === "leave") {
        const gid = st.groupId;
        delete st.groupId;
        const rest = Object.values(fresh.stores).filter(x => x.groupId === gid);
        const g = fresh.groups[gid];
        if (rest.length === 0) {
            delete fresh.groups[gid];
            tell(player, `§7[店舗] グループ「${g?.name}」は店舗がなくなったため解散しました`);
        } else {
            if (g && g.headId === st.id) {
                g.headId = rest[0].id;
                tell(player, `§7[店舗] 本店が抜けたため、「${rest[0].name}」を新しい本店にしました`);
            }
            tell(player, `§7[店舗] 「${st.name}」をグループから抜きました`);
        }
        saveStores(fresh);
    }
    return showGroupMenu(player, dimension, location);
}

// One-field name form; returns the trimmed name or undefined.
async function askName(player, title, label, placeholder, current, max) {
    const f = new ModalFormData().title(title);
    f.textField(label, placeholder, { defaultValue: current ?? "" });
    f.submitButton("決定");
    const r = await showFormWithRetry(player, f);
    if (!r || r.canceled) return undefined;
    const v = (r.formValues ?? []).find(x => typeof x === "string");
    const name = String(v ?? "").trim().replace(/§/g, "").slice(0, max);
    if (!name) { tell(player, "§c[店舗] 名前を入力してください"); return undefined; }
    return name;
}

async function showStorePicker(player, dimension, location) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const current = getBlockStoreId(block);
    const mine = Object.values(reg.stores).filter(st => canManageStore(player, st));

    const form = new ActionFormData().title("店舗を選ぶ");
    form.body(mine.length ? "この商品を入れる店舗を選んでください。" : "管理している店舗がありません。新しく作ってください。");
    const actions = [];
    for (const st of mine) {
        form.button(`${st.id === current ? "§a▶ " : ""}${st.name}\n§8オーナー: ${st.owner?.name ?? "不明"}`);
        actions.push({ type: "assign", id: st.id });
    }
    form.button("＋ 新しい店舗を作る"); actions.push({ type: "create" });
    if (current) { form.button("どの店舗にも入れない"); actions.push({ type: "remove" }); }
    form.button("戻る"); actions.push({ type: "back" });

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const act = actions[res.selection];
    if (!act || act.type === "back") return storeFormDone(player);
    if (act.type === "create") return showStoreInfoForm(player, dimension, location, undefined);
    const b = dimension.getBlock(location);
    if (act.type === "assign") {
        if (act.id !== current) setBlockDeptId(b, undefined);
        setBlockStoreId(b, act.id);
        tell(player, `§a[店舗] この商品を「${reg.stores[act.id].name}」に入れました`);
    } else if (act.type === "remove") {
        setBlockStoreId(b, undefined);
        setBlockDeptId(b, undefined);
        tell(player, "§7[店舗] この商品を店舗から外しました");
    }
    return storeFormDone(player);
}

// storeId undefined -> create a new store owned by the player and assign it
async function showStoreInfoForm(player, dimension, location, storeId) {
    const reg = loadStores();
    const store = storeId ? reg.stores[storeId] : undefined;
    if (store && !canManageStore(player, store)) return;

    const form = new ModalFormData().title(store ? "店舗の基本情報" : "新しい店舗");
    form.textField("店舗名", "例: 中央マーケット", { defaultValue: store?.name ?? "" });
    form.textField("店舗説明", "例: 食料と日用品の店", { defaultValue: store?.description ?? "" });
    form.submitButton(store ? "保存" : "作成");
    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return storeFormDone(player);

    const values = (res.formValues ?? []).filter(v => typeof v === "string");
    const name = String(values[0] ?? "").trim().replace(/§/g, "").slice(0, STORE_NAME_MAX);
    const description = String(values[1] ?? "").trim().replace(/§/g, "").slice(0, STORE_DESC_MAX);
    if (!name) {
        tell(player, "§c[店舗] 店舗名を入力してください");
        return storeFormDone(player);
    }

    const fresh = loadStores();
    if (store) {
        const st = fresh.stores[store.id];
        if (st) { st.name = name; st.description = description; }
        saveStores(fresh);
        tell(player, `§a[店舗] 「${name}」の基本情報を保存しました`);
    } else {
        const id = `s${fresh.nextId}`;
        fresh.nextId += 1;
        fresh.stores[id] = { id, name, description, owner: { id: player.id, name: player.name }, createdAt: Date.now() };
        saveStores(fresh);
        setBlockStoreId(dimension.getBlock(location), id);
        setBlockDeptId(dimension.getBlock(location), undefined);
        tell(player, `§a[店舗] 店舗「${name}」を作り、この商品を入れました`);
    }
    return storeFormDone(player);
}

// ============================================================
// 店舗設定 (v52) — edited INSIDE the shop screen (slot50 = 6)
// Entry: the store button next to the pencil (slot 35 click).
// Left page: 2 dropdowns (this product's store / department) and
// 4 fields (store name, description, owner, group). Right: buttons.
// Dropdown: header slot count 3 = closed / 2 = open (same as the other
// dropdowns); option slot count 2 = choice, 3 = selected, 4 = hidden.
// Text input opens a form; reopening the shop returns to this page.
// ============================================================
const STORE_MODE = 6;
const STORE_ENTRY_SLOT = 35;
const SS = {
    name: 9, desc: 10, owner: 11, group: 12, depts: 13, back: 14,
    storeHeader: 15, storeOpts: [26, 27, 28, 29, 30, 31, 32],
    deptHeader: 33, deptOpts: [34, 35, 36, 38, 39, 41, 42, 43]
};
const pendingStoreMode = new Map();   // playerId -> block key (return here after a form)
const storeModeBlocks = new Set();    // block keys currently showing the store page

function blockKey(block) {
    const l = block.location;
    return `${block.dimension.id}:${l.x},${l.y},${l.z}`;
}

function storeFormDone(player) {
    tell(player, "§7[店舗] ショップを開くと店舗設定に戻ります");
}

function putProbe(container, slot, count, name) {
    const cur = container.getItem(slot);
    if (cur && !isProbe(cur)) return;           // never overwrite a real item
    const probe = new ItemStack(PROBE_ID, count);
    if (name !== undefined) probe.nameTag = name;
    container.setItem(slot, probe);
}

// Rows of the two dropdowns for this player/block.
function storePageModel(player, block) {
    const reg = loadStores();
    const sid = getBlockStoreId(block);
    const store = sid ? reg.stores[sid] : undefined;
    const group = store?.groupId ? reg.groups[store.groupId] : undefined;
    const dept = blockDept(block, store);

    const mine = Object.values(reg.stores).filter(st => canManageStore(player, st));
    const storeRows = [{ type: "store", id: undefined, label: "店舗に入れない" }];
    const fitStores = mine.length <= 5 ? mine : mine.slice(0, 4);
    for (const st of fitStores) storeRows.push({ type: "store", id: st.id, label: st.name });
    if (mine.length > 5) storeRows.push({ type: "storeMore", label: "その他（一覧から選ぶ）" });
    storeRows.push({ type: "storeNew", label: "＋ 新しい店舗を作る" });

    const deptRows = [];
    if (store) {
        deptRows.push({ type: "dept", id: undefined, label: "売り場なし" });
        const ds = store.departments;
        const fit = ds.length <= 6 ? ds : ds.slice(0, 5);
        for (const d of fit) deptRows.push({ type: "dept", id: d.id, label: d.name });
        if (ds.length > 6) deptRows.push({ type: "deptMore", label: "その他（一覧から選ぶ）" });
        deptRows.push({ type: "deptNew", label: "＋ 新しい売り場を作る" });
    }
    return { reg, store, group, dept, storeRows, deptRows };
}

function writeStorePage(player, rec, block, container) {
    const m = storePageModel(player, block);
    const st = m.store;
    putProbe(container, SS.name, 1, st ? displayStoreName(st.name) : "§7（店舗に入っていません）");
    putProbe(container, SS.desc, 1, st ? (st.description ? fitWidth(st.description) : "§7未入力") : "§7―");
    putProbe(container, SS.owner, 1, st ? fitWidth(st.owner?.name ?? "不明") : "§7―");
    putProbe(container, SS.group, 1, st
        ? (m.group ? fitWidth(`${m.group.name}（${m.group.headId === st.id ? "本店" : "支店"}）`) : "§7なし")
        : "§7―");
    putProbe(container, SS.depts, 1);
    putProbe(container, SS.back, 1);

    rec.storeRows = new Map();
    putProbe(container, SS.storeHeader, rec.storeOpen === "store" ? 2 : 3,
        (st ? displayStoreName(st.name) : "店舗に入れない"));
    SS.storeOpts.forEach((slot, i) => {
        const row = m.storeRows[i];
        if (!row) { putProbe(container, slot, 4, ""); return; }
        const selected = row.type === "store" && row.id === st?.id;
        putProbe(container, slot, selected ? 3 : 2, fitWidth(row.label, 24));
        rec.storeRows.set(slot, row);
    });
    putProbe(container, SS.deptHeader, rec.storeOpen === "dept" ? 2 : 3,
        st ? fitWidth(m.dept ? m.dept.name : "売り場なし") : "§7店舗を選ぶと選べます");
    SS.deptOpts.forEach((slot, i) => {
        const row = m.deptRows[i];
        if (!row) { putProbe(container, slot, 4, ""); return; }
        const selected = row.type === "dept" && row.id === m.dept?.id;
        putProbe(container, slot, selected ? 3 : 2, fitWidth(row.label, 24));
        rec.storeRows.set(slot, row);
    });
}

// Names changed while labels are visible: rewrite, touch, hide+show gate.
function refreshStorePage(player, rec, block, container) {
    writeStorePage(player, rec, block, container);
    touchPlayerInventory(player);
    const playerId = player.id;
    rec.storeLabelsPending = true;
    system.runTimeout(() => {
        if (active.get(playerId) !== rec || !rec.storeMode) { rec.storeLabelsPending = false; return; }
        const c = getContainer(resolve(rec)); if (c) setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_HIDDEN);
    }, VISUAL_COMMIT_DELAY_TICKS);
    system.runTimeout(() => {
        rec.storeLabelsPending = false;
        if (active.get(playerId) !== rec || !rec.storeMode) return;
        const c = getContainer(resolve(rec)); if (c) setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);
    }, VISUAL_COMMIT_DELAY_TICKS + 1);
}

function enterStoreMode(player, rec, block, container) {
    clearGroupNameSlots(container);
    rec.storeMode = true;
    rec.storeOpen = null;
    storeModeBlocks.add(blockKey(block));

    // Shared container slots are reused by every screen.
    // Hide every top-level layout before rewriting them, otherwise the old
    // page can render the new/uninitialized slot contents for one frame.
    setProbe(container, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE);
    setTextGate(container, false);

    writeStorePage(player, rec, block, container);
    setProbe(container, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);
    deferVisualCommit(player, rec, (b, c) => {
        setProbe(c, SALE_LAYOUT_SLOT, STORE_MODE);
        touchPlayerInventory(player);
    });
}

function exitStoreMode(player, rec, block) {
    rec.storeMode = false;
    storeModeBlocks.delete(blockKey(block));
    arm(player, block, "landing");   // （旧）店舗設定 -> 商品一覧
}

// Close the screen for a form; reopening the shop returns to the store page.
function openStoreForm(player, rec, block, show) {
    pendingStoreMode.set(player.id, blockKey(block));
    storeModeBlocks.delete(blockKey(block));
    active.delete(player.id);
    const playerId = player.id;
    const dimension = block.dimension;
    const location = { ...block.location };
    const ok = forceCloseScreen(player, block, () => {
        const p = findPlayer(playerId);
        if (p) show(p, dimension, location);
    });
    if (!ok) {
        active.set(player.id, rec);
        storeModeBlocks.add(blockKey(block));
        tell(player, "§c[店舗] 画面を閉じられませんでした");
    }
}

async function createDeptForm(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    const name = await askName(player, "新しい売り場", "売り場名", "例: 食料品", "", DEPT_NAME_MAX);
    if (name) {
        const fresh = loadStores();
        const st = fresh.stores[store.id];
        const id = `d${st.nextDeptId}`;
        st.nextDeptId += 1;
        st.departments.push({ id, name });
        saveStores(fresh);
        setBlockDeptId(dimension.getBlock(location), id);
        tell(player, `§a[店舗] 売り場「${name}」を作り、この商品を入れました`);
    }
    return storeFormDone(player);
}

function tickStoreMode(player, rec, block, container) {
    const missing = (slot) => !isProbe(container.getItem(slot));
    if (missing(FOOTER_CANCEL_SLOT) || missing(SS.back)) {
        exitStoreMode(player, rec, block);
        return true;
    }
    const store = blockStore(block);
    const needStore = (slot) => {
        if (store) return true;
        putProbe(container, slot, 1, container.getItem(slot)?.nameTag);
        refreshStorePage(player, rec, block, container);
        tell(player, "§e[店舗] 先に「この商品の店舗」を選んでください");
        return false;
    };
    if (missing(SS.name) || missing(SS.desc)) {
        if (needStore(missing(SS.name) ? SS.name : SS.desc)) {
            openStoreForm(player, rec, block, (p, d, l) => showStoreInfoForm(p, d, l, store.id));
        }
        return true;
    }
    if (missing(SS.group)) {
        if (needStore(SS.group)) openStoreForm(player, rec, block, (p, d, l) => showGroupMenu(p, d, l));
        return true;
    }
    if (missing(SS.depts)) {
        if (needStore(SS.depts)) openStoreForm(player, rec, block, (p, d, l) => showDeptManager(p, d, l));
        return true;
    }
    if (missing(SS.owner)) { putProbe(container, SS.owner, 1, container.getItem(SS.owner)?.nameTag); return true; }

    // dropdown headers (also the "outside" close layer): only the count changes
    for (const [which, slot] of [["store", SS.storeHeader], ["dept", SS.deptHeader]]) {
        if (!missing(slot)) continue;
        if (which === "dept" && !store) { refreshStorePage(player, rec, block, container); return true; }
        rec.storeOpen = rec.storeOpen === which ? null : which;
        const other = which === "store" ? SS.deptHeader : SS.storeHeader;
        // Only the header comes back (with its text) and counts change.
        // The option items must NOT be replaced now: the list appears in
        // this same update and would read not-yet-refreshed names.
        const m = storePageModel(player, block);
        const text = which === "store"
            ? fitWidth(m.store ? m.store.name : "店舗に入れない")
            : (m.store ? fitWidth(m.dept ? m.dept.name : "売り場なし") : "§7店舗を選ぶと選べます");
        putProbe(container, slot, rec.storeOpen === which ? 2 : 3, text);
        setProbe(container, other, 3);
        return true;
    }

    // option rows
    for (const [slot, row] of rec.storeRows ?? []) {
        if (!missing(slot)) continue;
        rec.storeOpen = null;
        const dim = block.dimension; const loc = { ...block.location };
        switch (row.type) {
            case "store":
                if (row.id !== getBlockStoreId(block)) setBlockDeptId(block, undefined);
                setBlockStoreId(block, row.id);
                tell(player, row.id ? `§a[店舗] この商品を「${row.label}」に入れました` : "§7[店舗] この商品を店舗から外しました");
                break;
            case "dept":
                setBlockDeptId(block, row.id);
                tell(player, row.id ? `§a[店舗] この商品を売り場「${row.label}」に入れました` : "§7[店舗] この商品を売り場から外しました");
                break;
            case "storeMore": openStoreForm(player, rec, block, (p, d, l) => showStorePicker(p, d, l)); return true;
            case "storeNew": openStoreForm(player, rec, block, (p, d, l) => showStoreInfoForm(p, d, l, undefined)); return true;
            case "deptMore": openStoreForm(player, rec, block, (p, d, l) => showDeptPicker(p, d, l)); return true;
            case "deptNew": openStoreForm(player, rec, block, (p, d, l) => createDeptForm(p, d, l)); return true;
        }
        refreshStorePage(player, rec, block, container);
        return true;
    }
    return false;
}

// ============================================================
// 商品一覧（店舗の最初の画面）(v53) — slot50 = 7
// One block = one store with many products.
//   PRODUCT_INDEX_PROP   : ["p1","p2",...]
//   "shop_product_<id>"  : { id, settings: {prop: value}, items: [...] }
//   CURRENT_PRODUCT_PROP : id of the product being edited (block props
//                          then hold ITS settings = the working copy)
// Stock slots (0..8,16) are a WORKING VIEW for the currently opened product.
// Each product owns its own serialized stock snapshot in shop_product_<id>.
// When a product closes, its stock + role items are captured and the physical
// stock slots are cleared. Opening another product restores only that product.
// ============================================================
const LANDING_MODE = 7;
const LANDING_GROUP_COUNT_SLOT = 20;   // 所属系列店：表示する行数（2..8）
const LANDING_GROUP_GATE_SLOT = 21;    // 所属系列店：ヘッダー文字のテキストゲート（1=隠す 2=出す）
const LANDING_GROUP_NAME_SLOT = 22;    // 所属系列店：ヘッダーに出す系列名
const LANDING_GROUP_ROW_GATE_SLOT = 23; // 所属系列店：選択肢の文字のテキストゲート（ヘッダーとは別）
const LANDING_PAGE_GATE_SLOT = 37; // own gate, separate from TEXT_GATE_SLOT,
// so turning a page never touches (and re-flashes) 店舗名/営業時間/系列.
const PRODUCT_INDEX_PROP = "shop_product_index";
const PRODUCT_NEXT_PROP = "shop_product_next";
const CURRENT_PRODUCT_PROP = "shop_current_product";
const SHARED_STOCK = [0, 1, 2, 3, 4, 5, 6, 7, 8, 16]; // active product stock slots (legacy name)
const PRODUCT_ROLE_SLOTS = [17, 18, 19, 20, 21, 22, 23, 24, 25];
const PRODUCTS_PER_PAGE = 18;
const LP = {
    cells: [9, 10, 11, 12, 13, 14, 15, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
    prev: 38, next: 39, name: 41, groupHeader: 42, hours: 52, settings: 53,
    // Landing management system entrances.
    // pricePoints intentionally shares slot40 with the landing text gate:
    // while the landing is stable it is always a probe, and clicking this
    // button simply removes that probe. The handler restores it immediately
    // before opening the form, so no extra container slot is consumed.
    pricePoints: TEXT_GATE_SLOT,
    salesFloor: 17, inventory: 18, salesManagement: 19,
    groupOpts: [43, 44, 45, 46, 47, 48, 49, 51]
};
const DEFAULT_PRODUCT_ICON = "＋";
const HOURS_MAX = 32;


function displayStoreName(name) {
    const v = String(name ?? "").trim();
    return (!v || v === "新しい店舗") ? "§7未入力" : fitWidth(v);
}

function productKey(id) { return `shop_product_${id}`; }

function loadProductIndex(block) {
    try {
        const raw = getProps(block)?.get(PRODUCT_INDEX_PROP);
        const list = typeof raw === "string" ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(x => typeof x === "string") : [];
    } catch { return []; }
}

function saveProductIndex(block, list) {
    try { getProps(block)?.set(PRODUCT_INDEX_PROP, JSON.stringify(list)); } catch {}
}

function deleteProduct(block, id) {
    saveProductIndex(block, loadProductIndex(block).filter(x => x !== id));
    try { getProps(block)?.set(productKey(id), undefined); } catch {}
}

// True only for a product that has NEVER been saved with any real content
// (created via + and abandoned without ever pressing Save).
function isEmptyProductRecord(record) {
    return Object.keys(record.settings ?? {}).length === 0 && (record.items ?? []).length === 0 && (record.stock ?? []).length === 0;
}

function loadProduct(block, id) {
    try {
        const raw = getProps(block)?.get(productKey(id));
        const r = typeof raw === "string" ? JSON.parse(raw) : null;
        if (!r) return { id, settings: {}, items: [], stock: [] };
        return {
            id,
            settings: r.settings ?? {},
            items: Array.isArray(r.items) ? r.items : [],
            // v66: representative icon captured from the first sample slot.
            icon: r.icon && typeof r.icon === "object" ? r.icon : undefined,
            // Explicitly distinguish a newly-created draft from a product that
            // has already been saved. Legacy records predate this flag, so they
            // are treated as saved for compatibility.
            savedOnce: Object.prototype.hasOwnProperty.call(r, "savedOnce") ? r.savedOnce === true : true,
            // undefined means "legacy record from before per-product stock".
            // [] means a real, intentionally empty product stock.
            stock: Array.isArray(r.stock) ? r.stock : undefined
        };
    } catch { return { id, settings: {}, items: [], stock: [] }; }
}

function saveProduct(block, record) {
    try { getProps(block)?.set(productKey(record.id), JSON.stringify(record)); } catch {}
}

function getCurrentProduct(block) {
    try {
        const v = getProps(block)?.get(CURRENT_PRODUCT_PROP);
        return typeof v === "string" && v ? v : undefined;
    } catch { return undefined; }
}

function setCurrentProduct(block, id) {
    const dp = getProps(block);
    try {
        if (id) dp?.set(CURRENT_PRODUCT_PROP, id);
        else if (dp?.get(CURRENT_PRODUCT_PROP) !== undefined) dp.set(CURRENT_PRODUCT_PROP, undefined);
    } catch {}
}

const BLOCK_LEVEL_PROPS = new Set([
    LAYOUT_MIGRATION_PROP, KUJI_EDITING_PROP, BLOCK_STORE_PROP,
    PRODUCT_INDEX_PROP, PRODUCT_NEXT_PROP, CURRENT_PRODUCT_PROP
]);

// Props that belong to ONE product (the working copy in the block).
function productSettingNames() {
    return allSettingProps().filter(n => !BLOCK_LEVEL_PROPS.has(n));
}

function productIconPath(block, record) {
    if (record.icon?.id) return itemIconPath(record.icon.id);
    const first = [...(record.items ?? [])]
        .filter(it => it.role === "sample")
        .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999))[0] ?? record.items?.[0];
    if (first?.id) return itemIconPath(first.id);
    try {
        const kuji = JSON.parse(record.settings?.[KUJI_PROP] ?? "[]");
        const it = Array.isArray(kuji) ? kuji.find(t => t?.items?.length)?.items?.[0] : undefined;
        if (it?.id) return itemIconPath(it.id);
    } catch {}
    return DEFAULT_PRODUCT_ICON;
}

// A brand-new block gets its own store; an old single-product block
// becomes product p1 (its settings stay in place as the working copy).
function ensureStoreAndProducts(player, block, container) {
    if (!getBlockStoreId(block)) {
        const reg = loadStores();
        const id = `s${reg.nextId}`;
        reg.nextId += 1;
        reg.stores[id] = { id, name: "", description: "", owner: { id: player.id, name: player.name },
            createdAt: Date.now(), departments: [], nextDeptId: 1 };
        saveStores(reg);
        setBlockStoreId(block, id);
    }
    if (loadProductIndex(block).length === 0 && getProps(block)?.get(PRODUCT_INDEX_PROP) === undefined) {
        const dp = getProps(block);
        const hasSettings = productSettingNames().some(n => { try { return dp?.get(n) !== undefined; } catch { return false; } });
        const hasItems = PRODUCT_ROLE_SLOTS.some(sl => { const it = container.getItem(sl); return it && !isProbe(it); });
        if (hasSettings || hasItems) {
            saveProductIndex(block, ["p1"]);
            try { dp.set(PRODUCT_NEXT_PROP, 2); } catch {}
            saveProduct(block, { id: "p1", settings: {}, items: [] });
            setCurrentProduct(block, "p1");     // keep editing it where it is
        } else {
            saveProductIndex(block, []);
        }
    }
}

function landingModel(player, rec, block) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    const group = store?.groupId ? reg.groups[store.groupId] : undefined;
    const ids = loadProductIndex(block);
    const entries = [...ids.map(id => ({ type: "product", id })), { type: "plus" }];
    const pages = Math.max(1, Math.ceil(entries.length / PRODUCTS_PER_PAGE));
    rec.landingPage = Math.min(Math.max(0, rec.landingPage ?? 0), pages - 1);
    const pageEntries = entries.slice(rec.landingPage * PRODUCTS_PER_PAGE, (rec.landingPage + 1) * PRODUCTS_PER_PAGE);

    const groups = Object.values(reg.groups).filter(g => canManageGroup(player, g) || g.id === store?.groupId);
    // 実在する系列は、管理権限があれば現在選択中でもゴミ箱を出す。
    // 「なし」「次へ」「新しい系列を作る」は type が異なるため対象外。
    // 削除は商品削除と同じ1段階確認の後、その系列に所属する店舗を全て未所属へ戻してから系列自体を消す。
    const canDelete = (g) => canManageGroup(player, g);
    const groupRows = [{ type: "group", id: undefined, label: "なし" }];
    // 6個までは全部並べる。7個以上は5個ずつのページにして「次へ」で送る（最後の次は最初に戻る）。
    let groupPages = 1;
    if (groups.length <= GROUP_DD_ALL_FIT) {
        rec.landingGroupPage = 0;
        for (const g of groups) groupRows.push({ type: "group", id: g.id, label: g.name, deletable: canDelete(g) });
    } else {
        groupPages = Math.ceil(groups.length / GROUP_DD_PAGE_SIZE);
        rec.landingGroupPage = ((rec.landingGroupPage ?? 0) % groupPages + groupPages) % groupPages;
        const start = rec.landingGroupPage * GROUP_DD_PAGE_SIZE;
        // 最後のページは残りの分だけ（例：残り2個なら 2個＋次へ＋新しい系列）
        for (const g of groups.slice(start, start + GROUP_DD_PAGE_SIZE)) groupRows.push({ type: "group", id: g.id, label: g.name, deletable: canDelete(g) });
        groupRows.push({ type: "groupNext", label: `次へ ▶（${rec.landingGroupPage + 1}/${groupPages}）` });
    }
    groupRows.push({ type: "groupNew", label: "＋ 新しい系列を作る" });
    return { reg, store, group, pages, pageEntries, groupRows };
}

// A display clone must never linger anywhere except its own landing cell
// (a drag WITHIN the container, not just to the player's inventory, can
// move one elsewhere - e.g. into the shared stock slots). Sweep the whole
// container for the marker and remove any stray copy before redrawing.
function clearDisplayClonesFromContainer(container) {
    for (let i = 0; i < container.size; i++) {
        if (isDisplayClone(container.getItem(i))) container.setItem(i, undefined);
    }
}

function writeLanding(player, rec, block, container) {
    clearDisplayClonesFromContainer(container);
    const m = landingModel(player, rec, block);
    // clearDisplayClonesFromContainer already removed every display clone,
    // so any real, non-probe item still sitting in a cell slot here is a
    // GENUINE item (e.g. dragged there by a player) - never delete it,
    // always return it to stock (or the player) before writing the cell.
    const reclaim = (cur) => {
        if (!cur || isProbe(cur)) return;
        // No product is active on the landing page, so there is no valid
        // stock owner. Return accidental real items to the player instead of
        // leaking them into whichever product is opened next.
        if (player) giveOrDrop(player, cur);
    };
    rec.landingCells = new Map();
    LP.cells.forEach((slot, i) => {
        const e = m.pageEntries[i];
        const cur = container.getItem(slot);
        if (!e) {
            reclaim(cur);
            container.setItem(slot, undefined);
            putProbe(container, slot, 4, "");
            return;
        }
        if (e.type === "plus") {
            reclaim(cur);
            container.setItem(slot, undefined);
            putProbe(container, slot, 3, DEFAULT_PRODUCT_ICON);
        } else {
            reclaim(cur);
            container.setItem(slot, makeLandingDisplayItem(loadProduct(block, e.id)));
        }
        rec.landingCells.set(slot, e);
    });
    putProbe(container, LP.prev, 1);
    putProbe(container, LP.next, 1);
    putProbe(container, LANDING_PAGE_GATE_SLOT, TEXT_GATE_SHOWN, `${rec.landingPage + 1}/${m.pages}`);
    putProbe(container, LP.name, 1, m.store ? displayStoreName(m.store.name) : "§7未入力");
    putProbe(container, LP.hours, 1, m.store?.hours ? fitWidth(m.store.hours) : "§7未入力");
    writeHeadToggle(container, rec, m);
    putProbe(container, LP.salesFloor, 1);
    putProbe(container, LP.inventory, 1);
    putProbe(container, LP.salesManagement, 1);
    normalizeLandingGroupSignalSlots(player, container);
    // 系列削除確認は商品削除と同じく専用スロットを常に初期化しておく。
    // ドロップダウン選択肢(43..51)とは共有しない。
    setProbe(container, GROUP_DEL_YES_SLOT, 1);
    setProbe(container, GROUP_DEL_NO_SLOT, 1);
    setProbe(container, GROUP_DEL_STATE_SLOT, GROUP_DEL_HIDDEN);
    writeGroupDd(container, rec, m);
    putProbe(container, LANDING_GROUP_GATE_SLOT, TEXT_GATE_SHOWN, GROUP_DD_GATE_TAG);
    putProbe(container, LANDING_GROUP_ROW_GATE_SLOT, TEXT_GATE_SHOWN, GROUP_DD_ROW_GATE_TAG);
}

// Turning a page only changes the cell grid + page number - never
// touches 店舗名/営業時間/系列, so only LANDING_PAGE_GATE_SLOT cycles here.
function refreshLandingPage(player, rec, block, container) {
    writeLanding(player, rec, block, container);
    touchPlayerInventory(player);
    const playerId = player.id;
    rec.landingPending = true;
    system.runTimeout(() => {
        if (active.get(playerId) !== rec || !rec.landing) { rec.landingPending = false; return; }
        const c = getContainer(resolve(rec)); if (c) setProbe(c, LANDING_PAGE_GATE_SLOT, TEXT_GATE_HIDDEN);
    }, VISUAL_COMMIT_DELAY_TICKS);
    system.runTimeout(() => {
        rec.landingPending = false;
        if (active.get(playerId) !== rec || !rec.landing) return;
        const c = getContainer(resolve(rec)); if (c) setProbe(c, LANDING_PAGE_GATE_SLOT, TEXT_GATE_SHOWN);
    }, VISUAL_COMMIT_DELAY_TICKS + 1);
}

// ============================================================
// 所属系列店ドロップダウン
// 商品設定の通常ドロップダウン（bonus_mode を含む）と同じ操作系を使う：
//   状態 slot42 : 開 = 2 / 閉 = 3 + 選択番号
//   選択肢 43,44,45,46,47,48,49,51 : 1個シグナル
//   UIクリック = button.container_take_all_place_all
//   クリック判定 = signalIntact（1個のままか / 空になったか）
//   選択 = 値を保存 → シグナルを書き戻す → deferVisualCommit で2tick後に閉じる
// 系列名は固定文字にできないので、商品設定のテキスト表示（v20 No-blink）と
// 同じ決まりで出す：
//   名前を書く(隠れた状態) → touchPlayerInventory → 2tick後に表示を切り替える
//   表示中のラベルは読み直さない(visibility_changed)ので、変えた名前は
//   ゲートを 隠す→出す して読ませる（setTextGate と同じ）
// 着地ページでは 27,28 は商品セルなので選択肢は 43.. を使う。
// ============================================================
const GROUP_DD_OPEN = 2;
const GROUP_DD_CLOSED_BASE = 3;
// 商品設定の通常ドロップダウンと同じ。選択肢シグナルは必ず1個。
// UI側も button.container_take_all_place_all を使い、押されたらスロットが空になる。
const GROUP_DD_CHOICE_AMOUNT = 1;
const GROUP_DD_ALL_FIT = 5;         // これ以下なら全部並べる
const GROUP_DD_PAGE_SIZE = 5;       // それを超えたら1ページ5個
// ゴミ箱状態は各行の「名前スロット」1..5に同居させる。
// 2 = 削除可・未選択 / 3 = 削除可・選択中 / 4 = ゴミ箱なし。
// 以前の 0/8/16/24/25 専用スロット方式は行ごとの取りこぼしを起こしたため廃止。
const GROUP_DD_TRASH_UNCHECKED = 2;
const GROUP_DD_TRASH_CHECKED = 3;
const GROUP_DD_TRASH_OFF = 4;
// 系列削除確認。商品削除と同じく YES / NO / visibility を完全に専用スロットへ分離する。
// 16 / 24 / 25 は着地ページの商品セル・系列選択肢では使わない。
// 1 = 非表示 / 2 = 確認表示。43/44 などの系列選択肢スロットは絶対に再利用しない。
const GROUP_DEL_YES_SLOT = 16;
const GROUP_DEL_NO_SLOT = 24;
const GROUP_DEL_STATE_SLOT = 25;
const GROUP_DEL_HIDDEN = 1;
const GROUP_DEL_CONFIRM = 2;          // 1段目「この系列店を削除しますか？」
const GROUP_DEL_CONFIRM_FINAL = 3;    // 2段目「全て削除されます。本当に削除しますか？」
const GROUP_DD_STATE_TAG = "§a§b§c";   // 他のプローブと絶対に重ねない固有名
const GROUP_DD_ROWS_TAG = "§d§e§f";
const GROUP_DD_GATE_TAG = "§a§a§b";
const GROUP_DD_ROW_GATE_TAG = "§b§a§a";
// 選択肢の「押すスロット」(43..) と「文字を読むスロット」(0..7) を分ける。
// 押すスロットは名前を一切変えない（個数だけ）。文字は押されないスロットから読む。
// （ヘッダー文字を押されないslot22から読む方式は正しく動いている。押せるセルの
//   スロットの名前を書き換えると、その行の文字が読めないことがあるため）
const GROUP_DD_NAME_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];   // 行1..7の文字。行1..5はゴミ箱状態もこの個数で表す。
const GROUP_DD_LEGACY_TRASH_SLOTS = [8];               // 旧ゴミ箱方式の残留プローブだけ掃除する。
const GROUP_DEL_CONTROL_SLOTS = [GROUP_DEL_YES_SLOT, GROUP_DEL_NO_SLOT, GROUP_DEL_STATE_SLOT];
const groupDdClickTag = (i) => `§${i}§c§${i}`;          // 押すスロットの固定名（行ごとに固有・表示されない）

// 一覧ページ以外に出る前に、文字用プローブを在庫スロットから消す
function clearGroupNameSlots(container) {
    if (!container) return;
    for (const slot of [...GROUP_DD_NAME_SLOTS, ...GROUP_DD_LEGACY_TRASH_SLOTS, ...GROUP_DEL_CONTROL_SLOTS]) {
        const it = container.getItem(slot);
        if (isProbe(it)) container.setItem(slot, undefined);
    }
}

// ------------------------------------------------------------
// 「この店を本店にする」トグル（旧 店舗設定ボタンの場所 / slot53）
// 商品設定の「売れたときに通知を出す」と同じ：OFF = 2 / ON = 3。
// 系列に入っていない時は 4（薄いOFF・押しても変わらない）。
// ON にすると、同じ系列の今の本店は自動で解除される（本店は系列に1つ）。
// ------------------------------------------------------------
const HEAD_TOGGLE_OFF = 2;
const HEAD_TOGGLE_ON = 3;
const HEAD_TOGGLE_LOCKED = 4;
function headToggleAmount(m) {
    if (!m.store || !m.group) return HEAD_TOGGLE_LOCKED;
    return m.group.headId === m.store.id ? HEAD_TOGGLE_ON : HEAD_TOGGLE_OFF;
}

// 見出しホバー用の白文字：系列名＋（本店）/（支店）を1つの文字列で持つ。
// ホバー表示は押した瞬間に作り直されるため、部品を分けると片方だけ先に出てしまう。
const LANDING_GROUP_HOVER_LABEL_SLOT = 80;
function writeGroupHoverLabel(container, m) {
    const suffix = m.group ? (m.group.headId === m.store?.id ? "（本店）" : "（支店）") : "";
    putNamedSignal(container, LANDING_GROUP_HOVER_LABEL_SLOT, 1, groupHeaderLabel(m) + suffix);
}

function writeHeadToggle(container, rec, m) {
    writeGroupHoverLabel(container, m);
    rec.landingHeadAmount = headToggleAmount(m);
    // 商品設定の「売れたときに通知を出す」と同じ状態シグナル方式。
    // OFF=2 / ON=3。系列未所属だけ 4 を使って薄いOFF表示にする。
    setProbe(container, LP.settings, rec.landingHeadAmount);
}

// 所属系列店ヘッダーの系列名：全角9文字（半角18）まではそのまま全部出す。
// それを超える時だけ全角8文字分＋「…」にして、後ろの（本店）/（支店）が枠に収まるようにする。
const GROUP_HEADER_NAME_WIDTH = 18;
function fitGroupName(name) {
    let total = 0;
    for (const ch of name) total += displayWidth(ch);
    if (total <= GROUP_HEADER_NAME_WIDTH) return name;
    return fitWidth(name, GROUP_HEADER_NAME_WIDTH - 1);
}

function groupHeaderLabel(m) {
    // 「（本店）/（支店）」はUI側でslot53（本店トグル）の値から固定文字で出す。
    // ここは系列名だけ。トグル操作で名前を書き直さない＝再表示（チラつき）しない。
    return m.group ? fitGroupName(m.group.name) : "なし";
}

function groupSelectedIndex(m) {
    const i = m.groupRows.findIndex(r => r.type === "group" && r.id === m.store?.groupId);
    return i < 0 ? 0 : i;
}

// 個数・名前が同じなら書かない（表示中ラベルの元を不要に作り直さない）
function putNamedSignal(container, slot, amount, name) {
    const cur = container.getItem(slot);
    if (cur && !isProbe(cur)) return;
    if (isProbe(cur) && cur.amount === amount && (cur.nameTag ?? "") === (name ?? "")) return;
    putProbe(container, slot, amount, name);
}

// 一覧ページでは商品を編集中ではないため、系列UIの補助スロットに
// 実アイテムが残っている状態は不正。以前の商品画面から残った実アイテムが
// ゴミ箱/系列名プローブの書き込みを塞ぐと「特定の行だけゴミ箱が出ない」ため、
// 一覧UIを書く直前に必ず退避して補助スロットをプローブ専用状態へ戻す。
// 実アイテムは削除せずプレイヤーへ返す。
function normalizeLandingGroupSignalSlots(player, container) {
    if (!container) return;
    const slots = new Set([...GROUP_DD_NAME_SLOTS, ...GROUP_DD_LEGACY_TRASH_SLOTS, ...GROUP_DEL_CONTROL_SLOTS]);
    for (const slot of slots) {
        const cur = container.getItem(slot);
        if (!cur || isProbe(cur)) continue;
        container.setItem(slot, undefined);
        if (player) giveOrDrop(player, cur);
    }
}

function writeGroupChoices(container, rec, m) {
    rec.landingGroupRows = new Map();
    rec.landingGroupAmounts = new Map();
    rec.landingTrashAmounts = new Map();
    rec.landingTrashRows = new Map();

    LP.groupOpts.forEach((slot, i) => {
        const row = m.groupRows[i];

        // 行1..7の表示名は専用の名前スロットから読む。
        // 行1..5は同じスロットの「個数」にゴミ箱状態も持たせるため、
        // 別スロット競合で特定行だけゴミ箱が消えることがない。
        if (i > 0) {
            const nameSlot = GROUP_DD_NAME_SLOTS[i];
            const trashable = i <= 5 && row?.type === "group" && row.deletable;
            const selected = trashable && row.id === m.store?.groupId;
            const nameAmount = trashable
                ? (selected ? GROUP_DD_TRASH_CHECKED : GROUP_DD_TRASH_UNCHECKED)
                : GROUP_DD_TRASH_OFF;

            // ゴミ箱の無い行（新しい系列を作る・次へ 等）は右側が空くので広く使う
            putNamedSignal(container, nameSlot, nameAmount, row ? (trashable ? fitWidth(row.label, 18) : row.label) : "");

            if (trashable) {
                rec.landingTrashAmounts.set(nameSlot, nameAmount);
                rec.landingTrashRows.set(nameSlot, row);
            }
        }

        // 行選択そのものは、通常ドロップダウンと同じ1個シグナルのまま。
        putNamedSignal(container, slot, GROUP_DD_CHOICE_AMOUNT, groupDdClickTag(i));
        rec.landingGroupAmounts.set(slot, GROUP_DD_CHOICE_AMOUNT);
        if (row) rec.landingGroupRows.set(slot, row);
    });
}

function writeGroupState(container, rec, m, open) {
    rec.landingOpen = open;
    rec.landingGroupStateAmount = open ? GROUP_DD_OPEN : GROUP_DD_CLOSED_BASE + groupSelectedIndex(m);
    putNamedSignal(container, LP.groupHeader, rec.landingGroupStateAmount, GROUP_DD_STATE_TAG);
}

function writeGroupDd(container, rec, m) {
    putNamedSignal(container, LANDING_GROUP_COUNT_SLOT, Math.max(2, Math.min(8, m.groupRows.length)), GROUP_DD_ROWS_TAG);
    putNamedSignal(container, LANDING_GROUP_NAME_SLOT, 1, groupHeaderLabel(m));
    writeGroupHoverLabel(container, m);
    writeGroupChoices(container, rec, m);
    writeGroupState(container, rec, m, !!rec.landingOpen);
}

function refreshLandingGroupOnly(player, rec, block, container) {
    normalizeLandingGroupSignalSlots(player, container);
    writeGroupDd(container, rec, landingModel(player, rec, block));
}

function refreshLanding(player, rec, block, container) {
    writeLanding(player, rec, block, container);
    touchPlayerInventory(player);
    const playerId = player.id;
    rec.landingPending = true;
    system.runTimeout(() => {
        if (active.get(playerId) !== rec || !rec.landing) { rec.landingPending = false; return; }
        const c = getContainer(resolve(rec)); if (c) { setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_HIDDEN); setProbe(c, LANDING_GROUP_GATE_SLOT, TEXT_GATE_HIDDEN); setProbe(c, LANDING_GROUP_ROW_GATE_SLOT, TEXT_GATE_HIDDEN); }
    }, VISUAL_COMMIT_DELAY_TICKS);
    system.runTimeout(() => {
        rec.landingPending = false;
        if (active.get(playerId) !== rec || !rec.landing) return;
        const c = getContainer(resolve(rec)); if (c) setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);
        // 系列ゲートは隠してから2tick置いて出す（1tickだと見逃されることがある）
        system.runTimeout(() => {
            if (active.get(playerId) !== rec || !rec.landing) return;
            const c2 = getContainer(resolve(rec)); if (c2) { setProbe(c2, LANDING_GROUP_GATE_SLOT, TEXT_GATE_SHOWN); setProbe(c2, LANDING_GROUP_ROW_GATE_SLOT, TEXT_GATE_SHOWN); }
        }, 1);
    }, VISUAL_COMMIT_DELAY_TICKS + 1);
}

function armLanding(player, rec, block, container) {
    rec.landing = true;
    rec.landingOpen = false;
    const cur = container.getItem(SALE_LAYOUT_SLOT);
    if (isProbe(cur) && cur.amount === LANDING_MODE) {
        // reopened on the list page: it is already showing, so rewrite and
        // let the labels re-read in place instead of hiding the page
        refreshLanding(player, rec, block, container);
        return;
    }
    setProbe(container, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE); // hide all layouts until landing UI is ready
    setTextGate(container, false);
    writeLanding(player, rec, block, container);
    deferVisualCommit(player, rec, (b, c) => {
        setProbe(c, SALE_LAYOUT_SLOT, LANDING_MODE);
        // v58 accidentally dropped this: TEXT_GATE_SLOT (店舗名/営業時間/系列)
        // used to be flipped back to shown as a side effect of writing the
        // page number, before that moved to its own LANDING_PAGE_GATE_SLOT.
        // Without this, those labels stayed hidden forever on every fresh
        // armLanding() (v61 fix).
        setProbe(c, TEXT_GATE_SLOT, TEXT_GATE_SHOWN);
        touchPlayerInventory(player);
    });
}

// Open a product: its settings become the block's working copy and its
// its own stock snapshot is restored, then 見本/おまけ/ラストワン賞 are taken from that stock.
function enterProduct(player, rec, block, container, id) {
    rec.landing = false;
    clearGroupNameSlots(container);
    // Landing management buttons reuse role slots 17..19 only on the list screen.
    // Remove only our probes before restoring the product's real role items.
    for (const slot of [LP.salesFloor, LP.inventory, LP.salesManagement, LANDING_GROUP_COUNT_SLOT, LANDING_GROUP_GATE_SLOT, LANDING_GROUP_NAME_SLOT, LANDING_GROUP_ROW_GATE_SLOT]) {
        const cur = container.getItem(slot);
        if (isProbe(cur)) container.setItem(slot, undefined);
    }

    // Product layouts reuse the same slots as landing/store UI.
    // Hide everything before loading the product working copy.
    setProbe(container, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE);
    setTextGate(container, false);

    const record = loadProduct(block, id);
    discardTextDraft(block);
    const dp = getProps(block);
    for (const name of productSettingNames()) {
        const v = record.settings[name];
        try {
            if (v !== undefined) dp.set(name, v);
            else if (dp.get(name) !== undefined) dp.set(name, undefined);
        } catch {}
    }
    setCurrentProduct(block, id);

    // v62 migration: old records have no `stock` field. Before restoring
    // anything, distribute every saved product's role items out of the old
    // store-wide stock. Any unclaimed legacy stock is assigned to the product
    // opened first because its former owner cannot be inferred.
    if (record.stock === undefined) {
        migrateLegacyStoreStock(block, container, id);
        record.stock = loadProduct(block, id).stock ?? [];
    } else {
        // A closed product must leave these slots empty. Never let a stray
        // item from landing/store UI become another product's inventory.
        clearActiveProductStock(container, player);
    }

    const restoreFailed = restoreProductStock(container, record.stock, player);
    if (restoreFailed) tell(player, `§e[商品] ${restoreFailed}個の在庫スタックを復元できませんでした`);

    const missing = [];
    for (const it of record.items) {
        if (!PRODUCT_ROLE_SLOTS.includes(it.slot)) continue;
        const pieces = takeFromStockByKey(container, SHARED_STOCK, it.key ?? it.id, it.count);
        const got = pieces.reduce((a, pc) => a + pc.amount, 0);
        if (got < it.count) missing.push(`${it.name ? `『${it.name}』` : itemShortName(it.id)} ${it.count - got}個`);
        for (const pc of pieces) {
            const rest = putIntoSlots(container, [it.slot], pc);
            if (rest) { const r2 = putIntoSlots(container, SHARED_STOCK, rest); if (r2) giveOrDrop(player, r2); }
        }
    }
    for (const m of missing) tell(player, `§e[商品] この商品の在庫に足りず並べられなかった見本・おまけ: ${m}`);
    arm(player, block);   // normal product screen
}

function takeFromStockByKey(container, slots, key, count) {
    const pieces = [];
    for (const slot of slots) {
        if (count <= 0) break;
        const item = container.getItem(slot);
        if (!item || isProbe(item) || itemKey(item) !== key) continue;
        const n = Math.min(item.amount, count);
        const piece = item.clone(); piece.amount = n;
        pieces.push(piece);
        if (n >= item.amount) container.setItem(slot, undefined);
        else { item.amount -= n; container.setItem(slot, item); }
        count -= n;
    }
    return pieces;
}

// -------------------------------------------------------------------------
// Per-product stock persistence (v62)
// -------------------------------------------------------------------------
// The block only has ten visible stock slots, so keeping every product's
// physical stacks in the container is impossible once a store has multiple
// products. We therefore serialize each stack while that product is closed.
// The fields below cover the Script API custom state that can be restored:
// name/lore, adventure restrictions, lock/death flags, durability, enchants,
// dye color, dynamic properties, potion kind, and nested item containers.
function snapshotItemStack(item, depth = 0) {
    if (!item || isProbe(item)) return undefined;
    const out = { id: item.typeId, amount: item.amount };
    try { if (item.nameTag) out.nameTag = item.nameTag; } catch {}
    try {
        const lore = item.getLore?.();
        if (lore?.length) out.lore = lore;
    } catch {}
    try { if (item.keepOnDeath) out.keepOnDeath = true; } catch {}
    try { if (item.lockMode && item.lockMode !== "none") out.lockMode = item.lockMode; } catch {}
    try {
        const a = item.getCanDestroy?.();
        if (a?.length) out.canDestroy = a;
    } catch {}
    try {
        const a = item.getCanPlaceOn?.();
        if (a?.length) out.canPlaceOn = a;
    } catch {}
    try {
        const d = item.getComponent?.("minecraft:durability");
        if (d && d.damage) out.damage = d.damage;
    } catch {}
    try {
        const e = item.getComponent?.("minecraft:enchantable")?.getEnchantments?.();
        if (e?.length) out.enchantments = e.map(x => ({ id: x.type?.id ?? String(x.type), level: x.level }));
    } catch {}
    try {
        const dye = item.getComponent?.("minecraft:dyeable");
        if (dye?.color) out.dyeColor = { ...dye.color };
    } catch {}
    try {
        const pot = item.getComponent?.("minecraft:potion");
        const effect = pot?.potionEffectType?.id;
        const delivery = pot?.potionDeliveryType?.id;
        if (effect && delivery) out.potion = { effect, delivery };
    } catch {}
    try {
        const props = {};
        for (const id of item.getDynamicPropertyIds?.() ?? []) {
            const v = item.getDynamicProperty(id);
            if (v !== undefined) props[id] = v;
        }
        if (Object.keys(props).length) out.dynamicProperties = props;
    } catch {}
    // Shulker-like/custom storage items: preserve nested contents when exposed
    // through minecraft:inventory. Cap recursion to avoid pathological nesting.
    if (depth < 3) {
        try {
            const inv = item.getComponent?.("minecraft:inventory")?.container;
            if (inv) {
                const nested = [];
                for (let i = 0; i < inv.size; i++) {
                    const child = snapshotItemStack(inv.getItem(i), depth + 1);
                    if (child) nested.push({ slot: i, item: child });
                }
                if (nested.length) out.inventory = nested;
            }
        } catch {}
    }
    return out;
}

function restoreItemStack(data, depth = 0) {
    if (!data?.id) return undefined;
    let item;
    try {
        if (data.potion?.effect && data.potion?.delivery) {
            const effect = Potions.getEffectType(data.potion.effect);
            const delivery = Potions.getDeliveryType(data.potion.delivery);
            if (effect && delivery) item = Potions.resolve(effect, delivery);
        }
    } catch {}
    try { if (!item) item = new ItemStack(data.id, Math.max(1, Number(data.amount) || 1)); }
    catch { return undefined; }
    try { item.amount = Math.max(1, Math.min(item.maxAmount ?? 255, Number(data.amount) || 1)); } catch {}
    try { if (data.nameTag) item.nameTag = data.nameTag; } catch {}
    try { if (Array.isArray(data.lore)) item.setLore(data.lore); } catch {}
    try { if (data.keepOnDeath) item.keepOnDeath = true; } catch {}
    try { if (data.lockMode) item.lockMode = data.lockMode; } catch {}
    try { if (Array.isArray(data.canDestroy)) item.setCanDestroy(data.canDestroy); } catch {}
    try { if (Array.isArray(data.canPlaceOn)) item.setCanPlaceOn(data.canPlaceOn); } catch {}
    try {
        const d = item.getComponent?.("minecraft:durability");
        if (d && Number.isFinite(Number(data.damage))) d.damage = Number(data.damage);
    } catch {}
    try {
        const ench = item.getComponent?.("minecraft:enchantable");
        for (const e of data.enchantments ?? []) {
            const type = EnchantmentTypes.get(e.id);
            if (ench && type) ench.addEnchantment({ type, level: Number(e.level) || 1 });
        }
    } catch {}
    try {
        const dye = item.getComponent?.("minecraft:dyeable");
        if (dye && data.dyeColor) dye.color = data.dyeColor;
    } catch {}
    try {
        if (data.dynamicProperties && typeof data.dynamicProperties === "object") {
            item.setDynamicProperties(data.dynamicProperties);
        }
    } catch {}
    if (depth < 3 && Array.isArray(data.inventory)) {
        try {
            const inv = item.getComponent?.("minecraft:inventory")?.container;
            if (inv) {
                for (const row of data.inventory) {
                    const child = restoreItemStack(row.item, depth + 1);
                    if (child && Number.isInteger(row.slot) && row.slot >= 0 && row.slot < inv.size) inv.setItem(row.slot, child);
                }
            }
        } catch {}
    }
    return item;
}

function captureProductStock(container, clear = true) {
    const stock = [];
    for (const slot of SHARED_STOCK) {
        const item = container.getItem(slot);
        if (!item || isProbe(item)) {
            if (clear && isProbe(item)) container.setItem(slot, undefined);
            continue;
        }
        const snap = snapshotItemStack(item);
        if (snap) stock.push({ slot, item: snap });
        if (clear) container.setItem(slot, undefined);
    }
    return stock;
}

function clearActiveProductStock(container, player) {
    for (const slot of SHARED_STOCK) {
        const item = container.getItem(slot);
        if (!item) continue;
        container.setItem(slot, undefined);
        if (!isProbe(item) && player) giveOrDrop(player, item);
    }
}

function migrateLegacyStoreStock(block, container, firstProductId) {
    const ids = loadProductIndex(block);
    const legacy = ids.map(id => loadProduct(block, id)).filter(r => r.stock === undefined);
    if (!legacy.length) return;

    // First reserve the exact stacks referenced as samples/bonuses/last-one
    // by each old product. This is the only ownership information legacy
    // data contains, so it is much safer than giving all old stock to p1.
    for (const rec of legacy) {
        const stock = [];
        for (const it of rec.items ?? []) {
            if (!PRODUCT_ROLE_SLOTS.includes(it.slot)) continue;
            const pieces = takeFromStockByKey(container, SHARED_STOCK, it.key ?? it.id, it.count);
            for (const piece of pieces) {
                const snap = snapshotItemStack(piece);
                if (snap) stock.push({ slot: SHARED_STOCK[stock.length % SHARED_STOCK.length], item: snap });
            }
        }
        rec.stock = stock;
        saveProduct(block, rec);
    }

    // Ownership of ordinary legacy stock was never recorded. Keep it rather
    // than deleting it: assign the remainder to the product opened first.
    const first = loadProduct(block, firstProductId);
    const remainder = captureProductStock(container, true);
    first.stock = [...(first.stock ?? []), ...remainder];
    saveProduct(block, first);
}

function restoreProductStock(container, stock, player) {
    let failed = 0;
    for (const row of stock ?? []) {
        const item = restoreItemStack(row?.item);
        if (!item) { failed++; continue; }
        const preferred = SHARED_STOCK.includes(row.slot) ? row.slot : undefined;
        if (preferred !== undefined && !container.getItem(preferred)) {
            container.setItem(preferred, item);
            continue;
        }
        const rest = putIntoSlots(container, SHARED_STOCK, item);
        if (rest) {
            if (player) giveOrDrop(player, rest);
            failed++;
        }
    }
    return failed;
}

// Save the working copy into the product record and return to store settings.
function leaveProduct(player, rec, block, container) {
    const id = getCurrentProduct(block);
    if (id) {
        commitTextDraft(block);
        const saleType = getChoiceById(block, "sale_type");
        const layout = SALE_LAYOUTS[saleType] ?? SALE_LAYOUTS[0];
        const roleSlots = [...layout.sample, ...layout.bonus, ...layout.lastOne];

        // v66: the representative icon is the item currently sitting in the
        // FIRST sample slot (for multi/set sales this is slot 17).
        // Capture it before role items are returned to product stock.
        let icon;
        const iconSlot = layout.sample?.[0];
        if (iconSlot !== undefined) {
            const iconItem = container.getItem(iconSlot);
            if (iconItem && !isProbe(iconItem)) icon = snapshotItemStack(iconItem);
        }

        const items = [];
        for (const slot of roleSlots) {
            const item = container.getItem(slot);
            if (!item || isProbe(item)) continue;
            items.push({ slot, role: slotRole(saleType, slot), ...itemEntry(item, item.amount) });
            container.setItem(slot, undefined);
            const rest = putIntoSlots(container, SHARED_STOCK, item);
            if (rest) {
                giveOrDrop(player, rest);
                tell(player, "§e[商品] 在庫に入りきらない見本・おまけを手持ちに戻しました");
            }
        }
        const settings = {};
        const dp = getProps(block);
        for (const name of productSettingNames()) {
            try { const v = dp.get(name); if (v !== undefined) settings[name] = v; } catch {}
        }
        const stock = captureProductStock(container, true);
        saveProduct(block, { id, settings, items, stock, icon, savedOnce: true });
        setCurrentProduct(block, undefined);
    }
    arm(player, block);   // 保存後 -> 店舗設定
}

// Discard the working copy and return to store settings.
// Product-role items are returned to this product stock, then the stock is persisted.
function cancelProduct(player, rec, block, container) {
    discardTextDraft(block);

    const saleType = getChoiceById(block, "sale_type");
    const layout = SALE_LAYOUTS[saleType] ?? SALE_LAYOUTS[0];
    const roleSlots = [...layout.sample, ...layout.bonus, ...layout.lastOne];
    for (const slot of roleSlots) {
        const item = container.getItem(slot);
        if (!item || isProbe(item)) continue;
        container.setItem(slot, undefined);
        const rest = putIntoSlots(container, SHARED_STOCK, item);
        if (rest) giveOrDrop(player, rest);
    }

    // The SAVED record (re-read fresh, not something carried on rec -
    // arm() replaces rec with a new object right after enterProduct runs,
    // so nothing stored on it here would have survived anyway).
    const id = getCurrentProduct(block);
    if (id) {
        const saved = loadProduct(block, id);
        if (saved.savedOnce === false) {
            // Created with + but never saved. Only these drafts are abandoned
            // by Cancel. An existing/saved product must never be deleted here,
            // even if all of its fields or stock happen to be empty.
            clearActiveProductStock(container, player);
            deleteProduct(block, id);
        } else {
            // Revert the working copy to what was last saved (discard
            // settings/role edits made in this session). Inventory movement
            // itself must still be persisted, otherwise cancel could duplicate
            // withdrawn items or delete newly deposited items.
            const dp = getProps(block);
            for (const name of productSettingNames()) {
                const v = saved.settings[name];
                try {
                    if (v !== undefined) dp.set(name, v);
                    else if (dp.get(name) !== undefined) dp.set(name, undefined);
                } catch {}
            }
            saved.stock = captureProductStock(container, true);
            saved.savedOnce = true;
            saveProduct(block, saved);
        }
    } else {
        // Defensive: no current product should never retain physical stock.
        clearActiveProductStock(container, player);
    }
    setCurrentProduct(block, undefined);
    arm(player, block);   // キャンセル後 -> 商品一覧
}



function beginProductDeleteConfirm(player, rec, block, container) {
    rec.deleteConfirm = true;

    // Visibility state is independent from both buttons. The overlay remains
    // visible through the click frame instead of disappearing immediately.
    setProbe(container, PRODUCT_DELETE_SIGNAL_SLOT, 1); // 削除する
    setProbe(container, PRODUCT_DELETE_NO_SLOT, 1);     // 削除しない
    setProbe(container, PRODUCT_DELETE_STATE_SLOT, 2);  // confirm visible
}

function cancelProductDeleteConfirm(player, rec, block, container) {
    rec.deleteConfirm = false;

    // Close only the confirmation overlay. Do not rebuild the product screen:
    // rebuilding cycles the text gate and causes the product labels to blink.
    setProbe(container, PRODUCT_DELETE_SIGNAL_SLOT, 1);
    setProbe(container, PRODUCT_DELETE_NO_SLOT, 1);
    setProbe(container, PRODUCT_DELETE_STATE_SLOT, 1);
}

function confirmProductDelete(player, rec, block, container) {
    const id = getCurrentProduct(block);
    if (!id) {
        rec.deleteConfirm = false;
        arm(player, block);
        return;
    }

    const saved = loadProduct(block, id);
    const productName = cleanText(saved.settings?.shop_product_name ?? "") || "未入力の商品";

    // Every real item belonging to the opened product is physically present in
    // its stock/role slots. Return those only; UI probes are never returned.
    const slots = [...new Set([...SHARED_STOCK, ...PRODUCT_ROLE_SLOTS])];
    let returned = 0;
    for (const slot of slots) {
        const item = container.getItem(slot);
        if (!item || isProbe(item) || isDisplayClone(item)) continue;
        container.setItem(slot, undefined);
        giveOrDrop(player, item);
        returned++;
    }

    deleteProduct(block, id);
    setCurrentProduct(block, undefined);

    // Clear only the deleted product's working-copy settings.
    const dp = getProps(block);
    for (const name of productSettingNames()) {
        try {
            if (dp?.get(name) !== undefined) dp.set(name, undefined);
        } catch {}
    }
    try {
        if (dp?.get(KUJI_EDITING_PROP) !== undefined) dp.set(KUJI_EDITING_PROP, undefined);
    } catch {}

    rec.deleteConfirm = false;
    setProbe(container, PRODUCT_DELETE_STATE_SLOT, 1);
    tell(player, `§a[商品] 「${productName}」を削除しました${returned ? `（アイテム${returned}スタックを返却）` : ""}`);
    arm(player, block);
}

function createProduct(block) {
    const dp = getProps(block);
    let next = 1;
    try { next = Number(dp.get(PRODUCT_NEXT_PROP)) || 1; } catch {}
    const ids = loadProductIndex(block);
    while (ids.includes(`p${next}`)) next++;
    const id = `p${next}`;
    try { dp.set(PRODUCT_NEXT_PROP, next + 1); } catch {}
    saveProduct(block, { id, settings: {}, items: [], stock: [], savedOnce: false });
    saveProductIndex(block, [...ids, id]);
    return id;
}

// Screen closes for a form; reopening shows the list again.
function openLandingForm(player, rec, block, show) {
    active.delete(player.id);
    const playerId = player.id;
    const dimension = block.dimension;
    const location = { ...block.location };
    const ok = forceCloseScreen(player, block, () => {
        const p = findPlayer(playerId);
        if (p) show(p, dimension, location);
    });
    if (!ok) { active.set(player.id, rec); tell(player, "§c[店舗] 画面を閉じられませんでした"); }
}


function landingProductDisplayName(record) {
    return cleanText(record?.settings?.shop_product_name ?? "") || "未入力の商品";
}

function landingGrantPointSummary(settings) {
    const type = savedChoice(settings, "shop_grant_point_type", 2);
    if (type === 0) return `ショップP +${settings?.grant_shop_points || 0}`;
    if (type === 1) return `チェーンP +${settings?.grant_chain_points || 0}`;
    const name = cleanText(settings?.grant_custom_point_name ?? "") || "カスタムP";
    return `${name} +${settings?.grant_custom_points || 0}`;
}

function landingSavedStockSummary(record) {
    if (!Array.isArray(record?.stock)) return "旧形式（商品を一度開くと移行）";
    let stacks = 0;
    let items = 0;
    for (const row of record.stock) {
        const amount = Math.max(0, Math.trunc(Number(row?.item?.amount) || 0));
        if (amount <= 0) continue;
        stacks++;
        items += amount;
    }
    return `${items}個 / ${stacks}スタック`;
}


function emptyPricePointSystemSettings() {
    return {
        version: 1,
        globalDiscount: {
            enabled: false,
            schedule: "permanent",
            period: "",
            method: "percent",
            value: 0
        },
        categoryDiscounts: {},
        dailyDiscountRules: [],
        nextDailyRuleId: 1,
        pointSale: {
            enabled: false,
            method: "multiplier",
            value: 0
        }
    };
}

function normalizePricePointSystemSettings(raw) {
    const out = emptyPricePointSystemSettings();
    if (!raw || typeof raw !== "object") return out;

    const gd = raw.globalDiscount;
    if (gd && typeof gd === "object") {
        out.globalDiscount.enabled = gd.enabled === true;
        out.globalDiscount.schedule = gd.schedule === "period" ? "period" : "permanent";
        out.globalDiscount.period = typeof gd.period === "string" ? gd.period : "";
        out.globalDiscount.method = gd.method === "amount" ? "amount" : "percent";
        const n = Number(gd.value);
        out.globalDiscount.value = Number.isFinite(n) && n > 0 ? n : 0;
    }

    const categories = raw.categoryDiscounts;
    if (categories && typeof categories === "object" && !Array.isArray(categories)) {
        for (const [name, cfg] of Object.entries(categories)) {
            const genre = cleanText(name).slice(0, 32);
            if (!genre || !cfg || typeof cfg !== "object") continue;
            const n = Number(cfg.value);
            out.categoryDiscounts[genre] = {
                enabled: cfg.enabled === true,
                schedule: cfg.schedule === "period" ? "period" : "permanent",
                period: typeof cfg.period === "string" ? cfg.period : "",
                method: cfg.method === "amount" ? "amount" : "percent",
                value: Number.isFinite(n) && n > 0 ? n : 0
            };
        }
    }

    if (Array.isArray(raw.dailyDiscountRules)) {
        for (const src of raw.dailyDiscountRules.slice(0, 24)) {
            if (!src || typeof src !== "object") continue;
            const trigger = src.trigger === "stock" ? "stock" : "time";
            const method = src.method === "percent" ? "percent" : "amount";
            let conditionValue = src.conditionValue;
            let timeMode = src.timeMode === "beforeClose" ? "beforeClose" : "clock";

            if (trigger === "time" && timeMode === "clock") {
                conditionValue = normalizeDailySupplyClock(conditionValue);
                if (conditionValue === undefined || !conditionValue) continue;
            } else {
                const n = Math.trunc(Number(conditionValue));
                if (!Number.isFinite(n) || n < 0) continue;
                conditionValue = n;
            }

            const value = Number(src.value);
            if (!Number.isFinite(value) || value <= 0) continue;

            out.dailyDiscountRules.push({
                id: String(src.id ?? `r${out.nextDailyRuleId}`),
                departmentId: typeof src.departmentId === "string" ? src.departmentId : "",
                trigger,
                timeMode,
                conditionValue,
                method,
                value
            });
            out.nextDailyRuleId++;
        }
    }

    const next = Math.trunc(Number(raw.nextDailyRuleId));
    if (Number.isFinite(next) && next > out.nextDailyRuleId) out.nextDailyRuleId = next;

    const ps = raw.pointSale;
    if (ps && typeof ps === "object") {
        out.pointSale.enabled = ps.enabled === true;
        out.pointSale.method = ps.method === "add" ? "add" : "multiplier";
        const n = Number(ps.value);
        out.pointSale.value = Number.isFinite(n) && n > 0 ? n : 0;
    }

    return out;
}

function pricePointSettingsForStore(store) {
    return normalizePricePointSystemSettings(store?.pricePointSystem);
}

function updateStorePricePointSettings(storeId, updater) {
    const reg = loadStores();
    const store = reg.stores[storeId];
    if (!store) return false;
    const settings = pricePointSettingsForStore(store);
    updater(settings, store);
    store.pricePointSystem = settings;
    return saveStores(reg);
}

function discountMethodText(method, value) {
    const n = Number(value) || 0;
    return method === "amount"
        ? `${n.toLocaleString("ja-JP")}単位引き`
        : `${n}%引き`;
}

function discountScheduleText(cfg) {
    if (!cfg?.enabled || !(Number(cfg.value) > 0)) return "未設定";
    const when = cfg.schedule === "period" ? (cfg.period || "期間未設定") : "恒常";
    return `${when} / ${discountMethodText(cfg.method, cfg.value)}`;
}

function pointSaleText(cfg) {
    if (!cfg?.enabled || !(Number(cfg.value) > 0)) return "未設定";
    if (cfg.method === "add") return `+${Math.trunc(Number(cfg.value))}ポイント`;
    return `ポイント ×${Number(cfg.value)}`;
}

function parsePositiveDiscountValue(raw, method) {
    const text = toHalfWidthDigits(String(raw ?? "")).trim();
    if (!text) return undefined;
    if (!/^\d+$/.test(text)) return undefined;
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n <= 0) return undefined;
    if (method === "percent" && n > 100) return undefined;
    return n;
}

function productGenresForStoreBlock(block, pp) {
    const set = new Set(Object.keys(pp?.categoryDiscounts ?? {}));
    for (const id of loadProductIndex(block)) {
        const record = loadProduct(block, id);
        const genre = cleanText(record?.settings?.shop_product_genre ?? "").slice(0, 32);
        if (genre) set.add(genre);
    }
    return [...set].sort();
}

function dailyDiscountRuleText(rule, store) {
    const dept = store?.departments?.find(d => d.id === rule.departmentId);
    const deptName = dept?.name ?? "削除済みの売り場";
    let condition;
    if (rule.trigger === "stock") {
        condition = `在庫${rule.conditionValue}個以下`;
    } else if (rule.timeMode === "beforeClose") {
        condition = `閉店${rule.conditionValue}分前から`;
    } else {
        condition = `${rule.conditionValue}以降`;
    }
    return `${deptName} / ${condition} / ${discountMethodText(rule.method, rule.value)}`;
}

async function showGlobalDiscountForm(player, dimension, location) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const storeId = getBlockStoreId(block);
    const store = reg.stores[storeId];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);
    const cfg = pp.globalDiscount;

    const form = new ModalFormData().title("全体割引");
    form.toggle("全体割引を有効にする", { defaultValue: cfg.enabled === true });
    form.dropdown(
        "適用方法",
        ["恒常割引", "期間指定"],
        { defaultValueIndex: cfg.schedule === "period" ? 1 : 0 }
    );
    form.textField(
        "期間",
        "例: 2026-10-07～2026-10-31（恒常割引なら空欄）",
        { defaultValue: cfg.period ?? "" }
    );
    form.dropdown(
        "割引方法",
        ["パーセント割引", "単位数割引"],
        { defaultValueIndex: cfg.method === "amount" ? 1 : 0 }
    );
    form.textField(
        "割引値",
        "例: 20 → 20%引き / 100 → 100単位引き",
        { defaultValue: cfg.value ? String(cfg.value) : "" }
    );
    form.submitButton("保存");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showLandingPricePointSystem(player, dimension, location);
    const v = res.formValues ?? [];
    const enabled = v[0] === true;
    const schedule = Number(v[1]) === 1 ? "period" : "permanent";
    const periodRaw = String(v[2] ?? "").trim();
    const method = Number(v[3]) === 1 ? "amount" : "percent";
    const value = parsePositiveDiscountValue(v[4], method);

    let period = "";
    if (schedule === "period") {
        period = normalizeLimitedPeriod(periodRaw);
        if (period === undefined || !period) {
            tell(player, "§c[価格] 期間は 2026-10-07～2026-10-31 の形式で入力してください");
            return showGlobalDiscountForm(player, dimension, location);
        }
    }
    if (enabled && value === undefined) {
        tell(player, `§c[価格] ${method === "percent" ? "割引率は1～100" : "単位割引は1以上の整数"}で入力してください`);
        return showGlobalDiscountForm(player, dimension, location);
    }

    updateStorePricePointSettings(storeId, settings => {
        settings.globalDiscount = {
            enabled,
            schedule,
            period,
            method,
            value: value ?? 0
        };
    });
    tell(player, "§a[価格] 全体割引を保存しました");
    return showLandingPricePointSystem(player, dimension, location);
}

async function showCategoryDiscountMenu(player, dimension, location) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);
    const genres = productGenresForStoreBlock(block, pp);

    const form = new ActionFormData().title("分類割引");
    form.body(
        genres.length
            ? "商品設定の「商品ジャンル」ごとに割引を設定します。"
            : "商品ジャンルがまだありません。下からジャンル名を指定して作成できます。"
    );
    for (const genre of genres) {
        const cfg = pp.categoryDiscounts[genre];
        form.button(`${genre}\n§8${cfg ? discountScheduleText(cfg) : "未設定"}`);
    }
    form.button("＋ 商品ジャンル名を指定");
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showLandingPricePointSystem(player, dimension, location);
    if (res.selection < genres.length) {
        return showCategoryDiscountForm(player, dimension, location, genres[res.selection]);
    }
    if (res.selection === genres.length) {
        return showCategoryDiscountForm(player, dimension, location, "");
    }
    return showLandingPricePointSystem(player, dimension, location);
}

async function showCategoryDiscountForm(player, dimension, location, currentGenre) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const storeId = getBlockStoreId(block);
    const store = reg.stores[storeId];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);
    const cfg = pp.categoryDiscounts[currentGenre] ?? {
        enabled: true,
        schedule: "permanent",
        period: "",
        method: "percent",
        value: 0
    };

    const form = new ModalFormData().title(currentGenre ? `分類割引：${currentGenre}` : "分類割引を追加");
    form.textField("商品ジャンル", "例: 惣菜", { defaultValue: currentGenre ?? "" });
    form.toggle("この分類割引を有効にする", { defaultValue: cfg.enabled === true });
    form.dropdown(
        "適用方法",
        ["恒常割引", "期間指定"],
        { defaultValueIndex: cfg.schedule === "period" ? 1 : 0 }
    );
    form.textField(
        "期間",
        "例: 2026-10-07～2026-10-31（恒常割引なら空欄）",
        { defaultValue: cfg.period ?? "" }
    );
    form.dropdown(
        "割引方法",
        ["パーセント割引", "単位数割引"],
        { defaultValueIndex: cfg.method === "amount" ? 1 : 0 }
    );
    form.textField(
        "割引値",
        "例: 10 → 10%引き / 50 → 50単位引き",
        { defaultValue: cfg.value ? String(cfg.value) : "" }
    );
    if (currentGenre) {
        form.toggle("この分類割引を削除する", { defaultValue: false });
    }
    form.submitButton("保存");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showCategoryDiscountMenu(player, dimension, location);
    const v = res.formValues ?? [];
    const genre = cleanText(v[0] ?? "").replace(/§/g, "").slice(0, 32);
    const enabled = v[1] === true;
    const schedule = Number(v[2]) === 1 ? "period" : "permanent";
    const periodRaw = String(v[3] ?? "").trim();
    const method = Number(v[4]) === 1 ? "amount" : "percent";
    const value = parsePositiveDiscountValue(v[5], method);
    const remove = currentGenre ? v[6] === true : false;

    if (remove) {
        updateStorePricePointSettings(storeId, settings => {
            delete settings.categoryDiscounts[currentGenre];
        });
        tell(player, `§a[価格] 「${currentGenre}」の分類割引を削除しました`);
        return showCategoryDiscountMenu(player, dimension, location);
    }

    if (!genre) {
        tell(player, "§c[価格] 商品ジャンルを入力してください");
        return showCategoryDiscountForm(player, dimension, location, currentGenre);
    }

    let period = "";
    if (schedule === "period") {
        period = normalizeLimitedPeriod(periodRaw);
        if (period === undefined || !period) {
            tell(player, "§c[価格] 期間は 2026-10-07～2026-10-31 の形式で入力してください");
            return showCategoryDiscountForm(player, dimension, location, currentGenre);
        }
    }
    if (enabled && value === undefined) {
        tell(player, `§c[価格] ${method === "percent" ? "割引率は1～100" : "単位割引は1以上の整数"}で入力してください`);
        return showCategoryDiscountForm(player, dimension, location, currentGenre);
    }

    updateStorePricePointSettings(storeId, settings => {
        if (currentGenre && currentGenre !== genre) delete settings.categoryDiscounts[currentGenre];
        settings.categoryDiscounts[genre] = {
            enabled,
            schedule,
            period,
            method,
            value: value ?? 0
        };
    });
    tell(player, `§a[価格] 「${genre}」の分類割引を保存しました`);
    return showCategoryDiscountMenu(player, dimension, location);
}

async function showDailyDiscountMenu(player, dimension, location) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);

    const form = new ActionFormData().title("日配品割引");
    form.body([
        "売り場ごとに条件を複数設定できます。",
        "条件は「時間に応じて」または「在庫数に応じて」。",
        "割引は「単位数割引」または「パーセント割引」です。"
    ].join("\n"));
    for (const rule of pp.dailyDiscountRules) {
        form.button(dailyDiscountRuleText(rule, store));
    }
    form.button("＋ 条件を追加");
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showLandingPricePointSystem(player, dimension, location);
    if (res.selection < pp.dailyDiscountRules.length) {
        return showDailyDiscountAreaPicker(player, dimension, location, res.selection);
    }
    if (res.selection === pp.dailyDiscountRules.length) {
        if (!store.departments.length) {
            tell(player, "§e[日配品割引] 先に「売り場区画管理システム」で売り場を作成してください");
            return showDailyDiscountMenu(player, dimension, location);
        }
        return showDailyDiscountAreaPicker(player, dimension, location, -1);
    }
    return showLandingPricePointSystem(player, dimension, location);
}

async function showDailyDiscountAreaPicker(player, dimension, location, ruleIndex) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    if (!store.departments.length) {
        tell(player, "§e[日配品割引] 設定できる売り場がありません");
        return showDailyDiscountMenu(player, dimension, location);
    }

    const pp = pricePointSettingsForStore(store);
    const current = ruleIndex >= 0 ? pp.dailyDiscountRules[ruleIndex] : undefined;
    const form = new ActionFormData().title(ruleIndex >= 0 ? "日配品割引：売り場" : "日配品割引を追加");
    form.body("割引条件を適用する売り場を選んでください。");
    for (const dept of store.departments) {
        const mark = current?.departmentId === dept.id ? "§a▶ " : "";
        form.button(`${mark}${dept.name}`);
    }
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled || res.selection >= store.departments.length) {
        return showDailyDiscountMenu(player, dimension, location);
    }
    const departmentId = store.departments[res.selection].id;
    return showDailyDiscountTriggerPicker(player, dimension, location, ruleIndex, departmentId);
}

async function showDailyDiscountTriggerPicker(player, dimension, location, ruleIndex, departmentId) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;

    const form = new ActionFormData().title("日配品割引：条件");
    form.body("値引きを開始する条件を選んでください。");
    form.button("時間に応じて");
    form.button("在庫数に応じて");
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled || res.selection === 2) {
        return showDailyDiscountAreaPicker(player, dimension, location, ruleIndex);
    }
    if (res.selection === 0) {
        return showDailyDiscountTimeModePicker(player, dimension, location, ruleIndex, departmentId);
    }
    return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, "stock", "");
}

async function showDailyDiscountTimeModePicker(player, dimension, location, ruleIndex, departmentId) {
    const form = new ActionFormData().title("日配品割引：時間条件");
    form.body("時間条件の基準を選んでください。");
    form.button("時刻を指定\n§818:00から、など");
    form.button("閉店までの残り時間\n§8閉店120分前から、など");
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled || res.selection === 2) {
        return showDailyDiscountTriggerPicker(player, dimension, location, ruleIndex, departmentId);
    }
    return showDailyDiscountEditor(
        player,
        dimension,
        location,
        ruleIndex,
        departmentId,
        "time",
        res.selection === 1 ? "beforeClose" : "clock"
    );
}

async function showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const storeId = getBlockStoreId(block);
    const store = reg.stores[storeId];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);
    const current = ruleIndex >= 0 ? pp.dailyDiscountRules[ruleIndex] : undefined;

    let defaultCondition = "";
    if (
        current &&
        current.trigger === trigger &&
        (trigger !== "time" || current.timeMode === timeMode)
    ) {
        defaultCondition = String(current.conditionValue ?? "");
    }

    const form = new ModalFormData().title(ruleIndex >= 0 ? "日配品割引を編集" : "日配品割引を追加");
    if (trigger === "stock") {
        form.textField(
            "在庫数がこの数以下になったら",
            "例: 10",
            { defaultValue: defaultCondition }
        );
    } else if (timeMode === "beforeClose") {
        form.textField(
            "閉店の何分前から",
            "例: 120（2時間前）",
            { defaultValue: defaultCondition }
        );
    } else {
        form.textField(
            "割引開始時刻",
            "例: 18:00",
            { defaultValue: defaultCondition }
        );
    }
    form.dropdown(
        "割引方法",
        ["単位数割引", "パーセント割引"],
        { defaultValueIndex: current?.method === "percent" ? 1 : 0 }
    );
    form.textField(
        "割引値",
        "例: 100 → 100単位引き / 30 → 30%引き",
        { defaultValue: current?.value ? String(current.value) : "" }
    );
    if (ruleIndex >= 0) form.toggle("この条件を削除する", { defaultValue: false });
    form.submitButton("保存");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showDailyDiscountMenu(player, dimension, location);
    const v = res.formValues ?? [];
    const conditionRaw = String(v[0] ?? "").trim();
    const method = Number(v[1]) === 1 ? "percent" : "amount";
    const value = parsePositiveDiscountValue(v[2], method);
    const remove = ruleIndex >= 0 ? v[3] === true : false;

    if (remove) {
        updateStorePricePointSettings(storeId, settings => {
            if (ruleIndex >= 0 && ruleIndex < settings.dailyDiscountRules.length) {
                settings.dailyDiscountRules.splice(ruleIndex, 1);
            }
        });
        tell(player, "§a[日配品割引] 条件を削除しました");
        return showDailyDiscountMenu(player, dimension, location);
    }

    let conditionValue;
    if (trigger === "time" && timeMode === "clock") {
        conditionValue = normalizeDailySupplyClock(conditionRaw);
        if (conditionValue === undefined || !conditionValue) {
            tell(player, "§c[日配品割引] 時刻は HH:MM で入力してください");
            return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode);
        }
    } else {
        const text = toHalfWidthDigits(conditionRaw);
        if (!/^\d+$/.test(text)) {
            tell(player, "§c[日配品割引] 条件値は0以上の整数で入力してください");
            return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode);
        }
        conditionValue = Number(text);
        if (!Number.isSafeInteger(conditionValue) || conditionValue < 0) {
            tell(player, "§c[日配品割引] 条件値が大きすぎます");
            return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode);
        }
        if (trigger === "time" && timeMode === "beforeClose" && conditionValue <= 0) {
            tell(player, "§c[日配品割引] 閉店前の時間は1分以上で入力してください");
            return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode);
        }
    }

    if (value === undefined) {
        tell(player, `§c[日配品割引] ${method === "percent" ? "割引率は1～100" : "単位割引は1以上の整数"}で入力してください`);
        return showDailyDiscountEditor(player, dimension, location, ruleIndex, departmentId, trigger, timeMode);
    }

    updateStorePricePointSettings(storeId, settings => {
        const rule = {
            id: ruleIndex >= 0
                ? (settings.dailyDiscountRules[ruleIndex]?.id ?? `r${settings.nextDailyRuleId++}`)
                : `r${settings.nextDailyRuleId++}`,
            departmentId,
            trigger,
            timeMode: trigger === "time" ? timeMode : "clock",
            conditionValue,
            method,
            value
        };
        if (ruleIndex >= 0 && ruleIndex < settings.dailyDiscountRules.length) {
            settings.dailyDiscountRules[ruleIndex] = rule;
        } else {
            settings.dailyDiscountRules.push(rule);
        }
    });
    tell(player, "§a[日配品割引] 条件を保存しました");
    return showDailyDiscountMenu(player, dimension, location);
}

async function showPointSaleForm(player, dimension, location) {
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== PANEL_ID) return;
    const reg = loadStores();
    const storeId = getBlockStoreId(block);
    const store = reg.stores[storeId];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);
    const cfg = pp.pointSale;

    const form = new ModalFormData().title("ポイント特売");
    form.toggle("ポイント特売を有効にする", { defaultValue: cfg.enabled === true });
    form.dropdown(
        "ポイント方法",
        ["ポイント倍", "ポイント加算"],
        { defaultValueIndex: cfg.method === "add" ? 1 : 0 }
    );
    form.textField(
        "値",
        "例: 2 → 2倍 / 50 → +50ポイント",
        { defaultValue: cfg.value ? String(cfg.value) : "" }
    );
    form.submitButton("保存");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return showLandingPricePointSystem(player, dimension, location);
    const v = res.formValues ?? [];
    const enabled = v[0] === true;
    const method = Number(v[1]) === 1 ? "add" : "multiplier";
    const raw = toHalfWidthDigits(String(v[2] ?? "")).trim();
    let value;

    if (method === "add") {
        if (/^\d+$/.test(raw)) {
            const n = Number(raw);
            if (Number.isSafeInteger(n) && n > 0) value = n;
        }
    } else {
        if (/^\d+(?:\.\d{1,2})?$/.test(raw)) {
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0 && n <= 100) value = n;
        }
    }

    if (enabled && value === undefined) {
        tell(player, `§c[ポイント] ${method === "add" ? "加算ポイントは1以上の整数" : "倍率は0より大きい100以下（小数2桁まで）"}で入力してください`);
        return showPointSaleForm(player, dimension, location);
    }

    updateStorePricePointSettings(storeId, settings => {
        settings.pointSale = {
            enabled,
            method,
            value: value ?? 0
        };
    });
    tell(player, "§a[ポイント] ポイント特売を保存しました");
    return showLandingPricePointSystem(player, dimension, location);
}

async function showLandingPricePointSystem(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;
    const pp = pricePointSettingsForStore(store);

    const enabledCategories = Object.values(pp.categoryDiscounts).filter(x => x?.enabled && Number(x.value) > 0).length;
    const form = new ActionFormData().title("価格・ポイントシステム");
    form.body([
        "店舗全体の価格・ポイントルールを設定します。",
        "商品個別の価格・ポイント設定はそのまま残り、この画面は店舗側の追加ルールです。"
    ].join("\n"));
    form.button(`全体割引\n§8${discountScheduleText(pp.globalDiscount)}`);
    form.button(`分類割引\n§8有効 ${enabledCategories}分類`);
    form.button(`日配品割引\n§8${pp.dailyDiscountRules.length}条件`);
    form.button(`ポイント特売\n§8${pointSaleText(pp.pointSale)}`);
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    if (res.selection === 0) return showGlobalDiscountForm(player, dimension, location);
    if (res.selection === 1) return showCategoryDiscountMenu(player, dimension, location);
    if (res.selection === 2) return showDailyDiscountMenu(player, dimension, location);
    if (res.selection === 3) return showPointSaleForm(player, dimension, location);
}


async function showLandingSalesFloorSystem(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;

    const form = new ActionFormData()
        .title("売り場区画管理システム")
        .body(`現在の売り場区画: ${store.departments.length}件`)
        .button("＋ 売り場区画を作成")
        .button("既存の売り場区画を編集")
        .button("戻る");
    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    if (res.selection === 0) return createLandingDeptForm(player, dimension, location);
    if (res.selection === 1) return showDeptManager(player, dimension, location);
}

async function showLandingInventorySystem(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;

    const ids = loadProductIndex(block);
    const rows = ids.map(id => loadProduct(block, id));
    const out = rows.filter(r => Array.isArray(r.stock) && r.stock.every(x => (Number(x?.item?.amount) || 0) <= 0)).length;

    const form = new ActionFormData().title("在庫管理システム");
    form.body([
        `登録商品: ${rows.length}件`,
        `保存在庫0の商品: ${out}件`,
        "",
        "商品ごとの保存在庫を確認できます。入荷・補充方法の変更は各商品設定で行います。"
    ].join("\n"));
    for (const record of rows) {
        form.button(`${landingProductDisplayName(record)}\n§8${landingSavedStockSummary(record)}`);
    }
    form.button("戻る");

    const res = await showFormWithRetry(player, form);
    if (!res || res.canceled) return;
    const record = rows[res.selection];
    if (!record) return;

    const detail = new ActionFormData()
        .title(landingProductDisplayName(record))
        .body([
            `保存在庫: ${landingSavedStockSummary(record)}`,
            `補充方式: ${["補充なし", "時刻で補充", "手動補充", "一定秒数ごと"][
                savedChoice(record.settings, "shop_stock_replenish", 3)
            ] ?? "補充なし"}`,
            "",
            "在庫の実アイテム編集は商品一覧から商品を開いて行ってください。"
        ].join("\n"))
        .button("戻る");
    await showFormWithRetry(player, detail);
    return showLandingInventorySystem(player, dimension, location);
}

async function showLandingSalesSystem(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;

    const form = new ActionFormData()
        .title("売上管理システム")
        .body([
            "ここでは最終的に、売上金額・販売個数・割引額・ポイント付与量を",
            "今日 / 7日 / 30日、商品別・売り場別・店舗別で確認できるようにします。",
            "",
            "現在のパックは購入処理がまだ接続されていないため、",
            "実売上データの集計はまだ開始していません。"
        ].join("\n"))
        .button("戻る");
    await showFormWithRetry(player, form);
}

async function storeHoursForm(player, dimension, location) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(dimension.getBlock(location))];
    if (!store || !canManageStore(player, store)) return;
    const f = new ModalFormData().title("営業時間");
    f.textField("営業時間", "例: 9:00〜18:00", { defaultValue: store.hours ?? "" });
    f.submitButton("保存");
    const r = await showFormWithRetry(player, f);
    if (!r || r.canceled) return;
    const v = String((r.formValues ?? []).find(x => typeof x === "string") ?? "").trim().replace(/§/g, "").slice(0, HOURS_MAX);
    const fresh = loadStores();
    fresh.stores[store.id].hours = v;
    saveStores(fresh);
    tell(player, `§a[店舗] 営業時間を「${v || "未入力"}」にしました`);
}

// 商品一覧から使う「売場作成」。
// 商品設定側の createDeptForm と違い、売場だけを店舗へ追加し、
// 現在のブロック/商品をその売場へ自動所属させない。
async function createLandingDeptForm(player, dimension, location) {
    const block = dimension.getBlock(location);
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store || !canManageStore(player, store)) return;

    const name = await askName(
        player,
        "売場作成",
        "売場名",
        "例: 食料品",
        "",
        DEPT_NAME_MAX
    );
    if (!name) return;

    const fresh = loadStores();
    const st = fresh.stores[store.id];
    if (!st) return;

    // 同じ店舗内で同名の売場を重複作成しない。
    if (st.departments.some(d => String(d.name).trim() === name)) {
        tell(player, `§e[店舗] 売場「${name}」はすでにあります`);
        return;
    }

    const id = `d${st.nextDeptId}`;
    st.nextDeptId += 1;
    st.departments.push({ id, name });
    saveStores(fresh);

    tell(player, `§a[店舗] 売場「${name}」を作成しました`);
}

async function createGroupForm(player, dimension, location) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(dimension.getBlock(location))];
    if (!store || !canManageStore(player, store)) return;
    const name = await askName(player, "新しい系列", "系列名", "例: 中央マーケットグループ", `${store.name}グループ`.slice(0, GROUP_NAME_MAX), GROUP_NAME_MAX);
    if (!name) return;
    const f = loadStores();
    const gid = `g${f.nextGroupId}`;
    f.nextGroupId += 1;
    f.groups[gid] = { id: gid, name, owner: { id: player.id, name: player.name }, headId: store.id };
    f.stores[store.id].groupId = gid;
    saveStores(f);
    tell(player, `§a[店舗] 系列「${name}」を作り、この店舗を本店にしました`);
}

async function pickGroupForm(player, dimension, location) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(dimension.getBlock(location))];
    if (!store || !canManageStore(player, store)) return;
    const groups = Object.values(reg.groups).filter(g => canManageGroup(player, g) || g.id === store.groupId);
    const f = new ActionFormData().title("所属系列店");
    for (const g of groups) f.button(`${g.id === store.groupId ? "§a▶ " : ""}${g.name}`);
    f.button("戻る");
    const r = await showFormWithRetry(player, f);
    const g = r && !r.canceled ? groups[r.selection] : undefined;
    if (g) setStoreGroup(player, store.id, g.id);
}

// Join (as a branch; head if the group has none) or leave (gid undefined).
function setStoreGroup(player, storeId, gid) {
    const f = loadStores();
    const st = f.stores[storeId];
    if (!st) return;
    const oldGid = st.groupId;
    if (oldGid === gid) return;
    if (oldGid) {
        delete st.groupId;
        const rest = Object.values(f.stores).filter(x => x.groupId === oldGid);
        const og = f.groups[oldGid];
        // 誰もいなくなった系列は残す（一覧のゴミ箱から削除できる）
        if (og && og.headId === st.id) og.headId = rest[0]?.id;
    }
    if (gid && f.groups[gid]) {
        st.groupId = gid;
        if (!f.stores[f.groups[gid].headId] || f.stores[f.groups[gid].headId].groupId !== gid) f.groups[gid].headId = st.id;
        tell(player, `§a[店舗] 系列「${f.groups[gid].name}」に入りました`);
    } else {
        tell(player, "§7[店舗] 系列から抜けました");
    }
    saveStores(f);
}

// ---- 系列店の削除（商品削除の確認と同じ形の、画面内の確認） ----
function beginGroupDelete(player, rec, block, container, row) {
    // 商品削除（beginProductDeleteConfirm）と同じ：即座に確認を出す。
    // ゴミ箱は商品と同じ container_slot_button_prototype になったので遅延は不要。
    rec.groupDelete = { id: row.id, name: row.label, ready: true, stage: 1 };
    const m = landingModel(player, rec, block);
    writeGroupState(container, rec, m, false);   // 系列リストを閉じる
    writeGroupChoices(container, rec, m);
    setProbe(container, GROUP_DEL_YES_SLOT, 1);            // 削除する
    setProbe(container, GROUP_DEL_NO_SLOT, 1);             // 削除しない
    setProbe(container, GROUP_DEL_STATE_SLOT, GROUP_DEL_CONFIRM);
}

function endGroupDelete(player, rec, block, container) {
    rec.groupDelete = undefined;
    rec.landingOpen = false;
    // 商品削除確認と同じく、確認専用3スロットだけを元へ戻す。
    setProbe(container, GROUP_DEL_YES_SLOT, 1);
    setProbe(container, GROUP_DEL_NO_SLOT, 1);
    setProbe(container, GROUP_DEL_STATE_SLOT, GROUP_DEL_HIDDEN);
    const m = landingModel(player, rec, block);
    writeGroupDd(container, rec, m);
    writeHeadToggle(container, rec, m); // 選択中系列を削除した場合は本店トグルも即ロック状態へ戻す
    touchPlayerInventory(player);
}

function tickGroupDelete(player, rec, block, container) {
    const del = rec.groupDelete;
    if (!del?.ready) return true;

    // 商品削除と同じ：YES の専用シグナルが1回のクリックで消えたら即削除。
    if (!signalIntact(container, GROUP_DEL_YES_SLOT, 1)) {
        clearProbeFromPlayer(player);

        // 1段目の「削除する」→ 2段目の最終確認へ（まだ削除しない）
        if (del.stage !== 2) {
            del.stage = 2;
            setProbe(container, GROUP_DEL_YES_SLOT, 1);
            setProbe(container, GROUP_DEL_NO_SLOT, 1);
            setProbe(container, GROUP_DEL_STATE_SLOT, GROUP_DEL_CONFIRM_FINAL);
            return true;
        }

        const reg = loadStores();
        const g = reg.groups[del.id];
        if (g && canManageGroup(player, g)) {
            // 選択済み・他店舗所属を含め、系列削除時は所属店舗を先に全て未所属へ戻す。
            let detached = 0;
            for (const st of Object.values(reg.stores)) {
                if (st.groupId !== del.id) continue;
                delete st.groupId;
                detached++;
            }
            delete reg.groups[del.id];
            saveStores(reg);
            tell(player, detached > 0
                ? `§a[店舗] 系列店「${g.name}」を削除しました（${detached}店舗を未所属に戻しました）`
                : `§a[店舗] 系列店「${g.name}」を削除しました`);
        } else {
            tell(player, "§c[店舗] この系列店を削除する権限がありません");
        }
        endGroupDelete(player, rec, block, container);
        return true;
    }

    // 商品削除と同じ：NO の専用シグナルだけを見る。
    // 状態slot42の一時変化はキャンセル扱いにしない。
    if (!signalIntact(container, GROUP_DEL_NO_SLOT, 1)) {
        clearProbeFromPlayer(player);
        endGroupDelete(player, rec, block, container);
        return true;
    }

    // 確認中に裏の状態スロット(42)が押されても無視せず元へ戻す（吸われたままにしない）
    if (!signalIntact(container, LP.groupHeader, rec.landingGroupStateAmount ?? -1)) {
        clearProbeFromPlayer(player);
        writeGroupState(container, rec, landingModel(player, rec, block), false);
    }

    return true;   // 確認中は他の操作を受け付けない
}

// ============================================================
// 価格・ポイントシステム（画面内） SALE_LAYOUT_SLOT = 8
// 第1段階：画面の切り替え＋戻る/保存/キャンセル。
// ボタンは 55 番以降のスロットが使えるかの確認を兼ねて 60/61/62 に置く。
// 設定は rec.priceMode.draft（下書き）で触り、保存した時だけ店舗へ書く。
// ============================================================
const PRICE_MODE = 8;
const PRICE_SLOTS = { save: 61, cancel: 62 };
// 全体割引（スロットの個数で表示を切り替える。文字の書き込みは不要）
const PP_G_HEAD = 63;              // 2=閉 3=開（個数1はUIで空文字になるので使わない）
const PP_M_HEAD = 64;              // 2=閉%  3=閉単位  4=開%  5=開単位
const PP_M_OPTS = [65, 66];        // パーセント割引 / 単位数割引
const PP_P_HEAD = 67;              // 2..9=閉(選択中) 10..17=開
const PP_P_OPTS = [68, 69, 70, 71, 72, 73, 74, 75];
const PP_PCT_VALUES = [0, 5, 10, 25, 30, 50, 90, 99];
const PP_TEST_SLOTS = [];

function priceAllSlots() {
    return [...Object.values(PRICE_SLOTS), PP_G_HEAD, PP_M_HEAD, ...PP_M_OPTS, PP_P_HEAD, ...PP_P_OPTS, ...PP_TEST_SLOTS];
}

function clearPriceSlots(container) {
    if (!container) return;
    for (const slot of priceAllSlots()) {
        try { if (slot < container.size && isProbe(container.getItem(slot))) container.setItem(slot, undefined); } catch {}
    }
}

function writePriceUI(container, rec) {
    const pm = rec.priceMode;
    const g = pm.draft.globalDiscount;
    const ui = pm.ui;
    const expect = new Map();
    const put = (slot, n) => { if (slot < container.size) { setProbe(container, slot, n); expect.set(slot, n); } };
    put(PRICE_SLOTS.save, 1);
    put(PRICE_SLOTS.cancel, 1);
    put(PP_G_HEAD, ui.gOpen ? 3 : 2);
    const m = g.method === "amount" ? 1 : 0;
    put(PP_M_HEAD, ui.mOpen ? 4 + m : 2 + m);
    for (const s of PP_M_OPTS) put(s, 2);
    let idx = PP_PCT_VALUES.indexOf(g.method === "percent" && g.enabled ? Number(g.value) : 0);
    if (idx < 0) idx = 0;
    put(PP_P_HEAD, ui.pOpen ? 10 + idx : 2 + idx);
    for (const s of PP_P_OPTS) put(s, 2);
    for (const s of PP_TEST_SLOTS) put(s, 1);
    pm.expect = expect;
}

function enterPriceMode(player, rec, block, container) {
    const reg = loadStores();
    const store = reg.stores[getBlockStoreId(block)];
    if (!store) {
        tell(player, "§e[価格] 先に店舗名を設定してください");
        return;
    }
    rec.landing = false;
    rec.landingOpen = false;
    rec.priceMode = {
        storeId: store.id,
        draft: JSON.parse(JSON.stringify(pricePointSettingsForStore(store))),
        ui: { gOpen: false, mOpen: false, pOpen: false }
    };
    if (container.size < 256) tell(player, `§e[価格] スロット数 ${container.size}（256未満）。一度ショップを置き直すと256になります`);
    setProbe(container, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE);
    writePriceUI(container, rec);
    deferVisualCommit(player, rec, (b, c) => {
        setProbe(c, SALE_LAYOUT_SLOT, PRICE_MODE);
    });
}

function exitPriceMode(player, rec, block, container, save) {
    const pm = rec.priceMode;
    rec.priceMode = undefined;
    clearPriceSlots(container);
    if (save && pm) {
        const ok = updateStorePricePointSettings(pm.storeId, settings => {
            Object.assign(settings, JSON.parse(JSON.stringify(pm.draft)));
        });
        tell(player, ok ? "§a[価格] 価格・ポイントの設定を保存しました" : "§c[価格] 保存できませんでした");
    }
    armLanding(player, rec, block, container);
}

function handlePriceClick(player, rec, slot) {
    const pm = rec.priceMode;
    const ui = pm.ui;
    const g = pm.draft.globalDiscount;
    if (slot === PP_G_HEAD) {
        ui.gOpen = !ui.gOpen; ui.mOpen = false; ui.pOpen = false;
        return;
    }
    if (slot === PP_M_HEAD) {
        ui.mOpen = !ui.mOpen; ui.pOpen = false;
        return;
    }
    const mi = PP_M_OPTS.indexOf(slot);
    if (mi >= 0) {
        if (ui.mOpen) g.method = mi === 0 ? "percent" : "amount";
        ui.mOpen = false;
        return;
    }
    if (slot === PP_P_HEAD) { ui.pOpen = !ui.pOpen; ui.mOpen = false; return; }
    const pi = PP_P_OPTS.indexOf(slot);
    if (pi >= 0) {
        if (ui.pOpen) {
            g.method = "percent";
            g.value = PP_PCT_VALUES[pi];
            g.enabled = g.value > 0;
        }
        ui.pOpen = false;
    }
}

function tickPriceMode(player, rec, block, container) {
    if (!signalIntact(container, PRICE_SLOTS.save, 1)) {
        clearProbeFromPlayer(player);
        exitPriceMode(player, rec, block, container, true);
        return true;
    }
    if (!signalIntact(container, PRICE_SLOTS.cancel, 1)) {
        clearProbeFromPlayer(player);
        tell(player, "§7[価格] 変更を取り消しました");
        exitPriceMode(player, rec, block, container, false);
        return true;
    }
    for (const [slot, n] of rec.priceMode.expect ?? []) {
        if (signalIntact(container, slot, n)) continue;
        clearProbeFromPlayer(player);
        handlePriceClick(player, rec, slot);
        writePriceUI(container, rec);
        return true;
    }
    return true;   // 価格画面では他の操作を受け付けない
}

function tickLanding(player, rec, block, container) {
    if (rec.groupDelete) return tickGroupDelete(player, rec, block, container);
    const missing = (slot) => !isProbe(container.getItem(slot));
    // product cells
    for (const [slot, e] of rec.landingCells ?? []) {
        // Product cells hold a REAL item (native tooltip): "clicked" means
        // our display clone is gone (isDisplayClone false), not the usual
        // probe-missing check. The + cell still uses the probe signal.
        const gone = e.type === "plus" ? missing(slot) : !isDisplayClone(container.getItem(slot));
        if (!gone) continue;
        const id = e.type === "plus" ? createProduct(block) : e.id;
        enterProduct(player, rec, block, container, id);
        return true;
    }
    for (const [slot, dir] of [[LP.prev, -1], [LP.next, 1]]) {
        if (!missing(slot)) continue;
        rec.landingPage = (rec.landingPage ?? 0) + dir;
        refreshLandingPage(player, rec, block, container);
        return true;
    }
    if (missing(LP.name)) { openLandingForm(player, rec, block, (p, d, l) => showStoreInfoForm(p, d, l, getBlockStoreId(block))); return true; }
    if (missing(LP.hours)) { openLandingForm(player, rec, block, (p, d, l) => storeHoursForm(p, d, l)); return true; }
    if (missing(LP.pricePoints)) {
        // slot40 is also the text gate. Restore it before leaving the screen so
        // the button click cannot leave the landing labels hidden if closing fails.
        setProbe(container, LP.pricePoints, TEXT_GATE_SHOWN);
        enterPriceMode(player, rec, block, container);
        return true;
    }
    if (missing(LP.salesFloor)) {
        putProbe(container, LP.salesFloor, 1);
        openLandingForm(player, rec, block, (p, d, l) => showLandingSalesFloorSystem(p, d, l));
        return true;
    }
    if (missing(LP.inventory)) {
        putProbe(container, LP.inventory, 1);
        openLandingForm(player, rec, block, (p, d, l) => showLandingInventorySystem(p, d, l));
        return true;
    }
    if (missing(LP.salesManagement)) {
        putProbe(container, LP.salesManagement, 1);
        openLandingForm(player, rec, block, (p, d, l) => showLandingSalesSystem(p, d, l));
        return true;
    }
    if (!signalIntact(container, LP.settings, rec.landingHeadAmount ?? -1)) {
        clearProbeFromPlayer(player);
        const reg = loadStores();
        const store = reg.stores[getBlockStoreId(block)];
        const group = store?.groupId ? reg.groups[store.groupId] : undefined;
        if (!store || !group) {
            tell(player, "§7[店舗] 系列店に入っていないため、本店の設定はできません");
        } else if (!canManageGroup(player, group)) {
            tell(player, "§c[店舗] この系列を管理する権限がありません");
        } else if (group.headId === store.id) {
            group.headId = undefined;                 // OFF：この店を本店から外す
            saveStores(reg);
            tell(player, `§7[店舗] 「${store.name}」を本店から外しました`);
        } else {
            const prev = group.headId ? reg.stores[group.headId] : undefined;
            group.headId = store.id;                  // ON：同じ系列の前の本店は自動で解除
            saveStores(reg);
            tell(player, prev ? `§a[店舗] 「${store.name}」を本店にしました（「${prev.name}」は支店になりました）`
                              : `§a[店舗] 「${store.name}」を本店にしました`);
        }
        const m = landingModel(player, rec, block);
        // slot53 の値が変わるだけで「（本店）/（支店）」が切り替わる。
        // 系列名のゲート・名前スロットには触らない（店名を再表示させない）。
        writeHeadToggle(container, rec, m);
        return true;
    }
    // ---- 所属系列店：商品設定の「Active normal dropdown」と同じ順 ----
    // 1) 開いている時の選択肢
    if (rec.landingOpen) {
        // ゴミ箱（削除できる系列の行だけにある）
        for (const [ts, amount] of rec.landingTrashAmounts ?? []) {
            if (signalIntact(container, ts, amount)) continue;
            clearProbeFromPlayer(player);
            const row = rec.landingTrashRows?.get(ts);
            if (!row) { writeGroupChoices(container, rec, landingModel(player, rec, block)); return true; }
            beginGroupDelete(player, rec, block, container, row);
            return true;
        }
        for (const slot of LP.groupOpts) {
            if (signalIntact(container, slot, rec.landingGroupAmounts?.get(slot) ?? GROUP_DD_CHOICE_AMOUNT)) continue;
            clearProbeFromPlayer(player);
            const row = rec.landingGroupRows?.get(slot);
            const m0 = landingModel(player, rec, block);
            if (!row) {                       // 見えない空き行：戻すだけ
                writeGroupChoices(container, rec, m0);
                touchPlayerInventory(player);
                return true;
            }
            if (row.type === "group") {
                // 値を先に保存
                setStoreGroup(player, getBlockStoreId(block), row.id);
                const m = landingModel(player, rec, block);
                // t0 : ヘッダー文字のゲートを隠す（開いたリストがヘッダーの上に被さっているので見えない）
                //      → 新しい系列名を書く → 押された行を戻す → touch
                // t0+2 : リストを閉じる＋ヘッダーのゲートを出す（ここで新しい名前を読む）
                setProbe(container, LANDING_GROUP_GATE_SLOT, TEXT_GATE_HIDDEN);
                putNamedSignal(container, LANDING_GROUP_NAME_SLOT, 1, groupHeaderLabel(m));
                writeGroupChoices(container, rec, m);
                writeHeadToggle(container, rec, m);   // 系列が変わったら本店トグルも合わせる
                deferVisualCommit(player, rec, (b, c) => {
                    writeGroupState(c, rec, landingModel(player, rec, b), false);
                    setProbe(c, LANDING_GROUP_GATE_SLOT, TEXT_GATE_SHOWN);
                });
                return true;
            }
            if (row.type === "groupNext") {
                // 次のページ（最後の次は最初）。リストは開いたまま。
                // 名前を書き換える → touch → +2tick ゲートを隠す → +3tick 出す。
                // （一覧ページの店舗名・営業時間を書き換える refreshLanding と同じ手順）
                rec.landingGroupPage = (rec.landingGroupPage ?? 0) + 1;
                const m = landingModel(player, rec, block);   // ここで一周に丸める
                setProbe(container, LANDING_GROUP_ROW_GATE_SLOT, TEXT_GATE_HIDDEN);   // 選択肢の文字を先に隠す
                putNamedSignal(container, LANDING_GROUP_COUNT_SLOT, Math.max(2, Math.min(8, m.groupRows.length)), GROUP_DD_ROWS_TAG);
                writeGroupChoices(container, rec, m);
                writeGroupState(container, rec, m, true);
                // touch → 2tick後にゲートを出す（ここで全行が新しい名前を読む）
                deferVisualCommit(player, rec, (b, c) => {
                    setProbe(c, LANDING_GROUP_ROW_GATE_SLOT, TEXT_GATE_SHOWN);
                });
                return true;
            }
            writeGroupState(container, rec, m0, false);
            writeGroupChoices(container, rec, m0);
            if (row.type === "groupNew") openLandingForm(player, rec, block, (p, d, l) => createGroupForm(p, d, l));
            else if (row.type === "groupMore") openLandingForm(player, rec, block, (p, d, l) => pickGroupForm(p, d, l));
            return true;
        }
    }
    // 2) 状態スロット（ヘッダー/外側）
    if (!signalIntact(container, LP.groupHeader, rec.landingGroupStateAmount ?? -1)) {
        clearProbeFromPlayer(player);
        const m = landingModel(player, rec, block);
        if (rec.landingOpen) {
            // 閉じる：隠すだけなので即時
            writeGroupState(container, rec, m, false);
            writeGroupChoices(container, rec, m);
            return true;
        }
        // 開く：選択肢の文字が表示される切り替え。
        // 名前を書く(隠れたまま) → touch → 2tick後に表示、の決まりどおりにする。
        writeGroupState(container, rec, m, false);   // 崩れた状態を閉で戻しておく
        writeGroupChoices(container, rec, m);
        deferVisualCommit(player, rec, (b, c) => {
            writeGroupState(c, rec, landingModel(player, rec, b), true);
        });
        return true;
    }
    return false;
}

// ============================================================
// ショップのスロットは、ブロックに重ねた見えないモブ（panel_ui）が持つ。
// ブロックは設定（ダイナミックプロパティ）だけを持つ。
// モブは無敵・不動・エフェクト無効で、ブロックが壊れた時だけ消える。
// ============================================================
const PANEL_UI_ID = "shopuilook2:panel_ui";
const PANEL_UI_TITLE = "§s§h§o§p§r";   // chest_screen.json がこの目印でショップUIに差し替える
const panelEntityCache = new Map();    // key -> Entity

function panelKeyOf(dimension, loc) {
    return `${dimension.id}|${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`;
}
function panelCenter(loc) {
    return { x: Math.floor(loc.x) + 0.5, y: Math.floor(loc.y), z: Math.floor(loc.z) + 0.5 };
}

function findPanelEntities(dimension, loc) {
    try {
        return dimension.getEntities({ type: PANEL_UI_ID, location: panelCenter(loc), maxDistance: 0.75 });
    } catch { return []; }
}

function spawnPanelEntity(block) {
    try {
        const e = block.dimension.spawnEntity(PANEL_UI_ID, panelCenter(block.location));
        try { e.nameTag = PANEL_UI_TITLE; } catch {}
        try { e.setDynamicProperty("shopuilook2:home", `${Math.floor(block.location.x)},${Math.floor(block.location.y)},${Math.floor(block.location.z)}`); } catch {}
        panelEntityCache.set(panelKeyOf(block.dimension, block.location), e);
        return e;
    } catch { return undefined; }
}

function getPanelEntity(block, create = true) {
    if (!block || block.typeId !== PANEL_ID) return undefined;
    const key = panelKeyOf(block.dimension, block.location);
    const cached = panelEntityCache.get(key);
    if (cached) {
        try { if (cached.isValid) return cached; } catch {}
        panelEntityCache.delete(key);
    }
    const found = findPanelEntities(block.dimension, block.location);
    if (found.length > 0) {
        for (let i = 1; i < found.length; i++) { try { found[i].remove(); } catch {} } // 重複は1体に
        panelEntityCache.set(key, found[0]);
        return found[0];
    }
    return create ? spawnPanelEntity(block) : undefined;
}

// 画面を閉じさせるためにモブだけを作り直す（ブロックと設定には触らない）
function respawnPanelEntity(block) {
    const key = panelKeyOf(block.dimension, block.location);
    for (const e of findPanelEntities(block.dimension, block.location)) { try { e.remove(); } catch {} }
    panelEntityCache.delete(key);
    return spawnPanelEntity(block);
}

function panelBlockOf(entity) {
    try { return entity.dimension.getBlock(entity.location); } catch { return undefined; }
}

// モブが持っている本物のアイテム（プローブ・表示用の複製以外）をその場に落とす
function dropPanelRealItems(entity) {
    try {
        const c = entity.getComponent("minecraft:inventory")?.container;
        if (!c) return;
        const at = { x: Math.floor(entity.location.x) + 0.5, y: Math.floor(entity.location.y) + 0.5, z: Math.floor(entity.location.z) + 0.5 };
        for (let i = 0; i < c.size; i++) {
            const item = c.getItem(i);
            if (!item || isProbe(item) || isDisplayClone(item)) continue;
            c.setItem(i, undefined);
            try { entity.dimension.spawnItem(item, at); } catch {}
        }
    } catch {}
}

function getContainer(block) {
    try {
        return getPanelEntity(block, true)?.getComponent("minecraft:inventory")?.container;
    } catch {
        return undefined;
    }
}

function getProps(block) {
    try {
        return block.getComponent("minecraft:dynamic_properties");
    } catch {
        return undefined;
    }
}

function sameBlock(rec, block) {
    return (
        rec
        && rec.dimensionId === block.dimension.id
        && rec.x === block.location.x
        && rec.y === block.location.y
        && rec.z === block.location.z
    );
}

function getDraftRecord(block) {
    for (const rec of active.values()) {
        if (sameBlock(rec, block)) return rec;
    }
    return undefined;
}

function getPersistedNumberProp(block, name, fallback = 0) {
    try {
        const props = getProps(block);
        if (!props) return fallback;
        const raw = props.get(name);
        if (typeof raw === "number" && Number.isFinite(raw)) {
            return Math.trunc(raw);
        }
    } catch {}
    return fallback;
}

function setPersistedNumberProp(block, name, value) {
    try {
        const props = getProps(block);
        if (!props) return false;
        props.set(name, Math.trunc(value));
        return true;
    } catch {
        return false;
    }
}

function getNumberProp(block, name, fallback = 0) {
    const rec = getDraftRecord(block);
    if (rec?.draftProps?.has(name)) {
        return rec.draftProps.get(name);
    }
    return getPersistedNumberProp(block, name, fallback);
}

function setNumberProp(block, name, value) {
    const n = Math.trunc(value);
    const rec = getDraftRecord(block);

    // 変更は即時に確定する（保存ボタン＝閉じるだけ）。
    // キャンセル時は、開いたときのスナップショットから復元する。
    void rec;
    return setPersistedNumberProp(block, name, n);
}

function commitDraft(block, rec) {
    for (const [name, value] of rec.draftProps.entries()) {
        setPersistedNumberProp(block, name, value);
    }
    rec.draftProps.clear();
}

// ============================================================
// Probe / signal helpers
// ============================================================

// スロットにプローブを指定個数で置く。すでに同じ状態なら触らない
// （毎回置き直すと、プレイヤーの操作やホバー表示を乱すため）。
function setProbe(container, slot, amount) {
    try {
        const n = Math.max(1, Math.min(64, Math.trunc(amount)));
        const current = container.getItem(slot);

        if (isProbe(current) && current.amount === n) return;
        // NEVER replace a real item with a probe (e.g. a prize placed in a
        // slot that is a control slot in the normal screen).
        if (current && !isProbe(current)) return;

        // Keep the current A/B type and the display name while the
        // count (UI state) changes.
        const probe = new ItemStack(PROBE_ID, n);
        if (isProbe(current) && typeof current.nameTag === "string") {
            probe.nameTag = current.nameTag;
        }

        container.setItem(slot, probe);
    } catch {}
}

// スロットが「プローブが指定個数だけ入っている」状態のままか。
// 拾われたり個数が変わったりしていれば false（＝操作された合図）。
function signalIntact(container, slot, amount) {
    try {
        const item = container.getItem(slot);
        return isProbe(item) && item.amount === amount;
    } catch {
        return false;
    }
}

// 拾われたプローブをカーソルとインベントリから消す。
function clearProbeFromPlayer(player) {
    try {
        const cursor = player.getComponent("minecraft:cursor_inventory");
        if (isProbe(cursor?.item) || isDisplayClone(cursor?.item)) cursor.clear();
    } catch {}
    try {
        const inv = player.getComponent("minecraft:inventory")?.container;
        if (!inv) return;
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (isProbe(it) || isDisplayClone(it)) inv.setItem(i, undefined);
        }
    } catch {}
}

// ドロップダウンの選択肢スロット（27〜31）をシグナル待ちにする。
function armSharedChoices(container) {
    for (const slot of SHARED_CHOICE_SLOTS) setProbe(container, slot, 1);
}

// ============================================================
// Dropdown helpers
// UI 側の読み方：
//   開いている   → 個数 2（OPEN_AMOUNT）
//   閉じている   → 個数 3 + 選択番号（3〜7）
// ============================================================

function clampChoice(def, choice) {
    const n = Math.trunc(Number(choice) || 0);
    return Math.max(0, Math.min(def.count - 1, n));
}

function getDropdownChoice(block, def) {
    return clampChoice(def, getNumberProp(block, def.prop, 0));
}

function saveDropdownChoice(block, def, choice) {
    return setNumberProp(block, def.prop, clampChoice(def, choice));
}

function getChoiceById(block, id) {
    const def = DROPDOWN_BY_ID.get(id);
    return def ? getDropdownChoice(block, def) : 0;
}

function dropdownAmount(def, open, choice) {
    return open ? OPEN_AMOUNT : CLOSED_BASE_AMOUNT + clampChoice(def, choice);
}

function writeDropdownState(container, def, open, choice) {
    setProbe(container, def.slot, dropdownAmount(def, open, choice));
}

function dropdownStateIntact(container, def, open, choice) {
    return signalIntact(container, def.slot, dropdownAmount(def, open, choice));
}

function closeDropdown(container, block, rec, id) {
    const def = DROPDOWN_BY_ID.get(id);
    if (def) {
        writeDropdownState(container, def, false, getDropdownChoice(block, def));
    }
    if (rec.openDropdown === id) rec.openDropdown = null;
    armSharedChoices(container);
}

function closeAnyDropdown(container, block, rec) {
    if (rec.openDropdown) {
        closeDropdown(container, block, rec, rec.openDropdown);
    }
}

// ============================================================
// Weekday mask property
// 特売（商品タイプ=1）と日替わり（商品タイプ=3）で別々の曜日を持つ。
// ============================================================
function weekdayProperty(block) {
    return getChoiceById(block, "product_type") === 3
        ? "shop_daily_weekday_mask"
        : "shop_discount_weekday_mask";
}

function getWeekdayMask(block) {
    const n = getNumberProp(block, weekdayProperty(block), 0);
    return Math.max(0, Math.min(127, n));
}

function saveWeekdayMask(block, mask) {
    const value = Math.max(0, Math.min(127, Math.trunc(mask)));
    return setNumberProp(block, weekdayProperty(block), value);
}

function weekdayBit(mask, weekdayValue) {
    return Math.floor(mask / weekdayValue) % 2;
}

function writeWeekdayRestoreSnapshot(container, mask) {
    const value = Math.max(0, Math.min(127, Math.trunc(mask)));

    // Never use amount 1 for restore-state slots.
    const monTueWed =
        2
        + weekdayBit(value, 1)
        + weekdayBit(value, 2) * 2
        + weekdayBit(value, 4) * 4;

    const thuFriSatSun =
        2
        + weekdayBit(value, 8)
        + weekdayBit(value, 16) * 2
        + weekdayBit(value, 32) * 4
        + weekdayBit(value, 64) * 8;

    setProbe(container, WEEKDAY_RESTORE_SLOTS[0], monTueWed);
    setProbe(container, WEEKDAY_RESTORE_SLOTS[1], thuFriSatSun);
}

function armWeekdaySignals(container) {
    for (const slot of WEEKDAY_SHARED_SLOTS) setProbe(container, slot, 1);
}

function writeWeekdayState(container, open) {
    setProbe(
        container,
        WEEKDAY_STATE_SLOT,
        open ? WEEKDAY_OPEN_AMOUNT : WEEKDAY_CLOSED_AMOUNT
    );
}

function weekdayStateIntact(container, open) {
    return signalIntact(
        container,
        WEEKDAY_STATE_SLOT,
        open ? WEEKDAY_OPEN_AMOUNT : WEEKDAY_CLOSED_AMOUNT
    );
}

function getToggle(block, def) {
    return getNumberProp(block, def.prop, 0) === 1;
}

function writeToggle(container, def, enabled) {
    // Never use amount 1 for persisted toggle display state.
    setProbe(container, def.slot, enabled ? 3 : 2);
}

function getItemRowCount(block, action) {
    const raw = getNumberProp(block, action.prop, 1);
    return Math.max(1, Math.min(MAX_ITEM_ROWS, raw));
}

function getActiveSaleAction(block) {
    const saleType = getChoiceById(block, "sale_type");

    for (const action of ACTIONS) {
        if (action.saleChoice === saleType) {
            return action;
        }
    }

    return undefined;
}

function writeItemRowState(container, block, action) {
    // Shared state slot because multi/random are mutually exclusive.
    const count = action ? getItemRowCount(block, action) : 1;
    setProbe(container, ROW_STATE_SLOT, count + 1);
}

function armActionSignals(container) {
    // Multi/random share these because only one branch is visible at once.
    setProbe(container, ADD_SIGNAL_SLOT, 1);
    setProbe(container, REMOVE_SIGNAL_SLOT, 1);
}

function armActions(container, block) {
    // v22: no multi/random count rows any more. Slot49 = buyer-message
    // click signal (armed with the text signals), slot51 = おまけ dropdown.
    // +2: a stack of 1 shows NO count in the UI, so 1 cannot be read.
    setProbe(container, SALE_LAYOUT_SLOT, getChoiceById(block, "sale_type") + 2);
}

function getPaymentItemRowCount(block) {
    const raw = getNumberProp(block, PROP_PAYMENT_ITEM_ROWS, 1);
    return Math.max(1, Math.min(MAX_ITEM_ROWS, raw));
}

function paymentUsesItems(block) {
    return getChoiceById(block, "payment_method") === 2;
}

function paymentUsesPoints(block) {
    return getChoiceById(block, "payment_method") === 3;
}

function isDropdownRuntimeActive(block, def) {
    // slot39 is shared by mutually-exclusive time-type dropdowns.
    if (def.id === "discount_time_type") {
        return (
            getChoiceById(block, "product_type") === 1
            && getChoiceById(block, "discount_condition") === 2
        );
    }

    if (def.id === "daily_time_type") {
        return getChoiceById(block, "product_type") === 3;
    }

    // slot43 is shared:
    // - payment_point_type dropdown when payment method = points
    // - payment required-item row count when payment method = item
    if (def.id === "payment_point_type") {
        return paymentUsesPoints(block);
    }

    if (def.id === "bonus_mode") {
        return getChoiceById(block, "sale_type") !== 2;
    }

    return true;
}

function syncSharedTimeTypeState(container, block) {
    const special = DROPDOWN_BY_ID.get("discount_time_type");
    const daily = DROPDOWN_BY_ID.get("daily_time_type");

    if (special && isDropdownRuntimeActive(block, special)) {
        writeDropdownState(
            container,
            special,
            false,
            getDropdownChoice(block, special)
        );
        return;
    }

    if (daily && isDropdownRuntimeActive(block, daily)) {
        writeDropdownState(
            container,
            daily,
            false,
            getDropdownChoice(block, daily)
        );
        return;
    }

    // Keep the shared slot armed with a harmless closed state.
    setProbe(container, 39, CLOSED_BASE_AMOUNT);
}

function syncPaymentItemControls(container, block) {
    setProbe(container, PAYMENT_ITEM_ADD_SIGNAL_SLOT, 1);
    setProbe(container, PAYMENT_ITEM_REMOVE_SIGNAL_SLOT, 1);

    if (paymentUsesItems(block)) {
        setProbe(
            container,
            PAYMENT_ITEM_ROW_STATE_SLOT,
            getPaymentItemRowCount(block) + 1
        );
        return;
    }

    // Restore slot43 to the payment-point dropdown state whenever the
    // item-payment editor is not active.
    const pointDef = DROPDOWN_BY_ID.get("payment_point_type");
    if (pointDef) {
        writeDropdownState(
            container,
            pointDef,
            false,
            getDropdownChoice(block, pointDef)
        );
    }
}

// ============================================================
// キャンセル用：開いた時点の設定を丸ごと覚えておき、戻す
// ============================================================
function allSettingProps(block) {
    const names = new Set();
    for (const def of DROPDOWNS) names.add(def.prop);
    for (const def of TOGGLES) names.add(def.prop);
    for (const action of ACTIONS) names.add(action.prop);
    names.add(PROP_PAYMENT_ITEM_ROWS);
    names.add("shop_discount_weekday_mask");
    names.add("shop_daily_weekday_mask");
    names.add(DAILY_SUPPLY_PROP);
    names.add(LAYOUT_MIGRATION_PROP); // survive forceCloseScreen() re-seat
    names.add(KUJI_PROP);
    names.add(KUJI_EDITING_PROP);
    names.add(BLOCK_STORE_PROP); // store membership survives re-seat
    names.add(BLOCK_DEPT_PROP);
    for (const t of KUJI_TOGGLES) names.add(t.prop);

    // Preserve all text values across Cancel and forceCloseScreen().
    for (const name of TEXT_FIELD_NAMES) names.add(name);

    // v53: store-level product records (only when a block is given)
    names.add(PRODUCT_INDEX_PROP);
    names.add(PRODUCT_NEXT_PROP);
    names.add(CURRENT_PRODUCT_PROP);
    if (block) for (const id of loadProductIndex(block)) names.add(productKey(id));

    return [...names];
}

function takeSnapshot(block) {
    const snapshot = new Map();
    const props = getProps(block);
    for (const name of allSettingProps(block)) {
        let value;
        try { value = props?.get(name); } catch {}
        snapshot.set(name, value);
    }
    return snapshot;
}

function restoreSnapshot(block, snapshot) {
    const props = getProps(block);
    if (!props || !snapshot) return;
    for (const [name, value] of snapshot.entries()) {
        try { props.set(name, value); } catch {} // undefined なら削除（未設定に戻る）
    }
}

// ============================================================
// 画面を強制的に閉じる：ブロックを置き直す
// ダメージ・距離では閉じなかったため、ブロックを一度消して同じ状態で
// 置き直す。ブロックが消えると、紐づいたコンテナ画面は閉じる。
//   1. 中身・設定・ブロックの状態を控える
//   2. 中身を空にしてから消す（消したときのドロップで増えないように）
//   3. 同じ状態で置き直し、中身と設定を書き戻す
//      失敗したら数tick 再挑戦 → それでもダメならその場にドロップ
// ============================================================
const RESEAT_RETRY_TICKS = 40; // block entity may need a few ticks after re-placing

function captureBlock(block) {
    const container = getContainer(block);
    if (!container) return undefined;

    const items = [];
    for (let i = 0; i < container.size; i++) {
        items.push(container.getItem(i)); // getItem はコピーを返す
    }

    const props = new Map();
    const dp = getProps(block);
    for (const name of allSettingProps(block)) {
        let value;
        try { value = dp?.get(name); } catch {}
        props.set(name, value);
    }

    return {
        dimension: block.dimension,
        location: { ...block.location },
        permutation: block.permutation,
        items,
        props
    };
}

// Writes the saved items and settings into the re-placed block.
// Every item / property is written on its own: one failure must never
// abort the rest (that used to leave props unrestored -> sale type reset,
// and then the fallback dropped items that were already written back ->
// duplicated items).
function writeBack(block, saved) {
    const container = getContainer(block);
    if (!container || container.size < saved.items.length) {
        return { items: false, props: false, failed: [] };
    }

    for (let i = 0; i < saved.items.length; i++) {
        try { container.setItem(i, saved.items[i]); } catch {}
    }
    saved.itemsWritten = true;

    const dp = getProps(block);
    if (!dp) return { items: true, props: false, failed: [] };

    const failed = [];
    for (const [name, value] of saved.props.entries()) {
        // Unset values: the re-placed block is empty already, and
        // "removing" a property that does not exist throws
        // ("Failed to remove metadata value: property was not found").
        if (value === undefined) continue;
        try { dp.set(name, value); } catch (e) { failed.push(`${name}(${String(e)})`); }
    }
    return { items: true, props: true, failed };
}

function dropSavedItems(saved) {
    const at = {
        x: saved.location.x + 0.5,
        y: saved.location.y + 1,
        z: saved.location.z + 0.5
    };
    for (const item of saved.items) {
        if (!item || isProbe(item)) continue;
        try { saved.dimension.spawnItem(item, at); } catch {}
    }
}

function restoreReseated(saved, attempt) {
    let result = { items: false, props: false, failed: [] };
    try {
        const block = saved.dimension.getBlock(saved.location);
        if (block?.typeId === PANEL_ID) result = writeBack(block, saved);
    } catch {}

    if (result.items && result.props) {
        finishReseat(saved, result.failed);
        return;
    }

    if (attempt < RESEAT_RETRY_TICKS) {
        system.runTimeout(() => restoreReseated(saved, attempt + 1), 1);
        return;
    }

    // Last resort: only drop items that were NEVER written back.
    if (!saved.itemsWritten) dropSavedItems(saved);
    finishReseat(saved, ["(設定を書き戻せませんでした)"]);
}

function finishReseat(saved, failed) {
    if (saved.finished) return;
    saved.finished = true;
    if (failed.length > 0) {
        const player = saved.playerId ? findPlayer(saved.playerId) : undefined;
        tell(player, `§c[ショップ] 設定の書き戻しに失敗: ${failed.join(", ")}`);
    }
    if (saved.onRestored) system.run(saved.onRestored);
}

// onRestored runs once the re-placed block has its items AND settings
// back, so forms never read a half-restored block.
function forceCloseScreen(player, block, onRestored) {
    const closeContainer = getContainer(block);
    setTextGate(closeContainer, false);
    if (closeContainer) {
        setProbe(closeContainer, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE);
    }

    const saved = captureBlock(block);
    if (!saved) return false;
    saved.playerId = player?.id;
    saved.onRestored = onRestored;

    const container = getContainer(block);
    try {
        container.clearAll();
    } catch {
        return false;
    }

    try {
        // モブを作り直すと画面が閉じる。ブロック（設定）はそのまま。
        if (!respawnPanelEntity(block)) throw new Error("respawn failed");
    } catch {
        // 置き直しに失敗 → 空にした中身をその場で戻す
        try {
            const current = saved.dimension.getBlock(saved.location);
            if (current?.typeId === PANEL_ID) {
                writeBack(current, saved);
            } else {
                current?.setPermutation(saved.permutation);
                restoreReseated(saved, 0);
            }
        } catch {
            dropSavedItems(saved);
        }
        return false;
    }

    restoreReseated(saved, 0);
    return true;
}

function makeRecord(player, block, container) {
    return {
        dimensionId: block.dimension.id,
        x: block.location.x,
        y: block.location.y,
        z: block.location.z,
        openDropdown: null,
        weekdayOpen: false,
        weekdaySeedDueTick: -1,
        draftProps: new Map(),
        snapshot: takeSnapshot(block)
    };
}

function resolve(rec) {
    try {
        return world.getDimension(rec.dimensionId).getBlock({
            x: rec.x,
            y: rec.y,
            z: rec.z
        });
    } catch {
        return undefined;
    }
}

function arm(player, block, startPage = "landing") {
    const container = getContainer(block);
    if (!container) {
        if (DEBUG_TEXT) tell(player, `§d[DBG 開く] コンテナが取得できない（block=${block?.typeId}）`);
        return;
    }
    if (container.size <= MAX_USED_SLOT) {
        tell(player, "§c[ショップ] 旧バージョンで設置されたブロックです。一度壊して置き直してください");
        return;
    }

    // Reopening without Save/Cancel discards the previous draft only.
    // Never snapshot or restore player/block inventories.
    const previous = active.get(player.id);
    if (previous) {
        active.delete(player.id);
    }

    // One-time migration to the v22 layout: slots 17..25 used to be the
    // おまけ grid; they are 見本/おまけ now. Return old contents once.
    // Done BEFORE the Cancel snapshot so Cancel cannot undo the flag.
    if (getPersistedNumberProp(block, LAYOUT_MIGRATION_PROP, 0) !== 1) {
        const moved = returnSlotItems(player, container, [...SAMPLE_SLOTS_ALL, ...BONUS_SLOTS]);
        setPersistedNumberProp(block, LAYOUT_MIGRATION_PROP, 1);
        if (moved > 0) {
            tell(player, `§e[ショップ] 商品欄の配置が変わったため、見本・おまけ欄のアイテム${moved}個を返しました`);
        }
    }

    clearGroupNameSlots(container);   // 前回の一覧ページの文字用プローブを残さない
    const rec = makeRecord(player, block, container);
    active.set(player.id, rec);

    if (getPersistedNumberProp(block, KUJI_EDITING_PROP, 0) === 1) {
        clearProbeFromPlayer(player);
        armKujiEdit(player, rec, block, container);
        return;
    }

    // Store settings is the first screen. The store-page Back button can
    // explicitly request the product list instead.
    ensureStoreAndProducts(player, block, container);
    if (!getCurrentProduct(block)) {
        clearProbeFromPlayer(player);
        if (startPage === "landing") armLanding(player, rec, block, container);
        else enterStoreMode(player, rec, block, container);
        return;
    }

    clearProbeFromPlayer(player);

    armSharedChoices(container);
    setProbe(container, PRODUCT_DELETE_SIGNAL_SLOT, 1);
    setProbe(container, PRODUCT_DELETE_NO_SLOT, 1);
    setProbe(container, PRODUCT_DELETE_STATE_SLOT, 1);

    for (const def of DROPDOWNS) {
        if (
            def.id === "discount_time_type"
            || def.id === "daily_time_type"
        ) {
            continue;
        }

        writeDropdownState(
            container,
            def,
            false,
            getDropdownChoice(block, def)
        );
    }

    syncSharedTimeTypeState(container, block);

    writeWeekdayState(container, false);
    writeWeekdayRestoreSnapshot(container, getWeekdayMask(block));

    for (const def of TOGGLES) {
        writeToggle(container, def, getToggle(block, def));
    }

    armActions(container, block);
    syncPaymentItemControls(container, block);

    setProbe(container, FOOTER_CANCEL_SLOT, 1);

    // Dedicated text-input click signals (9..15) + outside pencil (40).
    // The Save button shares slot40 visually but does not move the item.
    armTextInputSignals(container, block, player);

    refreshTextDisplayPayloads(block, container);


    // Labels are hidden (gate=1, set by armTextInputSignals). Show them
    // only after the names are written AND the client re-read them.
    scheduleTextGateOpen(player, rec);
}

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    try {
        if (event.block.typeId !== PANEL_ID) return;
        // 通常は手前のモブに当たるので、ブロックに届くのはモブが居ない時だけ。
        event.cancel = true;
        if (event.isFirstEvent === false) return;
        const dimension = event.block.dimension;
        const location = { ...event.block.location };
        const playerId = event.player?.id;
        system.run(() => {
            try {
                const b = dimension.getBlock(location);
                if (b?.typeId === PANEL_ID && getPanelEntity(b, true)) {
                    tell(findPlayer(playerId), "§7[ショップ] 準備できました。もう一度押してください");
                }
            } catch {}
        });
    } catch {}
});

// ショップを開く：ブロックに重なったモブを押した時
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    try {
        const target = event.target;
        if (target?.typeId !== PANEL_UI_ID) return;
        const player = event.player;
        if (!player) return;
        let block;
        try { block = target.dimension.getBlock(target.location); } catch {}
        if (!block || block.typeId !== PANEL_ID) { event.cancel = true; return; }
        openShopFromInteraction(event, player, block);
    } catch {}
});

function openShopFromInteraction(event, player, eventBlock) {
    try {
        const blk = eventBlock;

        // Keep only plain data from the before-event; re-fetch the block
        // later (the Block object may be stale after a re-seat).
        const dimension = blk.dimension;
        const location = { ...blk.location };
        const playerId = player.id;


        // Product of a store: only its managers may open the settings.
        if (!canEditBlock(player, blk)) {
            event.cancel = true;
            const store = blockStore(blk);
            system.run(() => tell(findPlayer(playerId),
                `§e[${store?.name ?? "ショップ"}] 購入画面は準備中です（次の段階で作ります）`));
            return;
        }

        if (DEBUG_TEXT) {
            system.run(() => tell(findPlayer(playerId), "§d[DBG 開く] ショップを開く操作を受信"));
        }

        system.run(() => {
            const p = findPlayer(playerId);
            let block;
            try {
                block = dimension.getBlock(location);
            } catch (e) {
                if (DEBUG_TEXT) tell(p, `§d[DBG 開く] ブロック取得エラー: ${String(e)}`);
                return;
            }

            try {
                arm(p, block);
                if (DEBUG_TEXT) {
                    tell(p, `§d[DBG 開く] 準備完了 active=${active.has(playerId)}`);
                }
            } catch (e) {
                if (DEBUG_TEXT) tell(p, `§d[DBG 開く] 準備中にエラー: ${String(e)}`);
            }

            // One extra restore after the opening transaction settles.
            system.run(() => {
                try {
                    const b = dimension.getBlock(location);
                    const container = getContainer(b);
                    if (!container || container.size <= MAX_USED_SLOT) return;
                    // 35/36 are prize slots while editing くじ / store options.
                    if (getPersistedNumberProp(b, KUJI_EDITING_PROP, 0) === 1) return;
                    if (active.get(playerId)?.storeMode || active.get(playerId)?.landing) return;
                    writeWeekdayRestoreSnapshot(container, getWeekdayMask(b));
                } catch {}
            });

            // Diagnostics that do NOT depend on the session surviving.
            if (DEBUG_TEXT) {
                system.runTimeout(() => {
                    try {
                        const b = dimension.getBlock(location);
                        debugTextSlots(
                            findPlayer(playerId),
                            b,
                            `開いて10tick後 active=${active.has(playerId)}`
                        );
                    } catch (e) {
                        tell(findPlayer(playerId), `§d[DBG 10tick後] エラー: ${String(e)}`);
                    }
                }, 10);
            }
        });
    } catch {}
}

// Text-input / pencil clicks are detected ONLY in the tick loop below.
// (The old playerInventoryItemChange path raced against the tick loop,
//  which is why a text click sometimes opened a dropdown instead.)

// ============================================================
// Drop cleanup
// Do not touch blocks, inventories, or held items.
// Only remove matching stacks after they exist as item entities.
// ============================================================
world.afterEvents.entitySpawn.subscribe((event) => {
    try {
        const entity = event.entity;
        if (!entity || entity.typeId !== "minecraft:item") return;

        const itemComponent = entity.getComponent("minecraft:item");
        const stack = itemComponent?.itemStack;
        if (!stack) return;

        if (
            stack.typeId === PANEL_ID
            || isProbe(stack)
        ) {
            entity.remove();
        }
    } catch {}
});

world.afterEvents.blockContainerClosed.subscribe((event) => {
    try {
        if (event.block.typeId !== PANEL_ID) return;
        handleShopClosed(event.closeSource?.entity, event.block);
    } catch {}
});

// モブ（panel_ui）の画面を閉じた時：ブロックの時と同じ確定処理
world.afterEvents.entityContainerClosed.subscribe((event) => {
    try {
        const entity = event.entity;
        if (entity?.typeId !== PANEL_UI_ID) return;
        const source = event.closeSource?.entity ?? event.player;
        const block = panelBlockOf(entity);
        if (!block || block.typeId !== PANEL_ID) return;
        handleShopClosed(source, block);
    } catch {}
});

function handleShopClosed(source, closedBlock) {
    const event = { block: closedBlock };
    try {
        if (!source || source.typeId !== "minecraft:player") return;

        const rec = active.get(source.id);
        if (DEBUG_TEXT) {
            tell(source, `§d[DBG 閉じる] active=${!!rec}${rec ? "（保存として確定）" : ""}`);
        }
        // Always clean the player's hands/inventory on close, also when no
        // session is active (e.g. the screen closed for a form): the game
        // may put a held probe back into the inventory a moment later.
        clearProbeFromPlayer(source);
        {
            const sourceId = source.id;
            for (const delay of [2, 10]) {
                system.runTimeout(() => clearProbeFromPlayer(findPlayer(sourceId)), delay);
            }
        }
        if (!rec) return;

        // A normal close while the active shop session still exists is the
        // final confirmation path. Form-opening and Cancel both remove
        // the active record before they force-close, so they never enter here.
        if (sameBlock(rec, event.block)) {
            if (rec.priceMode) {
                clearPriceSlots(getContainer(event.block));
                rec.priceMode = undefined;
            }
            if (rec.storeMode) {
                rec.storeMode = false;
                storeModeBlocks.delete(blockKey(event.block));
            }
            if (rec.kujiEditing) {
                exitKujiEdit(source, rec, event.block, getContainer(event.block), true, false);
            }
            commitTextDraft(event.block);
            const closeContainer = getContainer(event.block);
            setTextGate(closeContainer, false);

            // Persist a neutral hidden layout before the container screen closes.
            // This prevents the client from rendering the previous product layout
            // for one frame the next time the shop is opened.
            if (closeContainer) {
                setProbe(closeContainer, SALE_LAYOUT_SLOT, TRANSITION_HIDDEN_MODE);
            }

            active.delete(source.id);
            clearProbeFromPlayer(source);

            // A probe held on the cursor is put back into the inventory
            // by the game AFTER the screen closes: clear again.
            const sourceId = source.id;
            for (const delay of [2, 10]) {
                system.runTimeout(() => clearProbeFromPlayer(findPlayer(sourceId)), delay);
            }
        }
    } catch {}
}

// Safety sweep: a player who is NOT in a shop session must never keep a
// hidden probe (e.g. one left over from a closed screen or an older version).
system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        if (active.has(player.id)) continue;
        clearProbeFromPlayer(player);
    }
}, 20);

// Returns true when something was handled this tick.
function tickSession(player, rec, block, container) {
    // Keep a touch probe inserted THIS tick until the next one.
    if (lastTouchTick.get(player.id) !== system.currentTick) {
        clearProbeFromPlayer(player);
    }

    if (rec.pendingVisual) {
        if (system.currentTick >= rec.pendingVisual.due) {
            const apply = rec.pendingVisual.apply;
            rec.pendingVisual = null;
            apply(block, container);
        }
        return true;
    }

    if (rec.kujiEditing) return tickKujiEdit(player, rec, block, container);
    if (rec.storeMode) return tickStoreMode(player, rec, block, container);
    if (rec.priceMode) return tickPriceMode(player, rec, block, container);
    if (rec.landing) return tickLanding(player, rec, block, container);

    // ========================================================
    // In-screen delete confirmation
    // ========================================================
    if (rec.deleteConfirm) {
        if (!signalIntact(container, PRODUCT_DELETE_SIGNAL_SLOT, 1)) {
            clearProbeFromPlayer(player);
            confirmProductDelete(player, rec, block, container);
            return true;
        }
        if (!signalIntact(container, PRODUCT_DELETE_NO_SLOT, 1)) {
            clearProbeFromPlayer(player);
            cancelProductDeleteConfirm(player, rec, block, container);
            return true;
        }
        return true;
    }

    // ========================================================
    // Save / Cancel footer
    // Always resolve these BEFORE the trash signal. Screen refreshes can make
    // slot50 transiently disappear, but a real Save/Cancel click also removes
    // its own dedicated footer probe, so those actions must win.
    // ========================================================
    if (!signalIntact(container, FOOTER_CANCEL_SLOT, 1)) {
        clearProbeFromPlayer(player);
        cancelProduct(player, rec, block, container);
        return true;
    }

    if (!isProbe(container.getItem(FOOTER_SAVE_SLOT))) {
        clearProbeFromPlayer(player);
        leaveProduct(player, rec, block, container);
        return true;
    }

    // ========================================================
    // Delete button
    // Dedicated slot31: never infer deletion from the product-layout slot50.
    // This makes Save/Cancel completely independent from the trash button.
    // ========================================================
    if (!signalIntact(container, PRODUCT_DELETE_SIGNAL_SLOT, 1)) {
        clearProbeFromPlayer(player);
        beginProductDeleteConfirm(player, rec, block, container);
        return true;
    }

    // ========================================================
    // Text input (dedicated slots 9..15 / 50). The old outside pencil is gone.
    // Checked before every dropdown so nothing can misread it.
    // ========================================================
    const textSignal = findClickedTextSignal(container, block);
    if (textSignal === 2 && getChoiceById(block, "sale_type") === 2) {
        enterKujiEdit(player, rec, block, container);   // edit in-screen
        return true;
    }
    if (textSignal !== null) {
        openTextInput(player, rec, block, container, textSignal);
        return true;
    }

    // ========================================================
    // Weekday multi-select owns 27..33 while open.
    // ========================================================
    if (rec.weekdayOpen) {
        const mask = getWeekdayMask(block);

        if (rec.weekdaySeedDueTick >= 0) {
            if (system.currentTick >= rec.weekdaySeedDueTick) {
                clearProbeFromPlayer(player);
                armWeekdaySignals(container);
                writeWeekdayState(container, true);
                refreshTextDisplaySlots(
                    block,
                    container,
                    [...WEEKDAY_SHARED_SLOTS, WEEKDAY_STATE_SLOT]
                );
                rec.weekdaySeedDueTick = -1;
            }
            return true;
        }

        let clickedDay = -1;
        for (let i = 0; i < WEEKDAY_SHARED_SLOTS.length; i++) {
            if (!signalIntact(container, WEEKDAY_SHARED_SLOTS[i], 1)) {
                clickedDay = i;
                break;
            }
        }

        if (clickedDay >= 0) {
            clearProbeFromPlayer(player);
            saveWeekdayMask(block, mask ^ (1 << clickedDay));
            armWeekdaySignals(container);
            writeWeekdayState(container, true);
            refreshTextDisplaySlots(
                block,
                container,
                [...WEEKDAY_SHARED_SLOTS, WEEKDAY_STATE_SLOT]
            );
            return true;
        }

        if (!weekdayStateIntact(container, true)) {
            clearProbeFromPlayer(player);
            rec.weekdayOpen = false;
            rec.weekdaySeedDueTick = -1;
            writeWeekdayState(container, false);

            armSharedChoices(container);
            setProbe(container, 31, 1);
            setProbe(container, 32, 1);
            setProbe(container, 33, 1);

            refreshTextDisplaySlots(
                block,
                container,
                [27, 28, 29, 30, 31, 32, 33, WEEKDAY_STATE_SLOT]
            );
            return true;
        }

        return true;
    }

    // Weekday header clicked while closed.
    if (!weekdayStateIntact(container, false)) {
        clearProbeFromPlayer(player);
        closeAnyDropdown(container, block, rec);

        // Snapshot is context-sensitive: 特売/日替 use separate masks.
        writeWeekdayRestoreSnapshot(container, getWeekdayMask(block));
        rec.weekdayOpen = true;
        armWeekdaySignals(container);
        writeWeekdayState(container, true);

        refreshTextDisplaySlots(
            block,
            container,
            [
                ...WEEKDAY_SHARED_SLOTS,
                WEEKDAY_STATE_SLOT,
                ...WEEKDAY_RESTORE_SLOTS
            ]
        );

        rec.weekdaySeedDueTick = system.currentTick + 2;
        return true;
    }

    // ========================================================
    // Active normal dropdown: shared choices 27..31.
    // ========================================================
    if (rec.openDropdown) {
        let consumedChoice = -1;
        for (let i = 0; i < SHARED_CHOICE_SLOTS.length; i++) {
            if (!signalIntact(container, SHARED_CHOICE_SLOTS[i], 1)) {
                consumedChoice = i;
                break;
            }
        }

        if (consumedChoice >= 0) {
            clearProbeFromPlayer(player);

            const def = DROPDOWN_BY_ID.get(rec.openDropdown);
            const validChoice =
                def && consumedChoice < def.count;

            // Save the new logical value first. The UI still shows the old
            // branch until its dropdown state stack-count is changed below.
            if (validChoice) {
                const previousSaleType = getChoiceById(block, "sale_type");
                saveDropdownChoice(block, def, consumedChoice);

                // Items in slots whose ROLE changes go back to the player
                // (e.g. 単数 おまけ 18..21 would become 複数 見本).
                if (def.id === "sale_type" && previousSaleType !== consumedChoice) {
                    const moved = returnSlotItems(
                        player, container, slotsWithChangedRole(previousSaleType, consumedChoice)
                    );
                    if (moved > 0) {
                        tell(player, `§e[ショップ] 使わなくなった枠のアイテム${moved}個を返しました`);
                    }
                }
            }

            // The clicked option can leave one of 27..31 empty.
            // Restore those stacks before preparing any text payload.
            armSharedChoices(container);
            refreshTextDisplaySlots(
                block,
                container,
                SHARED_CHOICE_SLOTS
            );

            // The property is already the NEW value, but the UI is still on
            // the OLD branch. Prepare "未入力" / entered text now.
            if (validChoice) {
                const textGroup = textGroupForDropdownId(def.id);
                if (textGroup >= 0) {
                    refreshTextDisplayGroup(
                        block,
                        container,
                        textGroup
                    );
                }
            }

            // Names are ready but the branch is still the OLD one. Let the
            // client re-read them, THEN flip visibility (2 ticks later).
            deferVisualCommit(player, rec, (block, container) => {
                // Visibility switch happens only AFTER the next branch's text
                // payload is ready.
                if (validChoice) {
                    writeDropdownState(
                        container,
                        def,
                        false,
                        consumedChoice
                    );
                } else if (def) {
                    writeDropdownState(
                        container,
                        def,
                        false,
                        getDropdownChoice(block, def)
                    );
                }

                rec.openDropdown = null;

                // These can switch secondary UI states. setProbe() preserves the
                // nameTag we prepared above.
                armActions(container, block);
                syncPaymentItemControls(container, block);
                syncSharedTimeTypeState(container, block);
                writeWeekdayRestoreSnapshot(
                    container,
                    getWeekdayMask(block)
                );

                if (def) {
                    refreshTextDisplaySlot(
                        block,
                        container,
                        def.slot
                    );
                }

                // Rows/secondary states may have changed: re-read again.
                touchPlayerInventory(player);
            });

            return true;
        }
    }

    // ========================================================
    // Header/outside signals for all normal dropdowns.
    // ========================================================
    let disturbedDropdown = null;

    for (const def of DROPDOWNS) {
        if (!isDropdownRuntimeActive(block, def)) {
            continue;
        }

        const choice = getDropdownChoice(block, def);
        const shouldBeOpen = rec.openDropdown === def.id;

        if (!dropdownStateIntact(container, def, shouldBeOpen, choice)) {
            disturbedDropdown = def;
            break;
        }
    }

    if (disturbedDropdown) {
        clearProbeFromPlayer(player);

        if (rec.openDropdown === disturbedDropdown.id) {
            closeDropdown(
                container,
                block,
                rec,
                disturbedDropdown.id
            );
        } else {
            closeAnyDropdown(container, block, rec);

            rec.weekdayOpen = false;
            rec.weekdaySeedDueTick = -1;
            writeWeekdayState(container, false);

            armSharedChoices(container);
            rec.openDropdown = disturbedDropdown.id;
            writeDropdownState(
                container,
                disturbedDropdown,
                true,
                getDropdownChoice(block, disturbedDropdown)
            );
        }

        refreshTextDisplaySlot(
            block,
            container,
            disturbedDropdown.slot
        );

        return true;
    }

    // ========================================================
    // 日配商品専用設定
    // choice 4 のときだけ slot31 は「日配商品設定」ボタンになる。
    // 商品タイプのドロップダウンが開いている間は同じ slot31 が5番目の選択肢。
    // ========================================================
    if (
        !rec.openDropdown
        && getChoiceById(block, "product_type") === 4
        && !signalIntact(container, DAILY_SUPPLY_ACTION_SLOT, 1)
    ) {
        openDailySupplySettings(player, rec, block, container);
        return true;
    }

    // ========================================================
    // Vanilla toggle fields.
    // ========================================================
    let handledToggle = false;
    for (const def of TOGGLES) {
        const enabled = getToggle(block, def);
        const expected = enabled ? 3 : 2;

        if (!signalIntact(container, def.slot, expected)) {
            clearProbeFromPlayer(player);
            const next = !enabled;
            setNumberProp(block, def.prop, next ? 1 : 0);
            writeToggle(container, def, next);
            refreshTextDisplaySlot(block, container, def.slot);
            handledToggle = true;
            break;
        }
    }
    if (handledToggle) return true;

    // ========================================================
    // 支払い手段 = アイテム : 必要アイテム行 ＋ / -
    // ========================================================
    if (paymentUsesItems(block)) {
        if (!signalIntact(
            container,
            PAYMENT_ITEM_ADD_SIGNAL_SLOT,
            1
        )) {
            clearProbeFromPlayer(player);

            const count = getPaymentItemRowCount(block);
            setNumberProp(
                block,
                PROP_PAYMENT_ITEM_ROWS,
                Math.min(MAX_ITEM_ROWS, count + 1)
            );

            // Restore the clicked +/- now (it may carry a row name), prepare
            // names, let the client re-read, then show/hide the row.
            setProbe(container, PAYMENT_ITEM_ADD_SIGNAL_SLOT, 1);
            setProbe(container, PAYMENT_ITEM_REMOVE_SIGNAL_SLOT, 1);
            refreshTextDisplayGroup(block, container, 3);
            deferVisualCommit(player, rec, (block, container) => {
                syncPaymentItemControls(container, block);
                touchPlayerInventory(player);
            });
            return true;
        }

        if (!signalIntact(
            container,
            PAYMENT_ITEM_REMOVE_SIGNAL_SLOT,
            1
        )) {
            clearProbeFromPlayer(player);

            const count = getPaymentItemRowCount(block);
            setNumberProp(
                block,
                PROP_PAYMENT_ITEM_ROWS,
                Math.max(1, count - 1)
            );

            // Restore the clicked +/- now (it may carry a row name), prepare
            // names, let the client re-read, then show/hide the row.
            setProbe(container, PAYMENT_ITEM_ADD_SIGNAL_SLOT, 1);
            setProbe(container, PAYMENT_ITEM_REMOVE_SIGNAL_SLOT, 1);
            refreshTextDisplayGroup(block, container, 3);
            deferVisualCommit(player, rec, (block, container) => {
                syncPaymentItemControls(container, block);
                touchPlayerInventory(player);
            });
            return true;
        }
    }

    return false;
}

system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        const rec = active.get(player.id);
        if (!rec) continue;

        const block = resolve(rec);
        if (!block || block.typeId !== PANEL_ID) {
            active.delete(player.id);
            continue;
        }

        const container = getContainer(block);
        if (!container || container.size <= MAX_USED_SLOT) continue;

        tickSession(player, rec, block, container);
    }
}, 1);

globalThis.__isActive=()=>active.has("P1");

// ============================================================
// panel_ui（ショップのスロットを持つ見えないモブ）の管理
// ・ブロックを置いたら同じ場所に出す
// ・モブを叩いた（＝ブロックを壊す操作）時だけ、ブロックごと消す
// ・テレポート/押し出しで動いたら元の位置へ戻す、エフェクトは消す
// ・ブロックが無くなっていたらモブも消す（他の消え方はしない）
// ============================================================
world.afterEvents.playerPlaceBlock.subscribe((event) => {
    try {
        if (event.block.typeId !== PANEL_ID) return;
        getPanelEntity(event.block, true);
    } catch {}
});

function destroyShopPanel(entity, player) {
    const block = panelBlockOf(entity);
    // 開いている人のセッションを終わらせる
    if (block) {
        for (const [pid, rec] of active) {
            if (sameBlock(rec, block)) active.delete(pid);
        }
    }
    dropPanelRealItems(entity);
    try { panelEntityCache.delete(panelKeyOf(entity.dimension, entity.location)); } catch {}
    try { entity.remove(); } catch {}
    if (block?.typeId === PANEL_ID) {
        try {
            block.dimension.spawnParticle("minecraft:basic_smoke_particle", {
                x: block.location.x + 0.5, y: block.location.y + 0.5, z: block.location.z + 0.5
            });
        } catch {}
        try { block.setType("minecraft:air"); } catch {}
    }
    if (player) {
        try { player.playSound("dig.wood"); } catch {}
    }
}

// モブが前にあるので、ブロックを壊す操作はモブへの攻撃として届く
world.afterEvents.entityHitEntity.subscribe((event) => {
    try {
        const hit = event.hitEntity;
        if (hit?.typeId !== PANEL_UI_ID) return;
        const player = event.damagingEntity;
        if (player?.typeId !== "minecraft:player") return;
        destroyShopPanel(hit, player);
    } catch {}
});

const PANEL_DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
system.runInterval(() => {
    for (const dimId of PANEL_DIMENSIONS) {
        let list = [];
        try { list = world.getDimension(dimId).getEntities({ type: PANEL_UI_ID }); } catch { continue; }
        const seen = new Set();
        for (const e of list) {
            try {
                if (!e.isValid) continue;
                // 位置ずれ（テレポート・押し出し）を戻す。基準は登録時のブロック位置。
                let home = e.getDynamicProperty("shopuilook2:home");
                if (typeof home !== "string") {
                    home = `${Math.floor(e.location.x)},${Math.floor(e.location.y)},${Math.floor(e.location.z)}`;
                    e.setDynamicProperty("shopuilook2:home", home);
                }
                const [hx, hy, hz] = home.split(",").map(Number);
                const homeLoc = { x: hx, y: hy, z: hz };
                let block;
                try { block = e.dimension.getBlock(homeLoc); } catch {}
                if (!block) continue;                        // チャンク未読み込み：何もしない
                if (block.typeId !== PANEL_ID) {             // ブロックが無い時だけ消える
                    dropPanelRealItems(e);
                    e.remove();
                    continue;
                }
                const key = panelKeyOf(e.dimension, homeLoc);
                if (seen.has(key)) { e.remove(); continue; } // 重複は1体に
                seen.add(key);
                const c = panelCenter(homeLoc);
                if (Math.abs(e.location.x - c.x) > 0.01 || Math.abs(e.location.y - c.y) > 0.01 || Math.abs(e.location.z - c.z) > 0.01) {
                    e.teleport(c, { dimension: e.dimension });
                }
                if (e.dimension.id !== dimId) continue;
                for (const fx of e.getEffects()) { try { e.removeEffect(fx.typeId); } catch {} }
                if (e.nameTag !== PANEL_UI_TITLE) e.nameTag = PANEL_UI_TITLE;
            } catch {}
        }
    }
}, 5);
