'use client';

import { useState, useEffect } from 'react';
import type { HealthData } from '@miniapp/shared';
import { useCharacters } from '@/hooks/use-characters';

export default function HomePage() {
  const { characters, loading: charsLoading } = useCharacters();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    fetch(`${apiUrl}/health`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setHealth(json.data);
        } else {
          setHealthError(json.error?.message || 'Unknown error');
        }
      })
      .catch((err) => setHealthError(err.message));
  }, []);

  return (
    <main className="p-6 max-w-md mx-auto space-y-8">
      <h1 className="text-2xl font-bold">MiniApp 框架验证</h1>

      {/* 检查项 1：shared 类型 + hook 模式 */}
      <section>
        <h2 className="text-lg font-semibold mb-2">Mock 数据（via useCharacters hook）</h2>
        {charsLoading ? (
          <p className="text-gray-400">加载中...</p>
        ) : (
          <ul className="space-y-2">
            {characters.map((c) => (
              <li key={c.id} className="bg-gray-800 rounded-lg p-3">
                <p className="font-medium">{c.name}</p>
                <p className="text-sm text-gray-400">{c.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 检查项 2：前后端通信 */}
      <section>
        <h2 className="text-lg font-semibold mb-2">后端 Health Check</h2>
        {health ? (
          <div className="bg-green-900 rounded-lg p-3">
            <p>状态: {health.status}</p>
            <p className="text-sm text-gray-400">{health.timestamp}</p>
          </div>
        ) : healthError ? (
          <div className="bg-red-900 rounded-lg p-3">
            <p>连接失败: {healthError}</p>
          </div>
        ) : (
          <p className="text-gray-400">连接中...</p>
        )}
      </section>
    </main>
  );
}