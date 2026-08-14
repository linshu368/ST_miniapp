// eslint-import-guard — 故意违反跨包 import 规则的测试文件
// 运行 ESLint 时此文件必须报错，验证架构铁律护栏生效
// 验证通过后可删除或保留为 CI 护栏

// @ts-expect-error 故意违反：frontend → backend
import type { config } from '@miniapp/backend';

export type _Guard = typeof config;
