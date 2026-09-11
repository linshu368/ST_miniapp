import { useQuery } from '@tanstack/react-query';
import { Alert, Card, Layout, Menu, Result, Skeleton, Space, Tag, Typography } from 'antd';
import { getBatchLabContext } from './api/client';
import { batchLabQueryKeys } from './api/query-keys';

const { Header, Content } = Layout;

export function App() {
  const contextQuery = useQuery({
    queryKey: batchLabQueryKeys.context,
    queryFn: ({ signal }) => getBatchLabContext(signal),
    retry: false,
    staleTime: 60_000,
  });

  if (contextQuery.isPending) return <Skeleton active style={{ padding: 32 }} />;
  if (contextQuery.isError) {
    return (
      <Result
        status="error"
        title="无法确认运行环境"
        subTitle="Batch Lab 已安全停止。请检查 Backend feature flag、来源环境和 API/CORS 配置。"
      />
    );
  }

  const context = contextQuery.data;
  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <Typography.Title level={3} className="app-title">
          Batch Lab
        </Typography.Title>
        <Menu
          theme="dark"
          mode="horizontal"
          selectable={false}
          items={[
            { key: 'experiments', label: '实验记录', disabled: true },
            { key: 'samples', label: '样本集', disabled: true },
            { key: 'processors', label: '富文本后处理', disabled: true },
          ]}
        />
      </Header>
      <Content className="app-content">
        <Alert
          type={context.source_environment === 'production' ? 'warning' : 'info'}
          showIcon
          message={
            <Space wrap>
              <strong>权威环境</strong>
              <Tag>Backend: {context.backend_environment}</Tag>
              <Tag color={context.source_environment === 'production' ? 'red' : 'blue'}>
                样本来源: {context.source_environment}
              </Tag>
            </Space>
          }
          description="来源环境由 Backend 部署固定，当前页面不能切换。"
        />
        <Card title="工程基线已就绪" className="welcome-card">
          <Typography.Paragraph>
            当前仅开放平台环境握手。样本、实验与后处理能力将在后续独立任务通过稳定 API 接入。
          </Typography.Paragraph>
        </Card>
      </Content>
    </Layout>
  );
}
