/**
 * 酒馆角色卡 PNG 元数据解析 — 纯类型定义。
 *
 * 解析逻辑依赖 Node.js Buffer / fs，不放在 shared 的编译目标中。
 * 实际解析函数由使用方（scripts / sync-engine）自行导入 node:fs 后调用。
 * shared 只导出类型接口。
 */

export interface CharaCardData {
  spec: string;
  spec_version: string;
  data: {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    character_book?: Record<string, unknown>;
  };
}
