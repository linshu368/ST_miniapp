import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { csApi, getCsAdminToken, getCsOperatorId, setCsAdminToken, setCsOperatorId } from '../api';

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState(getCsAdminToken());
  const [operatorId, setOperatorId] = useState(getCsOperatorId());
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const normalizedToken = token.trim();
      const normalizedOperatorId = operatorId.trim() || 'cs-operator';
      if (!normalizedToken) throw new Error('请输入 Admin Token');

      setCsAdminToken(normalizedToken);
      setCsOperatorId(normalizedOperatorId);
      await csApi.personas();
      return normalizedToken;
    },
    onSuccess: (normalizedToken) => {
      setError(null);
      onLogin(normalizedToken);
    },
    onError: (loginError) => {
      setCsAdminToken('');
      setError(loginError instanceof Error ? loginError.message : '登录失败，请检查 Token');
    },
  });

  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          loginMutation.mutate();
        }}
      >
        <div className="login-brand">
          <span className="login-logo" aria-hidden="true">
            蜜
          </span>
          <div>
            <h1>蜜镜AI用户回访平台</h1>
            <p>用户回访 · Telegram 1V1 · 运营自动化</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="login-token">Admin Token</label>
          <input
            id="login-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="X-CS-Admin-Token"
            type="password"
            autoComplete="current-password"
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="login-operator">操作员标识</label>
          <input
            id="login-operator"
            value={operatorId}
            onChange={(event) => setOperatorId(event.target.value)}
            placeholder="例如 cs-op-1（用于审计记录）"
          />
        </div>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? '校验中…' : '登录'}
        </button>

        <p className="login-footnote">仅限内部运营人员使用，操作会记录审计日志。</p>
      </form>
    </main>
  );
}
