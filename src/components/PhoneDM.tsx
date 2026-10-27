"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocalList } from "@/lib/postStore";
import { backend, isServerMode } from "@/lib/backend";
import { CHAR_SEED, type Character, charGrant } from "@/lib/charStore";

type Member = { id: string; nickname: string; role?: string };
type DMRoom = { id: string; memberIds: string[]; createdAt: string };
type DMMessage = {
  id: string;
  roomId: string;
  memberIds: string[];
  senderId: string;
  senderName: string;
  characterId: string;
  characterName: string;
  text: string;
  date: string;
};

const ROOM_KEY = "ohome.dm.rooms.v1";
const MESSAGE_KEY = "ohome.dm.messages.v1";

export function PhoneDM() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [targetId, setTargetId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [message, setMessage] = useState("");

  const [rooms, setRooms, roomsLoaded] = useLocalList<DMRoom>(ROOM_KEY, []);
  const [messages, setMessages, messagesLoaded] = useLocalList<DMMessage>(MESSAGE_KEY, []);
  const [chars] = useLocalList<Character>("ohome.chars.v1", CHAR_SEED);

  useEffect(() => {
    if (!open || !user) return;
    let alive = true;
    const be = backend();
    if (!be || !isServerMode()) {
      setMembers([]);
      setMemberError("회원 간 메시지를 사용하려면 서버 연결이 필요합니다.");
      return () => { alive = false; };
    }
    setMemberError("");
    void be.listMembers().then((rows) => {
      if (!alive) return;
      setMembers(rows.map((m) => ({ id: m.id, nickname: m.nickname, role: m.role })));
    }).catch(() => {
      if (!alive) return;
      setMembers([]);
      setMemberError("회원 목록을 불러오지 못했습니다. 서버 연결과 회원 프로필을 확인해 주세요.");
    });
    return () => { alive = false; };
  }, [open, user?.id]);

  const availableChars = useMemo(() => {
    if (!user) return [];
    return chars.filter((c) =>
      (user.role === "admin" && c.own) || !!charGrant(c, user.id)
    );
  }, [chars, user]);

  const roomId = useMemo(() => {
    if (!user || !targetId || user.id === targetId) return "";
    return "dm_" + [user.id, targetId].sort().join("__");
  }, [user, targetId]);

  const roomMessages = useMemo(() =>
    messages
      .filter((m) => m.roomId === roomId)
      .sort((a, b) => a.date.localeCompare(b.date)),
  [messages, roomId]);

  function sendMessage(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user || !targetId || !roomId || !roomsLoaded || !messagesLoaded) return;
    if (!characterId || !message.trim()) return;

    const character = availableChars.find((c) => c.id === characterId);
    if (!character) {
      alert("사용할 권한이 있는 캐릭터를 선택해 주세요.");
      return;
    }

    const memberIds = [user.id, targetId].sort();
    const now = new Date().toISOString();
    if (!rooms.some((r) => r.id === roomId)) {
      setRooms([...rooms, { id: roomId, memberIds, createdAt: now }]);
    }

    setMessages([...messages, {
      id: crypto.randomUUID(),
      roomId,
      memberIds,
      senderId: user.id,
      senderName: user.nickname,
      characterId: character.id,
      characterName: character.name,
      text: message.trim(),
      date: now,
    }]);
    setMessage("");
  }

  if (!user) return null;

  return (
    <>
      <button className="dm-phone-button" onClick={() => setOpen((v) => !v)} aria-label="휴대폰 열기">☎</button>
      {open && (
        <aside className="dm-phone-panel">
          <header className="dm-phone-header">
            <strong>MESSAGES</strong>
            <button onClick={() => setOpen(false)}>×</button>
          </header>

          <label className="dm-label">대화 상대</label>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">회원 선택</option>
            {members.filter((m) => m.id !== user.id).map((m) =>
              <option key={m.id} value={m.id}>{m.nickname}</option>
            )}
          </select>
          {memberError && <small role="status">{memberError}</small>}

          <label className="dm-label">보낼 캐릭터</label>
          <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
            <option value="">캐릭터 선택</option>
            {availableChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {availableChars.length === 0 && <small>사용 권한이 있는 캐릭터가 없습니다.</small>}

          <div className="dm-chat-title">
            {members.find((m) => m.id === targetId)?.nickname ?? "대화 상대를 선택해 주세요"}
          </div>

          <div className="dm-messages">
            {roomMessages.map((m) => (
              <div key={m.id} className={m.senderId === user.id ? "dm-mine" : "dm-theirs"}>
                <small>{m.characterName}</small>
                <div>{m.text}</div>
              </div>
            ))}
            {targetId && roomMessages.length === 0 && messagesLoaded && <small>아직 메시지가 없습니다.</small>}
          </div>

          <form className="dm-compose" onSubmit={sendMessage}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="메시지 입력..."
              disabled={!targetId || !characterId || !messagesLoaded || !roomsLoaded}
            />
            <button type="submit" disabled={!targetId || !characterId || !message.trim() || !messagesLoaded || !roomsLoaded}>전송</button>
          </form>
        </aside>
      )}
    </>
  );
}
