import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CsMessageData, CsPersonaData, CsSopStageData, CsUserData } from '@miniapp/shared';
import { csApi, getCsAdminToken, getCsOperatorId, setCsAdminToken, setCsOperatorId } from './api';

const DEFAULT_SQL = `SELECT u.id AS user_id
FROM public.users u
JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
WHERE s.total_round > 40
  AND u.created_at < now() - interval '7 days'
ORDER BY s.total_round DESC`;

const DEFAULT_SOP: CsSopStageData[] = [
  {
    key: 'icebreaker',
    title: '破冰',
    prompt: 'Hi~ 我是XX的运营客服，想花几分钟听听你的使用感受，方便吗？',
  },
  {
    key: 'pain',
    title: '体验痛点',
    prompt:
      '您平时跟角色聊天的时候，有没有遇到什么让您特别不爽的地方？卡顿、bug、或者觉得哪里别扭的，都算。',
    followups: ['这种情况大概多久出现一次？', '当时是在什么场景下？'],
  },
  {
    key: 'feature',
    title: '最想要的功能',
    prompt: '如果我们接下来只能加一个新功能，您最希望是什么？',
    followups: ['这个功能对您来说主要是解决什么问题？'],
    fallback_options: [
      '① 语音消息（让角色用语音念出来）',
      '② 状态栏（看到角色心情/好感度）',
      '③ 超强记忆（聊几百回合不失忆）',
      '④ 生成图片（根据场景生成角色图）',
      '⑤ 自建角色卡（自己创建和保存角色）',
    ],
  },
  {
    key: 'role_preference',
    title: '角色卡偏好',
    prompt: '您有没有特别想聊但我们大厅里没有的角色类型？什么设定都行',
  },
  {
    key: 'closing',
    title: '收尾',
    prompt:
      '感谢你的真实反馈，这对我们很重要。以后有任何不爽的地方，随时找我，我帮您催开发！祝您玩得开心~',
  },
];

type Membership = 'active' | 'chatted_left';

export default function App() {
  const qc = useQueryClient();
  const [authToken, setAuthToken] = useState(getCsAdminToken());
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<{
    user: CsUserData;
    membership: Membership;
  } | null>(null);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const personasQuery = useQuery({
    queryKey: ['cs', 'personas', authToken],
    queryFn: csApi.personas,
    enabled: !!authToken,
  });
  const personas = personasQuery.data?.personas ?? [];
  const selectedPersona =
    personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0] ?? null;

  const usersQuery = useQuery({
    queryKey: ['cs', 'users', selectedPersona?.id],
    queryFn: () => csApi.users(selectedPersona!.id),
    enabled: !!selectedPersona,
  });

  const sessionQuery = useQuery({
    queryKey: ['cs', 'session', selectedPersona?.id, selectedUser?.user.user_id],
    queryFn: () => csApi.session(selectedPersona!.id, selectedUser!.user.user_id),
    enabled: !!selectedPersona && !!selectedUser,
  });

  const messagesQuery = useQuery({
    queryKey: ['cs', 'messages', selectedPersona?.id, selectedUser?.user.user_id],
    queryFn: () => csApi.messages(selectedPersona!.id, selectedUser!.user.user_id),
    enabled: !!selectedPersona && !!selectedUser,
    refetchInterval: selectedUser ? 10_000 : false,
  });

  const refreshMutation = useMutation({
    mutationFn: (personaId: string) => csApi.refreshPersona(personaId),
    onSuccess: (data) => {
      setToast(`刷新完成：${data.active_count} 当前在簇，${data.chatted_left_count} 已聊移出`);
      void qc.invalidateQueries({ queryKey: ['cs'] });
    },
    onError: (error) => setToast(error instanceof Error ? error.message : '刷新失败'),
  });

  const handleLogout = () => {
    setCsAdminToken('');
    setAuthToken('');
    setSelectedPersonaId(null);
    setSelectedUser(null);
    qc.removeQueries({ queryKey: ['cs'] });
  };

  const activeUsers = usersQuery.data?.active ?? [];
  const chattedLeftUsers = usersQuery.data?.chatted_left ?? [];

  if (!authToken) {
    return (
      <LoginPage
        onLogin={(nextToken) => {
          setAuthToken(nextToken);
          void qc.invalidateQueries({ queryKey: ['cs'] });
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="persona-sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">CS Platform</p>
            <h1>画像簇</h1>
          </div>
          <button className="ghost-button" onClick={() => setShowPersonaModal(true)}>
            新建
          </button>
        </header>

        <section className="workspace-account">
          <span>
            <strong>{getCsOperatorId()}</strong>
            <small>已连接 CS 后台</small>
          </span>
          <button className="ghost-button" onClick={handleLogout}>
            退出
          </button>
        </section>

        <div className="persona-list">
          {personas.map((persona) => (
            <button
              key={persona.id}
              className={`persona-item ${selectedPersona?.id === persona.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedPersonaId(persona.id);
                setSelectedUser(null);
              }}
            >
              <span className="dot" style={{ background: persona.color }} />
              <span className="persona-main">
                <strong>{persona.name}</strong>
                <small>{persona.description}</small>
              </span>
              <span className="count">{persona.active_count}</span>
            </button>
          ))}
          {personasQuery.isError && (
            <p className="error-text">{String(personasQuery.error.message)}</p>
          )}
        </div>
      </aside>

      <main className="user-column">
        {selectedPersona ? (
          <>
            <header className="column-header">
              <div>
                <p className="eyebrow">Persona</p>
                <h2>{selectedPersona.name}</h2>
                <p>{selectedPersona.opening_script}</p>
              </div>
              <div className="header-actions">
                <button
                  className="secondary-button"
                  onClick={() => refreshMutation.mutate(selectedPersona.id)}
                  disabled={refreshMutation.isPending}
                >
                  {refreshMutation.isPending ? '刷新中' : '刷新'}
                </button>
                <button
                  className="secondary-button"
                  onClick={() =>
                    csApi
                      .exportPersona(selectedPersona.id, selectedPersona.name)
                      .catch((error) => setToast(error.message))
                  }
                >
                  下载 .xlsx
                </button>
              </div>
            </header>

            <UserSection
              title={`当前在簇 · ${activeUsers.length}`}
              users={activeUsers}
              membership="active"
              selectedUser={selectedUser?.user.user_id}
              onSelect={(user, membership) => setSelectedUser({ user, membership })}
            />
            <UserSection
              title={`已聊·已移出 · ${chattedLeftUsers.length}`}
              users={chattedLeftUsers}
              membership="chatted_left"
              selectedUser={selectedUser?.user.user_id}
              onSelect={(user, membership) => setSelectedUser({ user, membership })}
              muted
            />
          </>
        ) : (
          <EmptyState text="暂无画像簇，先新建一个。" />
        )}
      </main>

      <section className="conversation-column">
        {selectedPersona && selectedUser ? (
          <OutreachPanel
            persona={selectedPersona}
            user={selectedUser.user}
            messages={messagesQuery.data?.messages ?? []}
            session={sessionQuery.data?.session ?? null}
            onChanged={() => {
              void qc.invalidateQueries({
                queryKey: ['cs', 'messages', selectedPersona.id, selectedUser.user.user_id],
              });
              void qc.invalidateQueries({
                queryKey: ['cs', 'session', selectedPersona.id, selectedUser.user.user_id],
              });
              void qc.invalidateQueries({ queryKey: ['cs', 'users', selectedPersona.id] });
            }}
            onToast={setToast}
          />
        ) : (
          <EmptyState text="选择用户后开始 Telegram 1V1 SOP 回访" />
        )}
      </section>

      {showPersonaModal && (
        <PersonaModal
          onClose={() => setShowPersonaModal(false)}
          onCreated={(persona) => {
            setShowPersonaModal(false);
            setSelectedPersonaId(persona.id);
            void qc.invalidateQueries({ queryKey: ['cs', 'personas'] });
          }}
          onToast={setToast}
        />
      )}

      {toast && (
        <button className="toast" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
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
      <section className="login-hero">
        <p className="eyebrow">CS Platform</p>
        <h1>内部用户回访工作台</h1>
        <p>
          统一管理 SQL 用户分层、Telegram 1V1 回访 SOP、消息记录和 .xlsx
          导出。请先完成内部身份校验。
        </p>
        <div className="login-metrics">
          <span>
            <strong>SQL</strong>
            <small>实时画像簇</small>
          </span>
          <span>
            <strong>1V1</strong>
            <small>Telegram 回访</small>
          </span>
          <span>
            <strong>XLSX</strong>
            <small>审计导出</small>
          </span>
        </div>
      </section>

      <section className="login-card">
        <p className="eyebrow">Secure Sign In</p>
        <h2>登录 CS 后台</h2>
        <label>Admin Token</label>
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="输入 X-CS-Admin-Token"
          type="password"
          autoFocus
        />
        <label>Operator ID</label>
        <input
          value={operatorId}
          onChange={(event) => setOperatorId(event.target.value)}
          placeholder="例如 cs-operator"
        />
        {error && <p className="login-error">{error}</p>}
        <button
          className="primary-button"
          onClick={() => loginMutation.mutate()}
          disabled={loginMutation.isPending}
        >
          {loginMutation.isPending ? '校验中...' : '进入工作台'}
        </button>
      </section>
    </main>
  );
}

function UserSection(props: {
  title: string;
  users: CsUserData[];
  membership: Membership;
  selectedUser?: string;
  muted?: boolean;
  onSelect: (user: CsUserData, membership: Membership) => void;
}) {
  return (
    <section className="user-section">
      <h3>{props.title}</h3>
      {props.users.length === 0 ? (
        <p className="muted">暂无用户</p>
      ) : (
        props.users.map((user) => (
          <button
            key={`${props.membership}-${user.user_id}`}
            className={`user-item ${props.selectedUser === user.user_id ? 'active' : ''} ${props.muted ? 'muted-user' : ''}`}
            onClick={() => props.onSelect(user, props.membership)}
          >
            <span>
              <strong>{user.display_name}</strong>
              <small>
                {user.register_days}天 · {user.total_round}轮 · ¥{user.total_paid_amount}
              </small>
              {user.left_note && <em>{user.left_note}</em>}
            </span>
            <span className="status-pill">{user.session_status}</span>
          </button>
        ))
      )}
    </section>
  );
}

function OutreachPanel(props: {
  persona: CsPersonaData;
  user: CsUserData;
  messages: CsMessageData[];
  session: ReturnType<typeof normalizeSession> | null;
  onChanged: () => void;
  onToast: (message: string) => void;
}) {
  const [input, setInput] = useState('');
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const currentPrompt =
    selectedPrompt ?? props.session?.suggested_prompt ?? props.persona.opening_script;
  const stages = props.persona.sop.length ? props.persona.sop : DEFAULT_SOP;

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      csApi.sendMessage(props.persona.id, props.user.user_id, {
        content,
        sop_stage: props.session?.current_stage ?? stages[0]?.key,
        question_key: props.session?.current_question_key ?? stages[0]?.key,
        idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    onSuccess: () => {
      setInput('');
      setSelectedPrompt(null);
      props.onChanged();
    },
    onError: (error) => props.onToast(error instanceof Error ? error.message : '发送失败'),
  });

  const actionMutation = useMutation({
    mutationFn: (action: 'advance' | 'complete' | 'snooze' | 'skip') => {
      if (action === 'snooze') return csApi.snooze(props.persona.id, props.user.user_id, {});
      if (action === 'skip')
        return csApi.skip(props.persona.id, props.user.user_id, { reason: '客服判断无需继续沟通' });
      if (action === 'complete')
        return csApi.advance(props.persona.id, props.user.user_id, { status: 'completed' });
      const currentIndex = stages.findIndex(
        (stage) => stage.key === props.session?.current_question_key
      );
      const nextStage = stages[Math.min(currentIndex + 1, stages.length - 1)] ?? stages[0];
      return csApi.advance(props.persona.id, props.user.user_id, {
        next_stage: nextStage.key,
        next_question_key: nextStage.key,
        status: 'following_up',
      });
    },
    onSuccess: () => props.onChanged(),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '操作失败'),
  });

  const latestFailed = [...props.messages]
    .reverse()
    .find((message: CsMessageData) => message.send_status === 'failed');

  return (
    <div className="outreach-panel">
      <header className="conversation-header">
        <div>
          <p className="eyebrow">Telegram 1V1</p>
          <h2>{props.user.display_name}</h2>
          <p>
            {props.user.register_days}天 · {props.user.total_round}轮 · ¥
            {props.user.total_paid_amount} · {props.user.last_active_label}
          </p>
        </div>
        <span className="status-pill">{props.session?.status ?? 'not_started'}</span>
      </header>

      <section className="sop-card">
        <p className="eyebrow">当前 SOP 问题</p>
        <p>{currentPrompt}</p>
        <div className="prompt-grid">
          {stages.map((stage) => (
            <button key={stage.key} onClick={() => setSelectedPrompt(stage.prompt)}>
              {stage.title}
            </button>
          ))}
          {(
            stages.find((stage) => stage.key === props.session?.current_question_key)?.followups ??
            []
          ).map((followup) => (
            <button key={followup} onClick={() => setSelectedPrompt(followup)}>
              追问：{followup}
            </button>
          ))}
          {(stages.find((stage) => stage.key === 'feature')?.fallback_options ?? []).map(
            (option) => (
              <button key={option} onClick={() => setSelectedPrompt(option)}>
                {option}
              </button>
            )
          )}
        </div>
        <div className="action-row">
          <button onClick={() => actionMutation.mutate('advance')}>下一题</button>
          <button onClick={() => actionMutation.mutate('complete')}>完成</button>
          <button onClick={() => actionMutation.mutate('snooze')}>明日再触达</button>
          <button onClick={() => actionMutation.mutate('skip')}>跳过</button>
        </div>
      </section>

      <div className="message-list">
        {props.messages.map((message) => (
          <div key={message.id} className={`message ${message.direction}`}>
            <p>{message.content}</p>
            <small>
              {message.direction === 'agent' ? '客服' : '用户'} · {message.send_status}
              {message.failed_reason ? ` · ${message.failed_reason}` : ''}
            </small>
          </div>
        ))}
      </div>

      <footer className="composer">
        {latestFailed && (
          <button
            className="secondary-button"
            onClick={() =>
              csApi
                .retryMessage(props.persona.id, props.user.user_id, latestFailed.id)
                .then(props.onChanged)
                .catch((error) => props.onToast(error.message))
            }
          >
            重试失败消息
          </button>
        )}
        <textarea
          value={input || currentPrompt}
          onChange={(event) => {
            setSelectedPrompt(null);
            setInput(event.target.value);
          }}
        />
        <button
          className="primary-button"
          onClick={() => sendMutation.mutate((input || currentPrompt).trim())}
          disabled={sendMutation.isPending}
        >
          {sendMutation.isPending ? '发送中' : '发送到 Telegram'}
        </button>
      </footer>
    </div>
  );
}

function PersonaModal(props: {
  onClose: () => void;
  onCreated: (persona: CsPersonaData) => void;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [openingScript, setOpeningScript] = useState('');
  const [sql, setSql] = useState(DEFAULT_SQL);
  const createMutation = useMutation({
    mutationFn: () =>
      csApi.createPersona({
        name,
        description,
        opening_script: openingScript,
        sql,
        sop: DEFAULT_SOP,
      }),
    onSuccess: (data) => props.onCreated(data.persona),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '创建失败'),
  });

  return (
    <div className="modal-mask">
      <div className="modal">
        <header>
          <h2>新建画像簇</h2>
          <button onClick={props.onClose}>关闭</button>
        </header>
        <label>画像名称</label>
        <input value={name} onChange={(event) => setName(event.target.value)} />
        <label>描述</label>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
        <label>开场话术</label>
        <textarea
          value={openingScript}
          onChange={(event) => setOpeningScript(event.target.value)}
        />
        <label>SQL 规则，必须 SELECT user_id</label>
        <textarea
          className="sql-editor"
          value={sql}
          onChange={(event) => setSql(event.target.value)}
        />
        <button className="primary-button" onClick={() => createMutation.mutate()}>
          保存画像簇
        </button>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function normalizeSession(value: unknown) {
  return value as {
    status: string;
    current_stage: string | null;
    current_question_key: string | null;
    suggested_prompt: string | null;
  };
}
