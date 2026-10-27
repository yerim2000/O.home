"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { useLocalList } from "@/lib/postStore";
import { backend, isServerMode } from "@/lib/backend";
import { fetchList, subscribeTable, syncList } from "@/lib/db";
import { useToast } from "@/components/ui/Toast";
import { pushNotif } from "@/lib/notifStore";
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
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [dmError, setDmError] = useState("");
  const [targetId, setTargetId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [message, setMessage] = useState("");
  const [rooms, setRooms] = useState<DMRoom[]>([]);
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [dmLoaded, setDmLoaded] = useState(false);
  const [arrival, setArrival] = useState<DMMessage | null>(null);
  const [unread, setUnread] = useState<DMMessage[]>([]);
  const seenMessages = useRef<Set<string>>(new Set());
  const initialMessageLoad = useRef(false);
  const [chars] = useLocalList<Character>("ohome.chars.v1", CHAR_SEED);

  // 실제 서버 읽기와 구독을 DM 컴포넌트에서 직접 관리한다.
  // 쓰기 실패를 조용히 낙관적 UI로 남기지 않고, 서버에 저장된 경우에만 성공 처리한다.
  const refreshDM = useCallback(async () => {
    const be = backend();
    if (!isServerMode() || !be) {
      const readLocal = <T,>(key: string): T[] => {
        try { return JSON.parse(localStorage.getItem(key) || "[]") as T[]; }
        catch { return []; }
      };
      setRooms(readLocal<DMRoom>(ROOM_KEY));
      setMessages(readLocal<DMMessage>(MESSAGE_KEY));
      setDmLoaded(true);
      return;
    }
    if (be.kind !== "firebase") {
      setDmError("현재 DM 서버 연결은 Firebase 모드에서만 지원됩니다.");
      setDmLoaded(true);
      return;
    }
    const [nextRooms, nextMessages] = await Promise.all([
      fetchList<DMRoom>("dm_rooms"),
      fetchList<DMMessage>("dm_messages"),
    ]);
    setRooms(nextRooms);
    setMessages(nextMessages);
    setDmError("");
    setDmLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    let requestNo = 0;
    const load = async () => {
      const thisRequest = ++requestNo;
      try {
        await refreshDM();
      } catch (error) {
        if (!alive || thisRequest !== requestNo) return;
        const detail = error instanceof Error ? error.message : String(error);
        setDmError("메시지를 불러오지 못했습니다: " + detail);
        setDmLoaded(true);
      }
    };
    void load();
    const be = backend();
    if (isServerMode() && be?.kind === "firebase") {
      const offMessages = subscribeTable("dm_messages", () => { void load(); });
      const offRooms = subscribeTable("dm_rooms", () => { void load(); });
      return () => { alive = false; offMessages(); offRooms(); };
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === ROOM_KEY || event.key === MESSAGE_KEY) void load();
    };
    window.addEventListener("storage", onStorage);
    return () => { alive = false; window.removeEventListener("storage", onStorage); };
  }, [user?.id, refreshDM]);

  useEffect(() => {
    if (!open || !user) return;
    let alive = true;
    const be = backend();
    if (!be || !isServerMode()) {
      setMembers([]);
      setMemberError("회원 간 메시지를 사용하려면 Firebase 서버 연결이 필요합니다.");
      return () => { alive = false; };
    }
    setMemberError("");
    void be.listMembers().then((rows) => {
      if (!alive) return;
      setMembers(rows.map((m) => ({ id: m.id, nickname: m.nickname, role: m.role })));
    }).catch(() => {
      if (!alive) return;
      setMembers([]);
      setMemberError("회원 목록을 불러오지 못했습니다. Firebase 연결과 회원 프로필을 확인해 주세요.");
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
    messages.filter((m) => m.roomId === roomId).sort((a, b) => a.date.localeCompare(b.date)),
  [messages, roomId]);

  // 초기 로딩 메시지를 새 알림으로 오인하지 않는다. 이후 들어온 상대방 메시지만 알린다.
  useEffect(() => {
    if (!dmLoaded || !user) return;
    if (!initialMessageLoad.current) {
      messages.forEach((m) => seenMessages.current.add(m.id));
      initialMessageLoad.current = true;
      return;
    }
    const fresh = messages.filter((m) => !seenMessages.current.has(m.id));
    fresh.forEach((m) => seenMessages.current.add(m.id));
    const incoming = fresh.filter((m) => m.senderId !== user.id);
    if (incoming.length) {
      const latest = incoming[incoming.length - 1];
      setArrival(latest);
      setUnread((current) => {
        const known = new Set(current.map((m) => m.id));
        return [...current, ...incoming.filter((m) => !known.has(m.id))].slice(-9);
      });
      toast("새 메시지: " + latest.characterName);
    }
  }, [messages, dmLoaded, user?.id, toast]);

  async function sendMessage(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user || !targetId || !roomId || !dmLoaded || !characterId || !message.trim()) return;
    const character = availableChars.find((c) => c.id === characterId);
    if (!character) {
      setDmError("사용할 권한이 있는 캐릭터를 선택해 주세요.");
      return;
    }
    const be = backend();
    if (!isServerMode() || !be || be.kind !== "firebase") {
      setDmError("서버 저장을 사용할 수 없습니다. Firebase 연결 상태를 확인해 주세요.");
      return;
    }

    const memberIds = [user.id, targetId].sort();
    const now = new Date().toISOString();
    const nextRoom: DMRoom = { id: roomId, memberIds, createdAt: rooms.find((r) => r.id === roomId)?.createdAt ?? now };
    const nextRooms = rooms.some((r) => r.id === roomId) ? rooms : [...rooms, nextRoom];
    const nextMessage: DMMessage = {
      id: crypto.randomUUID(),
      roomId,
      memberIds,
      senderId: user.id,
      senderName: user.nickname,
      characterId: character.id,
      characterName: character.name,
      text: message.trim(),
      date: now,
    };

    setDmError("");
    try {
      if (!rooms.some((r) => r.id === roomId)) {
        await syncList("dm_rooms", rooms, nextRooms, user.id);
      }
      await syncList("dm_messages", messages, [...messages, nextMessage], user.id);
      setRooms(nextRooms);
      setMessages((current) => current.some((m) => m.id === nextMessage.id) ? current : [...current, nextMessage]);
      setMessage("");
      // 기존 사이트 알림 종에도 도착 알림을 저장한다.
      pushNotif({
        type: "rp",
        toUserId: targetId,
        title: "새 메시지가 도착했습니다",
        body: character.name + ": " + nextMessage.text.slice(0, 100),
        href: "/",
        dedupeKey: "dm:" + roomId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDmError("메시지를 서버에 저장하지 못했습니다: " + detail);
      toast("메시지 전송 실패 — 오류 내용을 확인해 주세요.");
    }
  }

  function openArrival() {
    if (!arrival) return;
    setTargetId(arrival.senderId);
    setOpen(true);
    setUnread((items) => items.filter((m) => m.senderId !== arrival.senderId));
    setArrival(null);
  }

  if (!user) return null;

  return (
    <>
      <button
        className="dm-phone-button"
        onClick={() => { setOpen((value) => !value); setArrival(null); }}
        aria-label="메시지 열기"
        title="Messages"
      >
        <span aria-hidden="true">☎</span>
        {unread.length > 0 && <i className="dm-unread-badge">{unread.length > 9 ? "9+" : unread.length}</i>}
      </button>

      {arrival && (
        <div className="dm-arrival-toast" role="status">
          <button className="dm-arrival-main" onClick={openArrival}>
            <span className="dm-arrival-mark">✉</span>
            <span className="dm-arrival-copy">
              <b>NEW MESSAGE</b>
              <strong>{arrival.senderName}</strong>
              <small>{arrival.characterName}: {arrival.text}</small>
            </span>
          </button>
          <button className="dm-arrival-close" aria-label="알림 닫기" onClick={() => setArrival(null)}>×</button>
        </div>
      )}

      {open && (
        <aside className="dm-phone-panel">
          <header className="dm-phone-header">
            <div className="dm-heading">
              <small>DAKIN / PRIVATE LINE</small>
              <strong>MESSAGES</strong>
            </div>
            <button className="dm-close" onClick={() => setOpen(false)} aria-label="닫기">×</button>
          </header>

          <div className="dm-config">
            <label className="dm-field">
              <span>대화 상대</span>
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">회원 선택</option>
                {members.filter((m) => m.id !== user.id).map((m) =>
                  <option key={m.id} value={m.id}>{m.nickname}</option>
                )}
              </select>
            </label>
            <label className="dm-field">
              <span>보낼 캐릭터</span>
              <select value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                <option value="">캐릭터 선택</option>
                {availableChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>

          {memberError && <p className="dm-inline-error">{memberError}</p>}
          {dmError && <p className="dm-inline-error">{dmError}</p>}
          {availableChars.length === 0 && <p className="dm-inline-note">사용 권한이 있는 캐릭터가 없습니다.</p>}

          <div className="dm-chat-title">
            <div>
              <small>PRIVATE THREAD</small>
              <strong>{members.find((m) => m.id === targetId)?.nickname ?? "대화 상대를 선택해 주세요"}</strong>
            </div>
            <span>{roomMessages.length.toString().padStart(2, "0")} MSG</span>
          </div>

          <div className="dm-messages" aria-live="polite">
            {!dmLoaded && <p className="dm-empty">메시지를 불러오는 중입니다…</p>}
            {roomMessages.map((m) => (
              <div key={m.id} className={"dm-message " + (m.senderId === user.id ? "dm-mine" : "dm-theirs")}>
                <small>{m.characterName} <time>{new Date(m.date).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</time></small>
                <div>{m.text}</div>
              </div>
            ))}
            {targetId && roomMessages.length === 0 && dmLoaded && (
              <div className="dm-empty">아직 메시지가 없습니다.<small>첫 메시지를 보내 대화를 시작하세요.</small></div>
            )}
            {!targetId && dmLoaded && (
              <div className="dm-empty">대화 상대를 선택해 주세요.<small>메시지 기록은 계정 간에 동기화됩니다.</small></div>
            )}
          </div>

          <form className="dm-compose" onSubmit={sendMessage}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="메시지 입력..."
              disabled={!targetId || !characterId || !dmLoaded}
            />
            <button type="submit" disabled={!targetId || !characterId || !message.trim() || !dmLoaded}>전송 <span aria-hidden="true">↗</span></button>
          </form>
        </aside>
      )}
    </>
  );
}
