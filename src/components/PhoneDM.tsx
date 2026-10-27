"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { useLocalList } from "@/lib/postStore";
import { backend, isServerMode } from "@/lib/backend";
import { fetchList, subscribeTable, syncList } from "@/lib/db";
import { useToast } from "@/components/ui/Toast";
import { pushNotif } from "@/lib/notifStore";
import { CroppedBlobImg } from "@/components/ui/CropEditor";
import { CHAR_SEED, type Character, charGrant } from "@/lib/charStore";

type Member = { id: string; nickname: string; role?: string };
type ParticipantCharacter = { userId: string; characterId: string; characterName: string };
type DMRoom = {
  id: string;
  memberIds: string[];
  createdAt: string;
  /** 각 회원이 지정한 대화방 제목 — 상대방의 표시 이름은 바꾸지 않는다. */
  titleByUser?: Record<string, string>;
  /** 회원별 삭제 시각 — 삭제 이후 메시지가 오면 채팅 목록에 다시 나타난다. */
  deletedAtBy?: Record<string, string>;
  // 새 대화: 회원이 아니라 두 캐릭터의 조합으로 방을 식별한다.
  characters?: ParticipantCharacter[];
};
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
type ChatEntry = {
  room: DMRoom;
  contact: Contact;
  displayName: string;
  myCharacterName: string;
  last?: DMMessage;
  unread: number;
  sortDate: string;
};

type Contact = {
  key: string;
  targetId: string;
  characterId: string;
  name: string;
  color: string;
  character?: Character;
  legacyRoomId?: string;
  active: boolean;
};

const ROOM_KEY = "ohome.dm.rooms.v1";
const MESSAGE_KEY = "ohome.dm.messages.v1";
const seenKey = (uid: string) => "ohome.dm.seen.v2:" + uid;

function conversationId(myUid: string, myChar: string, otherUid: string, otherChar: string) {
  const pair = [
    { uid: myUid, char: myChar },
    { uid: otherUid, char: otherChar },
  ].sort((a, b) => a.uid.localeCompare(b.uid));
  return "dm2_" + pair.map((p) =>
    encodeURIComponent(p.uid) + "_" + encodeURIComponent(p.char)
  ).join("__");
}
function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}
function displayTime(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function ContactPortrait({ contact, small = false }: { contact: Contact; small?: boolean }) {
  const ch = contact.character;
  const picture = ch?.thumbId ?? ch?.arts?.[0];
  return (
    <span
      className={"dm-portrait" + (small ? " dm-portrait-small" : "")}
      style={{ "--dm-color": contact.color } as React.CSSProperties}
      aria-hidden="true"
    >
      {picture ? (
        <CroppedBlobImg fileRef={picture} crop={ch?.thumbCrop} />
      ) : (
        <span>{contact.legacyRoomId && !contact.character ? "↶" : initials(contact.name)}</span>
      )}
    </span>
  );
}

export function PhoneDM() {
  const { user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<"contacts" | "chats" | "chat">("chats");
  const [backScreen, setBackScreen] = useState<"contacts" | "chats">("chats");
  const [queryText, setQueryText] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [dmError, setDmError] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [historicContact, setHistoricContact] = useState<Contact | null>(null);
  const [activeRoomOverride, setActiveRoomOverride] = useState("");
  const [senderCharacterId, setSenderCharacterId] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [manageRoomId, setManageRoomId] = useState("");
  const [manageStep, setManageStep] = useState<"options" | "rename" | "delete">("options");
  const [renameDraft, setRenameDraft] = useState("");
  const [manageBusy, setManageBusy] = useState(false);
  const [manageError, setManageError] = useState("");
  const [rooms, setRooms] = useState<DMRoom[]>([]);
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [dmLoaded, setDmLoaded] = useState(false);
  const [arrival, setArrival] = useState<DMMessage | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>({});
  const seenMessageIds = useRef<Set<string>>(new Set());
  const initialMessageLoad = useRef(false);
  const [chars] = useLocalList<Character>("ohome.chars.v1", CHAR_SEED);

  const refreshDM = useCallback(async () => {
    const be = backend();
    if (!isServerMode() || !be || be.kind !== "firebase") {
      setDmError("메시지 기능에는 Firebase 연결이 필요합니다.");
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
    initialMessageLoad.current = false;
    seenMessageIds.current = new Set();
    setDmLoaded(false);
    setRooms([]);
    setMessages([]);
    setArrival(null);
    setScreen("chats");
    setActiveKey("");
    setHistoricContact(null);
    setActiveRoomOverride("");
    setManageRoomId("");
    setManageError("");
    if (!user) { setSeen({}); return; }
    try { setSeen(JSON.parse(localStorage.getItem(seenKey(user.id)) || "{}")); }
    catch { setSeen({}); }

    let alive = true;
    let serial = 0;
    const load = async () => {
      const id = ++serial;
      try {
        const be = backend();
        if (!be || be.kind !== "firebase") {
          if (alive) { setDmError("Firebase 연결이 필요합니다."); setDmLoaded(true); }
          return;
        }
        const [nextRooms, nextMessages] = await Promise.all([
          fetchList<DMRoom>("dm_rooms"), fetchList<DMMessage>("dm_messages"),
        ]);
        if (!alive || id !== serial) return;
        setRooms(nextRooms);
        setMessages(nextMessages);
        setDmLoaded(true);
        setDmError("");
      } catch (err) {
        if (!alive || id !== serial) return;
        setDmError("대화를 불러오지 못했습니다: " + (err instanceof Error ? err.message : String(err)));
        setDmLoaded(true);
      }
    };
    void load();
    const offRooms = subscribeTable("dm_rooms", () => void load());
    const offMessages = subscribeTable("dm_messages", () => void load());
    return () => { alive = false; offRooms(); offMessages(); };
  }, [user?.id]);

  useEffect(() => {
    if (!open || !user) return;
    const be = backend();
    if (!be || !isServerMode()) {
      setMemberError("Firebase 연결이 필요합니다.");
      return;
    }
    let alive = true;
    setMemberError("");
    void be.listMembers().then((list) => {
      if (alive) setMembers(list.map((m) => ({ id: m.id, nickname: m.nickname, role: m.role })));
    }).catch(() => {
      if (alive) setMemberError("전화번호부를 불러오지 못했습니다.");
    });
    return () => { alive = false; };
  }, [open, user?.id]);

  const ownCharacters = useMemo(() => {
    if (!user) return [];
    // 관리자도 own 플래그만으로 발화할 수 없으며, 모든 회원은 명시적 grants가 필요하다.
    return chars.filter((c) => !!charGrant(c, user.id));
  }, [chars, user]);

  // 연락처 목록: 캐릭터의 '회원 권한'에 직접 등록된 계정만 수신자로 표시한다.
  // own 플래그 및 관리자 역할은 자동 캐릭터 사용 권한이 아니다.
  const contacts = useMemo(() => {
    if (!user) return [] as Contact[];
    const validMembers = new Set(members.map((m) => m.id));
    const map = new Map<string, Contact>();
    for (const c of chars) {
      for (const grant of c.grants ?? []) {
        const uid = grant.userId;
        if (!uid || uid === user.id || !validMembers.has(uid)) continue;
        if (grant.level !== "play" && grant.level !== "edit") continue;
        const key = uid + "|" + c.id;
        map.set(key, {
          key, targetId: uid, characterId: c.id,
          name: c.name, color: c.color || "#9a9da3", character: c, active: true,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [chars, members, user?.id]);

  const contactRooms = useCallback((contact: Contact) => rooms.filter((r) => {
    if (contact.legacyRoomId) return r.id === contact.legacyRoomId;
    return r.memberIds.includes(user?.id ?? "") && r.characters?.some(
      (p) => p.userId === contact.targetId && p.characterId === contact.characterId
    );
  }), [rooms, user?.id]);

  // '채팅'은 실제 대화방마다 한 항목씩 표시한다.
  // 회원 권한이 해제되어도 과거 대화는 읽을 수 있지만 새 발신은 막힌다.
  const chatEntries = useMemo(() => {
    if (!user) return [] as ChatEntry[];
    const list: ChatEntry[] = [];
    for (const room of rooms) {
      if (!room.memberIds.includes(user.id)) continue;
      const otherId = room.memberIds.find((uid) => uid !== user.id);
      if (!otherId) continue;

      const roomMsgs = messages.filter((m) => m.roomId === room.id)
        .sort((a, b) => b.date.localeCompare(a.date));
      const last = roomMsgs[0];
      const deletedAt = room.deletedAtBy?.[user.id] ?? "";
      // DELETE는 내 채팅 목록에서만 숨긴다. 삭제 뒤 상대가 새 문자를 보내면 다시 표시한다.
      if (deletedAt && (last?.date ?? room.createdAt) <= deletedAt) continue;

      const other = room.characters?.find((p) => p.userId === otherId);
      const mine = room.characters?.find((p) => p.userId === user.id);
      const otherChar = chars.find((c) => c.id === other?.characterId);
      // 구버전 회원 단위 대화방에는 수신 캐릭터 ID가 없다.
      // 상대방이 발화한 캐릭터가 있으면 그걸 사용하고, 없으면 상대가 관리하는
      // 캐릭터가 딱 하나일 때에만 유추한다. 엉뚱한 내 캐릭터로 표시하지 않는다.
      const otherSpeech = roomMsgs.find((m) => m.senderId === otherId && !!m.characterName);
      const grantedToOther = chars.filter((c) => !!charGrant(c, otherId));
      const inferred = otherSpeech
        ? chars.find((c) => c.id === otherSpeech.characterId)
        : grantedToOther.length === 1 ? grantedToOther[0] : undefined;
      const inferredName = inferred?.name ?? otherSpeech?.characterName;
      const key = other ? otherId + "|" + other.characterId : "legacy:" + room.id;
      const allowTarget = !!otherChar && !!charGrant(otherChar, otherId);
      const contact = contacts.find((c) => c.key === key) ?? {
        key, targetId: otherId, characterId: other?.characterId ?? inferred?.id ?? "",
        name: otherChar?.name ?? other?.characterName ?? inferredName ?? "상대 캐릭터",
        color: otherChar?.color ?? inferred?.color ?? "#858b95",
        character: otherChar ?? inferred,
        active: allowTarget,
        legacyRoomId: other ? undefined : room.id,
      };

      const myCharacter = chars.find((c) => c.id === mine?.characterId);
      const boundary = deletedAt > (seen[room.id] ?? "") ? deletedAt : (seen[room.id] ?? "");
      list.push({
        room, contact, last,
        displayName: room.titleByUser?.[user.id]?.trim() || contact.name,
        myCharacterName: myCharacter?.name ?? mine?.characterName ?? "",
        unread: roomMsgs.filter((m) => m.senderId !== user.id && m.date > boundary).length,
        sortDate: last?.date ?? room.createdAt,
      });
    }
    return list.sort((a, b) => b.sortDate.localeCompare(a.sortDate));
  }, [rooms, messages, chars, contacts, seen, user?.id]);

  const searchedContacts = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return contacts.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [contacts, queryText]);

  const searchedChats = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return chatEntries.filter((entry) =>
      !q || entry.displayName.toLowerCase().includes(q) ||
      entry.myCharacterName.toLowerCase().includes(q) ||
      (entry.last?.text ?? "").toLowerCase().includes(q)
    );
  }, [chatEntries, queryText]);

  const activeContact = contacts.find((c) => c.key === activeKey) ??
    (historicContact?.key === activeKey ? historicContact : null);
  const sender = ownCharacters.find((c) => c.id === senderCharacterId);
  const activeRoomId = useMemo(() => {
    if (!user || !activeContact) return "";
    if (activeRoomOverride) return activeRoomOverride;
    if (activeContact.legacyRoomId) return activeContact.legacyRoomId;
    if (!sender) return "";
    return conversationId(user.id, sender.id, activeContact.targetId, activeContact.characterId);
  }, [user?.id, activeContact?.key, sender?.id, activeRoomOverride]);

  const roomMessages = useMemo(() =>
    messages.filter((m) => m.roomId === activeRoomId).sort((a, b) => a.date.localeCompare(b.date)),
  [messages, activeRoomId]);
  const activeRoomName = chatEntries.find((e) => e.room.id === activeRoomId)?.displayName
    ?? activeContact?.name ?? "MESSAGE";

  // 삭제한 대화방의 옛 메시지는 읽지 않음 표시에서 제외한다.
  const unreadCount = messages.filter((m) => {
    if (!user || m.senderId === user.id) return false;
    const deletedAt = rooms.find((r) => r.id === m.roomId)?.deletedAtBy?.[user.id] ?? "";
    const boundary = deletedAt > (seen[m.roomId] ?? "") ? deletedAt : (seen[m.roomId] ?? "");
    return m.date > boundary;
  }).length;

  const markSeen = useCallback((roomId: string) => {
    if (!user || !roomId) return;
    const latest = messages.filter((m) => m.roomId === roomId)
      .sort((a, b) => b.date.localeCompare(a.date))[0]?.date;
    if (!latest || latest <= (seen[roomId] ?? "")) return;
    const next = { ...seen, [roomId]: latest };
    setSeen(next);
    try { localStorage.setItem(seenKey(user.id), JSON.stringify(next)); }
    catch { /* 기기 저장이 차단됐으면 현재 화면에서만 유지 */ }
  }, [messages, seen, user?.id]);

  useEffect(() => {
    if (open && screen === "chat" && activeRoomId) markSeen(activeRoomId);
  }, [open, screen, activeRoomId, roomMessages.length, markSeen]);

  // 처음 읽어 온 기록은 새 메시지 팝업을 띄우지 않는다.
  useEffect(() => {
    if (!dmLoaded || !user) return;
    if (!initialMessageLoad.current) {
      messages.forEach((m) => seenMessageIds.current.add(m.id));
      initialMessageLoad.current = true;
      return;
    }
    const fresh = messages.filter((m) => !seenMessageIds.current.has(m.id));
    fresh.forEach((m) => seenMessageIds.current.add(m.id));
    const incoming = fresh.filter((m) =>
      m.senderId !== user.id && !(open && screen === "chat" && m.roomId === activeRoomId)
    );
    if (incoming.length) {
      const latest = incoming[incoming.length - 1];
      setArrival(latest);
      toast("새 문자 메시지가 도착했습니다.");
    }
  }, [messages, dmLoaded, user?.id, open, screen, activeRoomId, toast]);

  function chooseContact(
    contact: Contact,
    preferredSenderId?: string,
    back: "contacts" | "chats" = "contacts",
  ) {
    if (!contact.legacyRoomId) {
      const previous = contactRooms(contact)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      const oldCharId = previous?.characters?.find((p) => p.userId === user?.id)?.characterId;
      const preferred =
        ownCharacters.find((c) => c.id === preferredSenderId) ??
        ownCharacters.find((c) => c.id === oldCharId) ??
        ownCharacters.find((c) => c.id === senderCharacterId) ??
        ownCharacters[0];
      setSenderCharacterId(preferred?.id ?? "");
    }
    setHistoricContact(null);
    setActiveRoomOverride("");
    setBackScreen(back);
    setActiveKey(contact.key);
    setMessage("");
    setDmError("");
    setScreen("chat");
    setArrival(null);
  }

  function openChatEntry(entry: ChatEntry) {
    const ownPart = entry.room.characters?.find((p) => p.userId === user?.id);
    const canContinue = entry.contact.active &&
      !!ownCharacters.find((c) => c.id === ownPart?.characterId) &&
      !entry.contact.legacyRoomId;

    if (canContinue) {
      chooseContact(entry.contact, ownPart?.characterId, "chats");
      return;
    }

    // 권한이 사라졌거나 예전 형식의 채팅방: 대화 기록만 보여 준다.
    setHistoricContact(entry.contact);
    setActiveRoomOverride(entry.room.id);
    setSenderCharacterId(ownPart?.characterId ?? "");
    setActiveKey(entry.contact.key);
    setBackScreen("chats");
    setMessage("");
    setDmError("");
    setScreen("chat");
    setArrival(null);
  }

  function openArrival() {
    if (!arrival || !user) return;
    const entry = chatEntries.find((e) => e.room.id === arrival.roomId);
    setOpen(true);
    if (entry) openChatEntry(entry);
    else setScreen("chats");
    setArrival(null);
  }

  // 우클릭 또는 ··· 버튼으로 대화방 메뉴를 연다. 같은 메뉴를 모바일에서도 사용한다.
  function openRoomMenu(roomId: string) {
    setManageRoomId(roomId);
    setManageStep("options");
    setRenameDraft("");
    setManageError("");
  }

  function closeRoomMenu() {
    if (manageBusy) return;
    setManageRoomId("");
    setManageError("");
  }

  const managedEntry = chatEntries.find((e) => e.room.id === manageRoomId);

  async function saveRoomName(useDefault = false) {
    if (!user || !managedEntry || manageBusy) return;
    const title = useDefault ? "" : renameDraft.trim();
    if (!useDefault && !title) {
      setManageError("채팅방 이름을 입력해 주세요.");
      return;
    }
    const be = backend();
    if (!be?.updateDmRoomPersonal) {
      setManageError("Firebase 연결 상태를 확인해 주세요.");
      return;
    }
    setManageBusy(true);
    setManageError("");
    try {
      await be.updateDmRoomPersonal(manageRoomId, "rename", title);
      setRooms((current) => current.map((r) => {
        if (r.id !== manageRoomId) return r;
        const byUser = { ...(r.titleByUser ?? {}) };
        if (title) byUser[user.id] = title.slice(0, 60);
        else delete byUser[user.id];
        return { ...r, titleByUser: byUser };
      }));
      toast(title ? "채팅방 이름을 변경했습니다." : "기본 이름으로 되돌렸습니다.");
      setManageRoomId("");
    } catch (error) {
      setManageError("변경 실패: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setManageBusy(false);
    }
  }

  async function deleteRoomForMe() {
    if (!user || !managedEntry || manageBusy) return;
    const be = backend();
    if (!be?.updateDmRoomPersonal) {
      setManageError("Firebase 연결 상태를 확인해 주세요.");
      return;
    }
    setManageBusy(true);
    setManageError("");
    const roomId = manageRoomId;
    try {
      await be.updateDmRoomPersonal(roomId, "delete");
      const deletedAt = new Date().toISOString();
      setRooms((current) => current.map((r) =>
        r.id === roomId
          ? { ...r, deletedAtBy: { ...(r.deletedAtBy ?? {}), [user.id]: deletedAt } }
          : r
      ));
      setSeen((current) => {
        const next = { ...current, [roomId]: deletedAt };
        try { localStorage.setItem(seenKey(user.id), JSON.stringify(next)); }
        catch { /* 기기 저장이 차단된 경우 */ }
        return next;
      });
      setArrival((current) => current?.roomId === roomId ? null : current);
      if (activeRoomId === roomId) setScreen("chats");
      setManageRoomId("");
      toast("채팅방을 내 목록에서 삭제했습니다.");
    } catch (error) {
      setManageError("삭제 실패: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setManageBusy(false);
    }
  }

  async function sendMessage(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user || !activeContact || !sender || !activeRoomId || !message.trim() || sending) return;
    if (
      !activeContact.active || activeContact.legacyRoomId || activeRoomOverride ||
      !charGrant(sender, user.id) ||
      !activeContact.character || !charGrant(activeContact.character, activeContact.targetId)
    ) {
      setDmError("이 연락처에서는 새 메시지를 보낼 수 없습니다.");
      return;
    }
    const be = backend();
    if (!isServerMode() || be?.kind !== "firebase") {
      setDmError("Firebase 연결 상태를 확인해 주세요.");
      return;
    }

    const now = new Date().toISOString();
    const memberIds = [user.id, activeContact.targetId].sort();
    const roomExists = rooms.some((r) => r.id === activeRoomId);
    const room: DMRoom = {
      id: activeRoomId, memberIds, createdAt: now,
      characters: [
        { userId: user.id, characterId: sender.id, characterName: sender.name },
        { userId: activeContact.targetId, characterId: activeContact.characterId, characterName: activeContact.name },
      ],
    };
    const outgoing: DMMessage = {
      id: crypto.randomUUID(),
      roomId: activeRoomId,
      memberIds,
      senderId: user.id,
      senderName: user.nickname,
      characterId: sender.id,
      characterName: sender.name,
      text: message.trim(),
      date: now,
    };

    setSending(true);
    setDmError("");
    try {
      if (!roomExists) await syncList("dm_rooms", [], [room], user.id);
      // 오래된 메시지 목록을 통째로 덮지 않고 새 메시지 한 건만 insert.
      await syncList("dm_messages", [], [outgoing], user.id);
      if (!roomExists) setRooms((prev) => prev.some((r) => r.id === room.id) ? prev : [...prev, room]);
      setMessages((prev) => prev.some((m) => m.id === outgoing.id) ? prev : [...prev, outgoing]);
      setMessage("");
      pushNotif({
        type: "rp",
        toUserId: activeContact.targetId,
        title: "새 문자 · " + sender.name,
        body: outgoing.text.slice(0, 80),
        href: "/",
        dedupeKey: "dm:" + activeRoomId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setDmError("전송 실패: " + reason);
      toast("메시지 전송에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }

  if (!user) return null;

  return (
    <>
      <button
        className="dm-phone-button"
        onClick={() => { setOpen((v) => !v); setScreen("chats"); setArrival(null); }}
        aria-label="휴대폰 열기"
        title="Messages"
      >
        <span aria-hidden="true">☎</span>
        {unreadCount > 0 && <i className="dm-unread-badge">{unreadCount > 9 ? "9+" : unreadCount}</i>}
      </button>

      {arrival && !open && (
        <div className="dm-arrival-toast" role="status">
          <button className="dm-arrival-main" onClick={openArrival}>
            <span className="dm-arrival-mark">✉</span>
            <span className="dm-arrival-copy">
              <b>NEW MESSAGE</b>
              <strong>{chatEntries.find((entry) => entry.room.id === arrival.roomId)?.displayName ?? arrival.characterName}</strong>
              <small>{arrival.text}</small>
            </span>
          </button>
          <button className="dm-arrival-close" aria-label="알림 닫기" onClick={() => setArrival(null)}>×</button>
        </div>
      )}

      {open && (
        <aside className="dm-phone-panel">
          {screen !== "chat" ? (
            <>
              <header className="dm-phone-header">
                <div className="dm-heading">
                  <small>PRIVATE LINE / {screen === "chats" ? "CONVERSATIONS" : "DIRECTORY"}</small>
                  <strong>{screen === "chats" ? "CHATS" : "CONTACTS"}</strong>
                </div>
                <button className="dm-close" aria-label="닫기" onClick={() => setOpen(false)}>×</button>
              </header>

              <div className="dm-directory-top">
                <div className="dm-directory-intro">
                  <span>{screen === "chats" ? "CHAT ROOMS" : "PHONEBOOK"}</span>
                  <small>{screen === "chats" ? chatEntries.length + " CHATS" : contacts.length + " CONTACTS"}</small>
                </div>
                <input
                  className="dm-search"
                  placeholder={screen === "chats" ? "대화방 검색" : "캐릭터 이름 검색"}
                  aria-label={screen === "chats" ? "대화방 검색" : "캐릭터 이름 검색"}
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                />
              </div>

              <div className="dm-directory-list">
                {!dmLoaded && <p className="dm-empty">메시지를 불러오는 중입니다…</p>}
                {memberError && <p className="dm-inline-error">{memberError}</p>}
                {dmError && <p className="dm-inline-error">{dmError}</p>}

                {screen === "contacts" ? (
                  searchedContacts.length > 0 ? (
                    <section className="dm-directory-section">
                      <h3>CHARACTERS <span>메시지를 보낼 수 있는 캐릭터</span></h3>
                      {searchedContacts.map((c) => (
                        <button key={c.key} className="dm-contact" onClick={() => chooseContact(c)}>
                          <ContactPortrait contact={c} />
                          <span className="dm-contact-copy">
                            <strong>{c.name}</strong>
                            <small>대화하기</small>
                          </span>
                          <span className="dm-contact-chevron">›</span>
                        </button>
                      ))}
                    </section>
                  ) : dmLoaded && (
                    <div className="dm-empty">
                      {queryText ? "검색 결과가 없습니다." : "등록된 연락처가 없습니다."}
                      <small>다른 회원에게 플레이·편집 권한이 부여된 캐릭터만 표시됩니다.</small>
                    </div>
                  )
                ) : (
                  searchedChats.length > 0 ? (
                    <section className="dm-directory-section">
                      <h3>CONVERSATIONS <span>채팅방</span></h3>
                      {searchedChats.map((entry) => (
                        <div
                          key={entry.room.id}
                          className="dm-room-row"
                          onContextMenu={(e) => { e.preventDefault(); openRoomMenu(entry.room.id); }}
                        >
                          <button
                            className="dm-contact"
                            title="대화방 열기"
                            onClick={() => openChatEntry(entry)}
                          >
                            <ContactPortrait contact={entry.contact} />
                            <span className="dm-contact-copy">
                              <strong>{entry.displayName}</strong>
                              <small>
                                {entry.myCharacterName ? entry.myCharacterName + " · " : ""}
                                {entry.last?.text ?? "대화 기록"}
                              </small>
                            </span>
                            <span className="dm-contact-end">
                              <time>{displayTime(entry.last?.date ?? entry.room.createdAt)}</time>
                              {entry.unread > 0 && <i>{entry.unread > 9 ? "9+" : entry.unread}</i>}
                            </span>
                          </button>
                          <button
                            className="dm-room-more"
                            aria-label={entry.displayName + " 채팅방 관리"}
                            title="이름 변경 / 삭제"
                            onClick={() => openRoomMenu(entry.room.id)}
                          >···</button>
                        </div>
                      ))}
                    </section>
                  ) : dmLoaded && (
                    <div className="dm-empty">
                      {queryText ? "검색 결과가 없습니다." : "아직 열린 채팅방이 없습니다."}
                      <small>연락처에서 캐릭터를 선택해 대화를 시작하세요.</small>
                    </div>
                  )
                )}
              </div>

              <nav className="dm-bottom-tabs" aria-label="휴대폰 메뉴">
                <button
                  type="button"
                  className={screen === "contacts" ? "active" : ""}
                  aria-current={screen === "contacts" ? "page" : undefined}
                  onClick={() => { setScreen("contacts"); setQueryText(""); }}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M16 20v-1.8a4.2 4.2 0 0 0-4.2-4.2H6.2A4.2 4.2 0 0 0 2 18.2V20" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M19 8a3.2 3.2 0 0 1 0 6.4M22 20v-1.8a4.2 4.2 0 0 0-3-4" />
                  </svg>
                  <small>연락처</small>
                </button>
                <button
                  type="button"
                  className={screen === "chats" ? "active" : ""}
                  aria-current={screen === "chats" ? "page" : undefined}
                  onClick={() => { setScreen("chats"); setQueryText(""); }}
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-7.5A7.5 7.5 0 0 1 10.5 6H12" />
                    <path d="M10 3.4A7.8 7.8 0 0 1 20.6 14L21 17l-3.4-1.8" />
                  </svg>
                  <small>채팅</small>
                  {unreadCount > 0 && <i>{unreadCount > 9 ? "9+" : unreadCount}</i>}
                </button>
              </nav>
            </>
          ) : (
            <>
              <header className="dm-phone-header dm-chat-header">
                <button className="dm-back" onClick={() => { setScreen(backScreen); setDmError(""); }} aria-label="연락처 목록으로">‹</button>
                {activeContact && <ContactPortrait contact={activeContact} small />}
                <div className="dm-heading">
                  <strong>{activeRoomName}</strong>
                  <small>{activeContact?.legacyRoomId ? "ARCHIVED CONVERSATION" : "PRIVATE CONVERSATION"}</small>
                </div>
                <button className="dm-close" aria-label="닫기" onClick={() => setOpen(false)}>×</button>
              </header>

              <div className="dm-messages" aria-live="polite">
                {roomMessages.length === 0 && dmLoaded && (
                  <div className="dm-empty">새로운 대화입니다.<small>첫 메시지를 보내 보세요.</small></div>
                )}
                {roomMessages.map((m) => (
                  <div key={m.id} className={"dm-message " + (m.senderId === user.id ? "dm-mine" : "dm-theirs")}>
                    <small>{m.characterName} <time>{displayTime(m.date)}</time></small>
                    <div>{m.text}</div>
                  </div>
                ))}
              </div>

              {dmError && <p className="dm-inline-error">{dmError}</p>}
              {activeContact?.legacyRoomId || !!activeRoomOverride ? (
                <div className="dm-archive-note">이 대화는 기록 열람만 가능합니다. 캐릭터의 플레이 권한을 확인해 주세요.</div>
              ) : (
                <form className="dm-compose dm-compose-character" onSubmit={sendMessage}>
                  <label className="dm-sender-select">
                    <span>FROM</span>
                    <select
                      value={senderCharacterId}
                      onChange={(e) => setSenderCharacterId(e.target.value)}
                      aria-label="보내는 캐릭터"
                    >
                      {ownCharacters.length === 0 && <option value="">캐릭터 없음</option>}
                      {ownCharacters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <div className="dm-compose-row">
                    <input
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="메시지를 입력하세요…"
                      disabled={!activeContact?.active || !sender || !!activeRoomOverride || sending}
                    />
                    <button type="submit" disabled={!message.trim() || !activeContact?.active || !sender || !!activeRoomOverride || sending}>
                      {sending ? "···" : "전송"} <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                  {!activeContact?.active && <small className="dm-inline-note">현재 캐릭터 사용 권한이 없어 읽기만 가능합니다.</small>}
                </form>
              )}
            </>
          )}

          {manageRoomId && managedEntry && (
            <div className="dm-manage-overlay" onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeRoomMenu();
            }}>
              <div className="dm-manage-sheet" role="dialog" aria-modal="true"
                aria-label={manageStep === "options" ? "채팅방 관리" : manageStep === "rename" ? "채팅방 이름 변경" : "채팅방 삭제"}>
                {manageStep === "options" ? (
                  <>
                    <div className="dm-manage-heading">
                      <small>CHAT OPTIONS</small>
                      <strong>{managedEntry.displayName}</strong>
                    </div>
                    <button className="dm-manage-option" onClick={() => {
                      setRenameDraft(managedEntry.room.titleByUser?.[user.id] || managedEntry.displayName);
                      setManageStep("rename");
                      setManageError("");
                    }}>
                      <span aria-hidden="true">✎</span> 채팅방 이름 변경
                    </button>
                    <button className="dm-manage-option dm-danger" onClick={() => {
                      setManageStep("delete");
                      setManageError("");
                    }}>
                      <span aria-hidden="true">⌫</span> 채팅방 DELETE
                    </button>
                    <button className="dm-manage-cancel" onClick={closeRoomMenu}>취소</button>
                  </>
                ) : manageStep === "rename" ? (
                  <form onSubmit={(e) => { e.preventDefault(); void saveRoomName(); }}>
                    <div className="dm-manage-heading">
                      <small>RENAME CONVERSATION</small>
                      <strong>채팅방 이름 변경</strong>
                    </div>
                    <input
                      className="dm-manage-input"
                      autoFocus
                      maxLength={60}
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      placeholder="새 채팅방 이름"
                      aria-label="새 채팅방 이름"
                      disabled={manageBusy}
                    />
                    <p className="dm-manage-hint">바꾼 이름은 내 채팅 목록에만 적용됩니다.</p>
                    {manageError && <p className="dm-manage-error">{manageError}</p>}
                    <div className="dm-manage-buttons">
                      <button type="button" onClick={() => void saveRoomName(true)} disabled={manageBusy}>기본 이름</button>
                      <button type="submit" className="primary" disabled={manageBusy || !renameDraft.trim()}>
                        {manageBusy ? "저장 중…" : "저장"}
                      </button>
                    </div>
                    <button type="button" className="dm-manage-cancel" onClick={closeRoomMenu} disabled={manageBusy}>취소</button>
                  </form>
                ) : (
                  <>
                    <div className="dm-manage-heading">
                      <small>DELETE CONVERSATION</small>
                      <strong>이 채팅방을 삭제할까요?</strong>
                    </div>
                    <p className="dm-manage-hint">
                      내 채팅 목록에서만 삭제됩니다. 상대방 기록은 그대로 남으며,
                      나중에 새 메시지가 오면 다시 목록에 나타납니다.
                    </p>
                    {manageError && <p className="dm-manage-error">{manageError}</p>}
                    <div className="dm-manage-buttons">
                      <button onClick={closeRoomMenu} disabled={manageBusy}>취소</button>
                      <button className="danger" onClick={() => void deleteRoomForMe()} disabled={manageBusy}>
                        {manageBusy ? "삭제 중…" : "DELETE"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
