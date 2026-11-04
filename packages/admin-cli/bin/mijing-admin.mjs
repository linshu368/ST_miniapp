#!/usr/bin/env node
// 直接运行 TypeScript 源码：与仓库其他包一致，不维护构建产物。
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
