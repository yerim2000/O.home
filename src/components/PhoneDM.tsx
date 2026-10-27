
"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLocalList } from "@/lib/useLocalList";
import { charGrant, type Character } from "@/lib/charStore";

type Member = {
  id: string;
  nickname: string;
  role?: string;
};

type DMMessage = {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  characterId: string;
  characterName: string;
  text: string;
  date: string;
};

const ROOM_KEY = "ohome.dm.rooms.v1";
const MESSAGE_KEY = "ohome.dm.messages.v1";
const MEMBER_KEY = "ohome.dm.members.v1";

type Room = {
  id: string;
  memberIds: string[];
};

export function PhoneDM() {
  const { user } = useAuth();

  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [targetId, setTargetId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [message, setMessage] = useState("");

  const [chars] = useLocalList<Character>(
    "ohome.chars.v1",
    []
  );

  useEffect(() => {
    try {
      setRooms(JSON.parse(localStorage.getItem(ROOM_KEY) || "[]"));
      setMessages(JSON.parse(localStorage.getItem(MESSAGE_KEY) || "[]"));
      setMembers(JSON.parse(localStorage.getItem(MEMBER_KEY) || "[]"));
    } catch {
      setRooms([]);
      setMessages([]);
      setMembers([]);
    }
  }, []);

  const availableChars = useMemo(() => {
    if (!user) return [];

    return chars.filter((c) => {
      // 본인 소유 캐릭터 또는 사용 권한을 받은 캐릭터
      return c.own || !!charGrant(c, user.id);
    });
  }, [chars, user]);

  const roomId = useMemo(() => {
    if (!user || !targetId || user.id === targetId) return "";

    return [user.id, targetId].sort().join("__");
  }, [user, targetId]);

  const roomMessages = messages.filter(
    (m) => m.roomId === roomId
  );

  function saveRooms(next: Room[]) {
    setRooms(next);
    localStorage.setItem(ROOM_KEY, JSON.stringify(next));
  }

  function saveMessages(next: DMMessage[]) {
    setMessages(next);
    localStorage.setItem(MESSAGE_KEY, JSON.stringify(next));
  }

  function sendMessage(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!user || !targetId || !roomId) return;
    if (!characterId || !message.trim()) return;

    const character = availableChars.find(
      (c) => c.id === characterId
    );

    if (!character) {
      alert("사용할 권한이 있는 캐릭터를 선택해 주세요.");
      return;
    }

    const nextRoom: Room = {
      id: roomId,
      memberIds: [user.id, targetId].sort(),
    };

    const nextRooms = [
      ...rooms.filter((r) => r.id !== roomId),
      nextRoom,
    ];

    const nextMessage: DMMessage = {
      id: crypto.randomUUID(),
      roomId,
      senderId: user.id,
      senderName: user.nickname,
      characterId: character.id,
      characterName: character.name,
      text: message.trim(),
      date: new Date().toISOString(),
    };

    saveRooms(nextRooms);
    saveMessages([...messages, nextMessage]);
    setMessage("");
  }

  if (!user) return null;

  return (
    <>
      <button
        className="dm-phone-button"
        onClick={() => setOpen((v) => !v)}
        aria-label="휴대폰 열기"
      >
        ☎
      </button>

      {open && (
        <aside className="dm-phone-panel">
          <header className="dm-phone-header">
            <strong>MESSAGES</strong>
            <button onClick={() => setOpen(false)}>×</button>
          </header>

          <label className="dm-label">대화 상대</label>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            <option value="">회원 선택</option>
            {members
              .filter((m) => m.id !== user.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nickname}
                </option>
              ))}
          </select>

          <label className="dm-label">보낼 캐릭터</label>
          <select
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
          >
            <option value="">캐릭터 선택</option>
            {availableChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="dm-chat-title">
            {members.find((m) => m.id === targetId)?.nickname
              ?? "대화 상대를 선택해 주세요"}
          </div>

          <div className="dm-messages">
            {roomMessages.map((m) => (
              <div
                key={m.id}
                className={
                  m.senderId === user.id
                    ? "dm-mine"
                    : "dm-theirs"
                }
              >
                <small>{m.characterName}</small>
                <div>{m.text}</div>
              </div>
            ))}
          </div>

          <form className="dm-compose" onSubmit={sendMessage}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="메시지 입력..."
            />
            <button type="submit">전송</button>
          </form>
        </aside>
      )}
    </>
  );
}
