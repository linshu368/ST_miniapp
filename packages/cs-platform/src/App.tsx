import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CsPersonaData, CsUserData } from '@miniapp/shared';
import { csApi, getCsAdminToken, setCsAdminToken } from './api';
import type { Membership } from './constants';
import { LoginPage } from './components/LoginPage';
import { PersonaSidebar } from './components/PersonaSidebar';
import { UserListPanel } from './components/UserListPanel';
import { ConversationPanel } from './components/ConversationPanel';
import { PersonaModal } from './components/PersonaModal';

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

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const personasQuery = useQuery({
    queryKey: ['cs', 'personas', authToken],
    queryFn: csApi.personas,
    enabled: !!authToken,
    refetchInterval: 15_000,
  });
  const personas = personasQuery.data?.personas ?? [];
  const selectedPersona =
    personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0] ?? null;

  const usersQuery = useQuery({
    queryKey: ['cs', 'users', selectedPersona?.id],
    queryFn: () => csApi.users(selectedPersona!.id),
    enabled: !!selectedPersona,
    refetchInterval: selectedPersona ? 10_000 : false,
  });

  const sessionQuery = useQuery({
    queryKey: ['cs', 'session', selectedPersona?.id, selectedUser?.user.user_id],
    queryFn: () => csApi.session(selectedPersona!.id, selectedUser!.user.user_id),
    enabled: !!selectedPersona && !!selectedUser,
    refetchInterval: selectedPersona && selectedUser ? 5_000 : false,
  });

  const messagesQuery = useQuery({
    queryKey: ['cs', 'messages', selectedPersona?.id, selectedUser?.user.user_id],
    queryFn: () => csApi.messages(selectedPersona!.id, selectedUser!.user.user_id),
    enabled: !!selectedPersona && !!selectedUser,
    refetchInterval: selectedUser ? 3_000 : false,
  });

  const refreshMutation = useMutation({
    mutationFn: (personaId: string) => csApi.refreshPersona(personaId),
    onSuccess: (data) => {
      setToast(`刷新完成：${data.active_count} 当前在簇，${data.chatted_left_count} 已聊移出`);
      void qc.invalidateQueries({ queryKey: ['cs'] });
    },
    onError: (error) => setToast(error instanceof Error ? error.message : '刷新失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (persona: CsPersonaData) => csApi.deletePersona(persona.id),
    onSuccess: (data) => {
      setToast(`已删除画像簇：${data.persona.name}`);
      setSelectedPersonaId(null);
      setSelectedUser(null);
      void qc.invalidateQueries({ queryKey: ['cs'] });
    },
    onError: (error) => setToast(error instanceof Error ? error.message : '删除失败'),
  });

  const handleDeletePersona = (persona: CsPersonaData) => {
    const confirmed = window.confirm(
      `确认删除画像簇「${persona.name}」？\n\n删除后不会物理清除历史回访和审计记录，但该画像簇会从列表中隐藏。`
    );
    if (!confirmed) return;
    deleteMutation.mutate(persona);
  };

  const handleLogout = () => {
    setCsAdminToken('');
    setAuthToken('');
    setSelectedPersonaId(null);
    setSelectedUser(null);
    qc.removeQueries({ queryKey: ['cs'] });
  };

  const invalidateConversation = () => {
    if (!selectedPersona || !selectedUser) return;
    void qc.invalidateQueries({
      queryKey: ['cs', 'messages', selectedPersona.id, selectedUser.user.user_id],
    });
    void qc.invalidateQueries({
      queryKey: ['cs', 'session', selectedPersona.id, selectedUser.user.user_id],
    });
    void qc.invalidateQueries({ queryKey: ['cs', 'users', selectedPersona.id] });
  };

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
      <PersonaSidebar
        personas={personas}
        selectedId={selectedPersona?.id ?? null}
        isLoading={personasQuery.isLoading}
        errorMessage={personasQuery.isError ? String(personasQuery.error.message) : null}
        onSelect={(id) => {
          setSelectedPersonaId(id);
          setSelectedUser(null);
        }}
        onCreate={() => setShowPersonaModal(true)}
        onLogout={handleLogout}
      />

      {selectedPersona ? (
        <UserListPanel
          persona={selectedPersona}
          activeUsers={usersQuery.data?.active ?? []}
          chattedLeftUsers={usersQuery.data?.chatted_left ?? []}
          isLoading={usersQuery.isLoading}
          selectedUserId={selectedUser?.user.user_id}
          refreshPending={refreshMutation.isPending}
          deletePending={deleteMutation.isPending}
          onSelect={(user, membership) => setSelectedUser({ user, membership })}
          onRefresh={() => refreshMutation.mutate(selectedPersona.id)}
          onExport={() =>
            csApi
              .exportPersona(selectedPersona.id, selectedPersona.name)
              .catch((error) => setToast(error.message))
          }
          onDelete={() => handleDeletePersona(selectedPersona)}
        />
      ) : (
        <section className="user-panel">
          <EmptyState text="暂无画像簇，先在左侧新建一个。" />
        </section>
      )}

      <div className="conversation-column">
        {selectedPersona && selectedUser ? (
          <ConversationPanel
            persona={selectedPersona}
            user={selectedUser.user}
            messages={messagesQuery.data?.messages ?? []}
            session={sessionQuery.data?.session ?? null}
            onChanged={invalidateConversation}
            onToast={setToast}
          />
        ) : (
          <EmptyState text="从中间列表选择用户，开始 Telegram 1V1 回访" />
        )}
      </div>

      {showPersonaModal && (
        <PersonaModal
          onClose={() => setShowPersonaModal(false)}
          onCreated={(persona) => {
            setShowPersonaModal(false);
            setSelectedPersonaId(persona.id);
            setToast(`已创建画像簇：${persona.name}`);
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

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}
