import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminEnvironment } from '../lib/environment';
import { setOperatorName } from '../lib/adminApi';

export function LoginPage(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  onAuthenticated: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <main className="login-screen">
      <Card className="login-card" bordered={false}>
        <div className="login-brand">
          <img
            className="login-brand-icon"
            src="/mijing-ai-operations-icon-v2.png"
            alt="蜜镜AI运营平台"
          />
          <div>
            <Typography.Title level={2}>蜜镜AI运营平台</Typography.Title>
            <Typography.Text type="secondary">配置、模型与数据分析</Typography.Text>
          </div>
        </div>
        <Typography.Paragraph type="secondary">
          当前登录环境：{props.environment === 'test' ? '测试环境' : '生产环境'}
        </Typography.Paragraph>
        {error ? <Alert type="error" message={error} showIcon className="form-alert" /> : null}
        <Form
          layout="vertical"
          onFinish={async (values: { email: string; password: string; displayName: string }) => {
            setLoading(true);
            setError(null);
            try {
              const { error: loginError } = await props.client.auth.signInWithPassword({
                email: values.email,
                password: values.password,
              });
              if (loginError) throw loginError;
              await setOperatorName(props.client, values.displayName);
              await props.onAuthenticated();
            } catch (loginError) {
              await props.client.auth.signOut();
              setError(loginError instanceof Error ? loginError.message : '登录失败');
            } finally {
              setLoading(false);
            }
          }}
        >
          <Form.Item
            label="邮箱"
            name="email"
            rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            label="操作人姓名"
            name="displayName"
            rules={[
              { required: true, whitespace: true, message: '请输入操作人姓名' },
              { max: 80, message: '操作人姓名不能超过 80 个字符' },
            ]}
          >
            <Input autoComplete="name" placeholder="用于发布历史与审计日志" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </Form>
        <Typography.Paragraph className="login-note">
          仅授权运营账号可进入，所有发布与回滚均记录审计。
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
