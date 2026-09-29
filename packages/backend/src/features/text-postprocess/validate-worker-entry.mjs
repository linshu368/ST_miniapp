import { register } from 'tsx/esm/api';

// Worker 线程不继承 Vitest/tsx 的模块解析。先在本线程注册 tsx，再加载编译器。
register();
await import('./validate.worker.ts');
