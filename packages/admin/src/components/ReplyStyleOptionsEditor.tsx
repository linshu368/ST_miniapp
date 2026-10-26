import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Input, Popconfirm, Switch, Tag, Typography } from 'antd';
import type { InputRef } from 'antd';
import './ReplyStyleOptionsEditor.css';

import {
  MAX_REPLY_STYLE_OPTIONS,
  type ReplyStyleOption,
  type ReplyStyleOptionsConfig,
} from '@miniapp/shared';

/** Operators own the content; the parent owns draft, publish and history. */
export function ReplyStyleOptionsEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: ReplyStyleOptionsConfig;
  onChange: (value: ReplyStyleOptionsConfig) => void;
  disabled?: boolean;
}) {
  const options = value.options;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewToggles, setPreviewToggles] = useState<Record<string, boolean>>({});
  const nextId = useRef(1);
  const nameInput = useRef<InputRef>(null);
  const pendingFocusId = useRef<string | null>(null);
  useEffect(() => {
    if (pendingFocusId.current === selectedId) {
      nameInput.current?.focus();
      pendingFocusId.current = null;
    }
  }, [selectedId]);
  const selected = options.find((option) => option.id === selectedId) ?? options[0];
  const selectedIndex = options.findIndex((option) => option.id === selected?.id);
  const visibleOptions = options.filter((option) => option.enabled);

  const updateOption = (id: string, patch: Partial<Omit<ReplyStyleOption, 'id'>>) => {
    if (disabled) return;
    onChange({
      options: options.map((option) => (option.id === id ? { ...option, ...patch } : option)),
    });
  };

  const addOption = () => {
    if (disabled || options.length >= MAX_REPLY_STYLE_OPTIONS) return;
    const suffix =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${nextId.current++}`;
    const id = `style-${suffix}`;
    onChange({
      options: [
        ...options,
        { id, name: '', description: '', marker: '', rules: '', enabled: true },
      ],
    });
    pendingFocusId.current = id;
    setSelectedId(id);
  };

  const moveOption = (id: string, direction: -1 | 1) => {
    if (disabled) return;
    const index = options.findIndex((option) => option.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= options.length) return;
    const reordered = [...options];
    [reordered[index], reordered[next]] = [reordered[next]!, reordered[index]!];
    setSelectedId(id);
    onChange({ options: reordered });
  };

  const removeOption = (id: string) => {
    if (disabled) return;
    const index = options.findIndex((option) => option.id === id);
    const remaining = options.filter((option) => option.id !== id);
    onChange({ options: remaining });
    setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    setPreviewToggles((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  return (
    <div className="reply-style-options">
      <header className="reply-style-options__heading">
        <div>
          <div className="reply-style-options__eyebrow">对话体验 · 回复偏好</div>
          <Typography.Title level={2}>回复风格</Typography.Title>
          <Typography.Paragraph type="secondary">
            选项由你定义，在预览中实时查看用户看到的样子。
          </Typography.Paragraph>
        </div>
        <Tag color="blue">独立开关</Tag>
      </header>

      <div className="reply-style-options__notice" role="note">
        <span className="reply-style-options__notice-dot" aria-hidden />
        发布后，名称与说明会展示给用户。英文占位符与规则内容目前仅存储，不参与生成。
      </div>

      <div className="reply-style-options__workspace">
        <Card
          className="reply-style-options__list"
          title={
            <span className="reply-style-options__card-title">
              选项列表 <span>{options.length}</span>
            </span>
          }
          extra={
            <Button
              type="text"
              disabled={disabled || options.length >= MAX_REPLY_STYLE_OPTIONS}
              onClick={addOption}
              aria-label="新增选项"
            >
              ＋ 新增
            </Button>
          }
        >
          <div className="reply-style-options__rows">
            {options.map((option, index) => (
              <div
                key={option.id}
                className={`reply-style-options__row${option.id === selected?.id ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="reply-style-options__select"
                  aria-pressed={option.id === selected?.id}
                  onClick={() => setSelectedId(option.id)}
                >
                  <span className="reply-style-options__order">{index + 1}</span>
                  <span className="reply-style-options__row-copy">
                    <strong>{option.name.trim() || '未命名选项'}</strong>
                    <span>{option.description.trim() || '添加一句说明'}</span>
                  </span>
                </button>
                <Switch
                  size="small"
                  disabled={disabled}
                  checked={option.enabled}
                  aria-label={`在界面展示${option.name.trim() || '未命名选项'}`}
                  onChange={(enabled) => updateOption(option.id, { enabled })}
                />
              </div>
            ))}
          </div>
          {options.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有选项" />
          ) : null}
          <Button
            block
            type="dashed"
            disabled={disabled || options.length >= MAX_REPLY_STYLE_OPTIONS}
            onClick={addOption}
            className="reply-style-options__add"
          >
            ＋ 添加选项
          </Button>
          <p className="reply-style-options__small-note">启用后，选项会出现在用户预览中。</p>
        </Card>

        <Card
          className="reply-style-options__editor"
          title="编辑选项"
          extra={
            selected ? (
              <Tag>
                {selectedIndex + 1} / {options.length}
              </Tag>
            ) : null
          }
        >
          {selected ? (
            <div className="reply-style-options__fields">
              <label className="reply-style-options__field">
                <span>选项名称</span>
                <Input
                  ref={nameInput}
                  disabled={disabled}
                  value={selected.name}
                  maxLength={40}
                  placeholder="填写用户看到的名称"
                  onChange={(event) => updateOption(selected.id, { name: event.target.value })}
                />
              </label>
              <label className="reply-style-options__field">
                <span>选项说明</span>
                <Input.TextArea
                  value={selected.description}
                  disabled={disabled}
                  maxLength={200}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  placeholder="用一句话说明这个选项"
                  onChange={(event) =>
                    updateOption(selected.id, { description: event.target.value })
                  }
                />
              </label>
              <label className="reply-style-options__field">
                <span>
                  英文占位符 <small>自行填写</small>
                </span>
                <Input
                  value={selected.marker}
                  disabled={disabled}
                  maxLength={120}
                  placeholder="{{YOUR_MARKER}}"
                  className="reply-style-options__marker"
                  onChange={(event) => updateOption(selected.id, { marker: event.target.value })}
                />
                <em>自行定义标志，不会自动写入主体模板。</em>
              </label>
              <label className="reply-style-options__field">
                <span>
                  规则内容 <small>可以留空</small>
                </span>
                <Input.TextArea
                  value={selected.rules}
                  disabled={disabled}
                  maxLength={12000}
                  autoSize={{ minRows: 7, maxRows: 14 }}
                  showCount
                  placeholder="留白"
                  onChange={(event) => updateOption(selected.id, { rules: event.target.value })}
                />
                <em>可先留空；本次仅保存内容，不向模型注入。</em>
              </label>
              <div className="reply-style-options__editor-actions">
                <div className="reply-style-options__sort-actions">
                  <span>显示顺序</span>
                  <Button
                    disabled={disabled || selectedIndex === 0}
                    aria-label="选项上移"
                    onClick={() => moveOption(selected.id, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    disabled={disabled || selectedIndex === options.length - 1}
                    aria-label="选项下移"
                    onClick={() => moveOption(selected.id, 1)}
                  >
                    ↓
                  </Button>
                </div>
                <Popconfirm
                  title="移除这个选项？"
                  description="保存并发布后，用户将不再看到该选项。"
                  disabled={disabled}
                  okText="移除"
                  cancelText="取消"
                  onConfirm={() => removeOption(selected.id)}
                >
                  <Button danger disabled={disabled} type="text">
                    移除选项
                  </Button>
                </Popconfirm>
              </div>
            </div>
          ) : (
            <div className="reply-style-options__empty-editor">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="添加一个选项，开始编辑" />
              <Button type="primary" disabled={disabled} onClick={addOption}>
                添加选项
              </Button>
            </div>
          )}
        </Card>

        <aside className="reply-style-options__preview-column" aria-label="移动端实时预览">
          <div className="reply-style-options__preview-heading">
            <span>用户视角</span>
            <span>实时预览</span>
          </div>
          <div className="reply-style-options__phone">
            <div className="reply-style-options__phone-status" aria-hidden>
              <span>9:41</span>
              <span>▰ ▰ ▰</span>
            </div>
            <div className="reply-style-options__phone-chat">
              <div className="reply-style-options__phone-avatar" aria-hidden>
                ✦
              </div>
              <span>对话</span>
            </div>
            <div className="reply-style-options__phone-context" aria-hidden>
              <div />
              <div />
              <div />
            </div>
            <section className="reply-style-options__phone-sheet">
              <div className="reply-style-options__phone-handle" aria-hidden />
              <div className="reply-style-options__phone-title">回复偏好</div>
              <div className="reply-style-options__phone-subtitle">按你的习惯，让对话更合拍</div>
              <div className="reply-style-options__phone-section">回复风格</div>
              <p className="reply-style-options__phone-hint">可同时开启多个选项</p>
              <div className="reply-style-options__phone-options">
                {visibleOptions.map((option) => (
                  <label
                    key={option.id}
                    htmlFor={`reply-style-preview-${option.id}`}
                    className="reply-style-options__phone-option"
                  >
                    <span>
                      <strong>{option.name.trim() || '未命名选项'}</strong>
                      <small>{option.description.trim() || '填写说明后将在这里展示'}</small>
                    </span>
                    <Switch
                      id={`reply-style-preview-${option.id}`}
                      checked={Boolean(previewToggles[option.id])}
                      aria-label={`预览：${option.name.trim() || '未命名选项'}`}
                      onChange={(checked) =>
                        setPreviewToggles((current) => ({ ...current, [option.id]: checked }))
                      }
                    />
                  </label>
                ))}
                {visibleOptions.length === 0 ? (
                  <div className="reply-style-options__phone-empty">启用选项，即可查看展示效果</div>
                ) : null}
              </div>
              <div className="reply-style-options__phone-personal">
                <span>我的偏好</span>
                <div>写下你的其他习惯与要求…</div>
              </div>
            </section>
            <div className="reply-style-options__phone-footer" aria-hidden />
          </div>
          <p className="reply-style-options__preview-note">
            预览开关仅用于体验，不会影响真实用户。
          </p>
        </aside>
      </div>
    </div>
  );
}
