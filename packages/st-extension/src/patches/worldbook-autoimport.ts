/**
 * st-extension / patches / worldbook-autoimport.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 交互从 extension 侧调整。
 *
 * 修复目标：点角色卡进入对话时弹出的
 *   「This character has an embedded World/Lorebook. Would you like to import it now?」
 *   阻塞式确认框。平台所有角色卡均为运营可信内容，用户不应感知该弹窗 ——
 *   等价于自动点「Yes」：静默导入并链接角色内置世界书，用户进对话即可直接发消息。
 *
 * ST 行为（vendor scripts/world-info.js / script.js）：
 *   selectCharacterById → getChat → getChatResult()：
 *     1) select_selected_character(chid) → checkEmbeddedWorld(chid)  ← 弹窗在此触发
 *     2) eventSource.emit(CHAT_CHANGED)                              ← 之后才发事件
 *   checkEmbeddedWorld 条件：角色含 data.character_book、accountStorage 无
 *     `AlertWI_<avatar>` 标记、该书未链接（extensions.world 不在 world_names）、
 *     且 power_user.world_import_dialog === true 时，callGenericPopup(CONFIRM) 阻塞弹窗；
 *     点「Yes」→ importEmbeddedWorldInfo(true)（转换 + 落盘 + 链接 extensions.world）。
 *   注意：弹窗早于 CHAT_CHANGED，故无法照搬 regex-autoconfirm 的 makeFirst(CHAT_CHANGED) 拦截。
 *
 * 修复方式（三道防线，覆盖各入口、规避时序竞态）：
 *   1) 去阻塞：init + APP_READY 时置 power_user.world_import_dialog = false，
 *      把「阻塞 CONFIRM」降级为非阻塞 toastr —— 因弹窗早于任何可监听事件，
 *      必须提前关开关才能保证绝不卡住用户。仅运行时内存覆写，不写回 settings.json。
 *   2) 去 toastr：APP_READY 时为已加载且含 character_book 的角色预置
 *      `AlertWI_<avatar>='true'`，使 checkEmbeddedWorld 连那次 info toastr 都不弹。
 *   3) 真导入（忠实于「Yes」）：CHAT_CHANGED + init 兜底为当前角色静默导入内置世界书
 *      —— 复刻 importEmbeddedWorldInfo 的核心（convert + saveWorldInfo + updateWorldInfoList +
 *      writeExtensionField('world')），但去掉其 UI 副作用（原函数会 trigger #WIDrawerIcon
 *      弹出世界书面板、弹 success toastr）。导入并链接后，后续进入因 extensions.world 已在
 *      world_names 中，checkEmbeddedWorld 天然不再触发，长期干净。
 */

import '../st-types.js';

/** 关闭阻塞式导入确认框（运行时内存覆写，不持久化）。 */
function disableBlockingImportDialog(): void {
  try {
    SillyTavern.getContext().powerUserSettings.world_import_dialog = false;
  } catch {
    /* power_user 尚未就绪时忽略，APP_READY 会再设一次 */
  }
}

/** 为已加载且含内置世界书的角色预置 AlertWI 标记，抑制 checkEmbeddedWorld 的 info toastr。 */
function suppressEmbeddedWorldToasts(): void {
  try {
    const ctx = SillyTavern.getContext();
    const storage = ctx.accountStorage;
    if (!storage) return;
    for (const character of ctx.characters ?? []) {
      if (character?.avatar && character.data?.character_book) {
        storage.setItem(`AlertWI_${character.avatar}`, 'true');
      }
    }
  } catch {
    /* 抑制失败至多多一次非阻塞 toastr，不影响聊天 */
  }
}

/**
 * 为当前角色静默导入内置世界书（等价于在弹窗点「Yes」）。
 * 幂等：世界书已落盘且已链接到角色时直接跳过。
 */
async function importEmbeddedWorldForCurrentCharacter(): Promise<void> {
  try {
    const ctx = SillyTavern.getContext();
    const chid = ctx.characterId;
    if (chid === undefined) return;

    const character = ctx.characters[chid];
    const book = character?.data?.character_book;
    if (!book) return;

    const bookName = book.name || `${character?.name}'s Lorebook`;
    const worldNames = ctx.getWorldInfoNames();
    const linkedWorld = character?.data?.extensions?.world;

    // 已落盘 + 已链接 → 无需重复导入
    if (worldNames.includes(bookName) && linkedWorld === bookName) return;

    if (!worldNames.includes(bookName)) {
      const converted = ctx.convertCharacterBook(book);
      await ctx.saveWorldInfo(bookName, converted, true);
      await ctx.updateWorldInfoList();
    }

    if (linkedWorld !== bookName) {
      // 替代 vendor 的 $('#character_world').val().trigger('change')：
      // writeExtensionField 直接写 data.extensions.world（内存 + json_data + 服务端 merge），
      // 不依赖角色编辑面板 DOM、无 UI 副作用。
      await ctx.writeExtensionField(chid, 'world', bookName);
    }
  } catch {
    /* 单次导入失败不应阻断聊天流程 */
  }
}

/**
 * 安装角色内置世界书「自动导入」补丁。
 * 见文件顶部三道防线说明。
 */
export function installWorldbookAutoImport(): void {
  const ctx = SillyTavern.getContext();

  disableBlockingImportDialog();

  ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    // APP_READY 后 settings 已加载，重置开关并预置 toastr 抑制标记
    disableBlockingImportDialog();
    suppressEmbeddedWorldToasts();
  });

  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    void importEmbeddedWorldForCurrentCharacter();
  });

  // 整页刷新直接进对话场景，初始已选中角色，兜底跑一次
  void importEmbeddedWorldForCurrentCharacter();
}
