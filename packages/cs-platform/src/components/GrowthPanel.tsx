import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GrowthChannelLinkData } from '@miniapp/shared';
import { csApi } from '../api';
import { formatDateTime } from '../constants';

export function GrowthPanel({ onToast }: { onToast: (message: string) => void }) {
  const qc = useQueryClient();
  const [sourceName, setSourceName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [notes, setNotes] = useState('');

  const linksQuery = useQuery({
    queryKey: ['cs', 'growth', 'links'],
    queryFn: csApi.growthLinks,
  });
  const links = linksQuery.data?.links ?? [];
  const totals = useMemo(
    () =>
      links.reduce(
        (acc, link) => ({
          click_count: acc.click_count + link.click_count,
          enter_count: acc.enter_count + link.enter_count,
          unique_enter_count: acc.unique_enter_count + link.unique_enter_count,
          activated_user_count: acc.activated_user_count + link.activated_user_count,
        }),
        { click_count: 0, enter_count: 0, unique_enter_count: 0, activated_user_count: 0 }
      ),
    [links]
  );

  const createMutation = useMutation({
    mutationFn: () =>
      csApi.createGrowthLink({
        source_name: sourceName,
        source_id: sourceId || undefined,
        notes: notes || undefined,
      }),
    onSuccess: (data) => {
      setSourceName('');
      setSourceId('');
      setNotes('');
      onToast(`已生成渠道链接：${data.link.source_name}`);
      void qc.invalidateQueries({ queryKey: ['cs', 'growth', 'links'] });
    },
    onError: (error) => onToast(error instanceof Error ? error.message : '创建渠道链接失败'),
  });

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    onToast(`已复制${label}`);
  };

  return (
    <section className="growth-workspace">
      <header className="growth-hero">
        <div>
          <p className="section-kicker">Growth Attribution</p>
          <h1>MiniApp 渠道链接</h1>
          <p>生成带 startapp 暗参的 Telegram MiniApp 链接，统计点击、进入 MiniApp 和激活用户。</p>
        </div>
      </header>

      <div className="growth-metrics">
        <MetricCard label="点击次数" value={totals.click_count} hint="使用统计跳转链接时记录" />
        <MetricCard label="进入次数" value={totals.enter_count} hint="MiniApp 启动后上报" />
        <MetricCard
          label="进入用户数"
          value={totals.unique_enter_count}
          hint="按 miniapp.users 去重"
        />
        <MetricCard label="激活用户数" value={totals.activated_user_count} hint="total_round > 0" />
      </div>

      <div className="growth-layout">
        <form
          className="growth-card growth-form"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
        >
          <header className="growth-card-head">
            <h2>新建渠道链接</h2>
            <p>渠道暗参可手动填，例如 xhs_001；不填则自动生成。</p>
          </header>
          <div className="field">
            <label htmlFor="source-name">渠道名称 *</label>
            <input
              id="source-name"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
              placeholder="例如：小红书-7月第一批"
            />
          </div>
          <div className="field">
            <label htmlFor="source-id">渠道暗参</label>
            <input
              id="source-id"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              placeholder="例如：xhs_001"
            />
            <p className="field-hint">仅支持字母、数字、下划线、短横线，长度 3-64。</p>
          </div>
          <div className="field">
            <label htmlFor="source-notes">备注</label>
            <textarea
              id="source-notes"
              value={notes}
              rows={4}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="投放位置、素材批次、负责人等"
            />
          </div>
          <button
            className="btn btn-primary btn-block"
            disabled={!sourceName.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? '生成中…' : '生成渠道链接'}
          </button>
        </form>

        <section className="growth-card growth-table-card">
          <header className="growth-card-head table-head">
            <div>
              <h2>渠道列表</h2>
              <p>优先复制 MiniApp 直达链接；需要点击统计时复制统计跳转链接。</p>
            </div>
            <button className="btn btn-sm" onClick={() => linksQuery.refetch()}>
              刷新
            </button>
          </header>

          <div className="growth-table-wrap">
            <table className="growth-table">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th>暗参</th>
                  <th>点击</th>
                  <th>进入</th>
                  <th>用户</th>
                  <th>激活</th>
                  <th>最近进入</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {linksQuery.isLoading && (
                  <tr>
                    <td colSpan={8}>加载中…</td>
                  </tr>
                )}
                {linksQuery.isError && (
                  <tr>
                    <td colSpan={8} className="error-cell">
                      {String(linksQuery.error.message)}
                    </td>
                  </tr>
                )}
                {!linksQuery.isLoading && !linksQuery.isError && links.length === 0 && (
                  <tr>
                    <td colSpan={8}>暂无渠道链接。</td>
                  </tr>
                )}
                {links.map((link) => (
                  <ChannelRow key={link.id} link={link} onCopy={copy} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}

function MetricCard(props: { label: string; value: number; hint: string }) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <strong>{props.value.toLocaleString()}</strong>
      <small>{props.hint}</small>
    </div>
  );
}

function ChannelRow(props: {
  link: GrowthChannelLinkData;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  const { link } = props;
  return (
    <tr>
      <td>
        <strong className="table-primary">{link.source_name}</strong>
        {link.notes && <span className="table-note">{link.notes}</span>}
      </td>
      <td>
        <code>{link.source_id}</code>
      </td>
      <td>{link.click_count}</td>
      <td>{link.enter_count}</td>
      <td>{link.unique_enter_count}</td>
      <td>{link.activated_user_count}</td>
      <td>{formatDateTime(link.last_entered_at) || '-'}</td>
      <td>
        <div className="table-actions">
          <button
            className="btn btn-sm"
            onClick={() => props.onCopy(link.miniapp_link, 'MiniApp 链接')}
          >
            MiniApp
          </button>
          <button
            className="btn btn-sm"
            onClick={() => props.onCopy(link.tracking_link, '统计链接')}
          >
            统计
          </button>
        </div>
      </td>
    </tr>
  );
}
