import {
  TEXT_POSTPROCESS_LIMITS,
  TextPostprocessArtifactSnapshotSchema,
  validateCompiledArtifact,
  type CompiledTextPostprocessArtifact,
  readPostprocessVersion,
  type ChatMessage,
  type ReadTextPostprocessVersionsData,
  type TextPostprocessArtifactSnapshot,
} from '@miniapp/shared';

// 派生校验 memo，不是第二份服务端状态。只缓存本模块归一化并冻结的响应对象。
const verifiedArtifacts = new WeakMap<
  TextPostprocessArtifactSnapshot,
  CompiledTextPostprocessArtifact
>();

function freezeJson(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.values(value).forEach(freezeJson);
  Object.freeze(value);
}

function normalizeSnapshot(input: unknown): TextPostprocessArtifactSnapshot | null {
  const parsed = TextPostprocessArtifactSnapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  const checked = validateCompiledArtifact(parsed.data.artifact);
  if (!checked.ok) return null;
  const snapshot = { ...parsed.data, artifact: checked.artifact };
  freezeJson(snapshot);
  verifiedArtifacts.set(snapshot, snapshot.artifact);
  return snapshot;
}

/** 非归一化对象（如测试/旧缓存）仍需完整校验，不允许 mutable 对象绕过验证。 */
export function verifiedSnapshotArtifact(
  snapshot: TextPostprocessArtifactSnapshot
): CompiledTextPostprocessArtifact | null {
  const cached = verifiedArtifacts.get(snapshot);
  if (cached) return cached;
  const checked = validateCompiledArtifact(snapshot.artifact);
  return checked.ok ? checked.artifact : null;
}

/** 已发布快照不可变。读失败不能写成 unavailable，否则会把暂时的网络错误当成永久缺失。 */
export type VersionSnapshotState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unavailable' }
  | { status: 'ready'; snapshot: TextPostprocessArtifactSnapshot };

export type VersionStateMap = Readonly<Record<number, VersionSnapshotState>>;

export function collectPostprocessVersions(messages: readonly ChatMessage[]): number[] {
  const versions = new Set<number>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const version = readPostprocessVersion(message.postprocess_version);
    if (version !== null) versions.add(version);
  }
  return [...versions].sort((left, right) => left - right);
}

export function chunkVersions(
  versions: readonly number[],
  size = TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch
): number[][] {
  const chunks: number[][] = [];
  for (let index = 0; index < versions.length; index += size) {
    chunks.push(versions.slice(index, index + size));
  }
  return chunks;
}

/** query key 带上 API 地址，避免 test/production 快照串缓存。版本集合排序后进入 key。 */
export function textPostprocessCollectionKey(apiUrl: string, versions: readonly number[]) {
  return ['text-postprocess', 'versions', apiUrl, versions.join(',')] as const;
}

export function textPostprocessVersionKey(apiUrl: string, version: number) {
  return ['text-postprocess', 'version', apiUrl, version] as const;
}

export function isSettledSnapshot(
  state: VersionSnapshotState | undefined
): state is Extract<VersionSnapshotState, { status: 'ready' | 'unavailable' }> {
  return state?.status === 'ready' || state?.status === 'unavailable';
}

/**
 * 只把本批请求到的版本写回对应编号。
 * 响应里多出来的版本、或另一条 found，都不能填到缺失的历史版本上。
 */
export function assignVersionBatch(
  requested: readonly number[],
  data: ReadTextPostprocessVersionsData
): Map<number, VersionSnapshotState> {
  const found = new Map<number, TextPostprocessArtifactSnapshot>();
  for (const value of data.found) {
    if (!requested.includes(value.version)) continue;
    const snapshot = normalizeSnapshot(value);
    if (snapshot) found.set(snapshot.version, snapshot);
  }
  const assigned = new Map<number, VersionSnapshotState>();
  for (const version of requested) {
    const snapshot = found.get(version);
    if (snapshot && snapshot.version === version) {
      assigned.set(version, { status: 'ready', snapshot });
      continue;
    }
    assigned.set(version, { status: 'unavailable' });
  }
  return assigned;
}

export function lookupVersionState(
  states: VersionStateMap,
  version: number | null
): VersionSnapshotState | null {
  if (version === null) return null;
  return states[version] ?? { status: 'loading' };
}

export async function loadVersionSnapshots(input: {
  versions: readonly number[];
  readCached: (version: number) => VersionSnapshotState | undefined;
  writeCached: (version: number, state: VersionSnapshotState) => void;
  postBatch: (versions: number[]) => Promise<ReadTextPostprocessVersionsData>;
}): Promise<VersionStateMap> {
  const requested = collectPositiveVersions(input.versions);
  const result: Record<number, VersionSnapshotState> = {};
  const missing: number[] = [];
  for (const version of requested) {
    const cached = input.readCached(version);
    if (isSettledSnapshot(cached)) {
      result[version] = cached;
    } else {
      missing.push(version);
    }
  }

  for (const batch of chunkVersions(missing)) {
    const data = await input.postBatch(batch);
    const assigned = assignVersionBatch(batch, data);
    for (const [version, state] of assigned) {
      input.writeCached(version, state);
      result[version] = state;
    }
  }
  return result;
}

function collectPositiveVersions(versions: readonly number[]): number[] {
  return [...new Set(versions.filter((version) => Number.isInteger(version) && version > 0))].sort(
    (left, right) => left - right
  );
}
