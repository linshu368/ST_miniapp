import { Button, Input, Select, Space, Table, Typography, type TableColumnsType } from 'antd';
import type { FreeZoneCandidate } from '@miniapp/shared';
import { deriveCandidateId, EMPTY_FREE_ZONE_CANDIDATE } from '../lib/freeZoneForm';

const MAX_CANDIDATES = 50;

const TIER_OPTIONS = [
  { value: 'premium', label: '旗舰' },
  { value: 'standard', label: '标准' },
  { value: 'light', label: '轻量' },
];

/** 深度思考开关对这个模型管不管用；不是「能开关」的，用户点深度思考时会轻提示一句 */
const THINKING_OPTIONS = [
  { value: 'switchable', label: '能开关' },
  { value: 'always', label: '关不掉' },
  { value: 'hidden', label: '不显示思考' },
];

type TextField = Exclude<keyof FreeZoneCandidate, 'benchmark_tier' | 'thinking'>;

const TEXT_COLUMNS: ReadonlyArray<{
  key: TextField;
  title: string;
  width: number;
  placeholder: string;
  maxLength: number;
}> = [
  {
    key: 'surplus_model',
    title: 'Surplus 模型名',
    width: 210,
    placeholder: 'deepseek-v4-pro',
    maxLength: 200,
  },
  { key: 'id', title: '免费模型 id', width: 210, placeholder: '留空按模型名生成', maxLength: 64 },
  {
    key: 'display_name',
    title: '显示名',
    width: 150,
    placeholder: 'DeepSeek V4 Pro',
    maxLength: 40,
  },
  { key: 'tagline', title: '介绍语', width: 200, placeholder: '可留空', maxLength: 40 },
  { key: 'family', title: '系列', width: 110, placeholder: 'deepseek', maxLength: 40 },
];

interface Row {
  index: number;
  candidate: FreeZoneCandidate;
}

/** 下拉选择的两列：对标档位、深度思考 */
function selectColumns(
  disabled: boolean | undefined,
  patch: (index: number, change: Partial<FreeZoneCandidate>) => void
): TableColumnsType<Row> {
  return [
    {
      title: '对标档位',
      key: 'benchmark_tier',
      width: 100,
      render: (_: unknown, row: Row) => (
        <Select
          className="field-full"
          value={row.candidate.benchmark_tier}
          options={TIER_OPTIONS}
          disabled={disabled}
          onChange={(benchmark_tier) => patch(row.index, { benchmark_tier })}
        />
      ),
    },
    {
      title: '深度思考',
      key: 'thinking',
      width: 120,
      render: (_: unknown, row: Row) => (
        <Select
          className="field-full"
          // 旧配置没有这一项，按默认「能开关」显示
          value={row.candidate.thinking ?? 'switchable'}
          options={THINKING_OPTIONS}
          disabled={disabled}
          onChange={(thinking) => patch(row.index, { thinking })}
        />
      ),
    },
  ];
}

/**
 * 候选池。顺序就是栏目里的展示顺序。
 * id 是用户「当前选择」存的值：已经上线的候选不要改 id，否则选了它的用户会被自动换走。
 */
export function FreeZoneCandidatesEditor(props: {
  value: FreeZoneCandidate[];
  disabled?: boolean;
  onChange: (value: FreeZoneCandidate[]) => void;
}) {
  const list = props.value;
  const patch = (index: number, change: Partial<FreeZoneCandidate>) =>
    props.onChange(list.map((item, at) => (at === index ? { ...item, ...change } : item)));
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    props.onChange(next);
  };
  const fillIdIfEmpty = (index: number) => {
    const candidate = list[index];
    if (candidate && candidate.id.trim() === '') {
      patch(index, { id: deriveCandidateId(candidate.surplus_model) });
    }
  };

  const columns: TableColumnsType<Row> = [
    ...TEXT_COLUMNS.map((column) => ({
      title: column.title,
      key: column.key,
      width: column.width,
      render: (_: unknown, row: Row) => (
        <Input
          value={row.candidate[column.key]}
          placeholder={column.placeholder}
          maxLength={column.maxLength}
          disabled={props.disabled}
          onChange={(event) => patch(row.index, { [column.key]: event.target.value })}
          onBlur={column.key === 'surplus_model' ? () => fillIdIfEmpty(row.index) : undefined}
        />
      ),
    })),
    ...selectColumns(props.disabled, patch),
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: unknown, row: Row) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            disabled={props.disabled || row.index === 0}
            onClick={() => move(row.index, -1)}
          >
            上移
          </Button>
          <Button
            type="link"
            size="small"
            disabled={props.disabled || row.index === list.length - 1}
            onClick={() => move(row.index, 1)}
          >
            下移
          </Button>
          <Button
            type="link"
            size="small"
            danger
            disabled={props.disabled}
            onClick={() => props.onChange(list.filter((_, at) => at !== row.index))}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space orientation="vertical" size="small" className="editor-stack">
      <Typography.Text type="secondary">
        顺序就是栏目里的展示顺序。免费模型 id 必须以 free- 开头；上线后别再改
        id，否则选了它的用户会被自动换走。
        系列用来在下架时优先换同系列；对标档位决定划线原价（取这一档当前的星尘价）；
        深度思考填这个模型在当前供应商上的实测，不是「能开关」的，用户点深度思考时会轻提示一句。
      </Typography.Text>
      <Table<Row>
        size="small"
        rowKey="index"
        pagination={false}
        scroll={{ x: 1250 }}
        columns={columns}
        dataSource={list.map((candidate, index) => ({ index, candidate }))}
      />
      <Button
        disabled={props.disabled || list.length >= MAX_CANDIDATES}
        onClick={() => props.onChange([...list, { ...EMPTY_FREE_ZONE_CANDIDATE }])}
      >
        添加候选
      </Button>
    </Space>
  );
}
