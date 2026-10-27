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
        <span>{contact.legacyRoomId ? "↶" : initials(contact.name)}</span>
      )}
    </span>
  );
}

export function PhoneDM() {
  const { user } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<"contacts" | "chat">("contacts");
  const [queryText, setQueryText] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [memberError, setMemberError] = useState("");
  const [dmError, setDmError] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [senderCharacterId, setSenderCharacterId] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
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
    setScreen("contacts");
    setActiveKey("");
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
    return chars.filter((c) => (user.role === "admin" && c.own) || !!charGrant(c, user.id));
  }, [chars, user]);

  const contacts = useMemo(() => {
    if (!user) return [] as Contact[];
    const map = new Map<string, Contact>();
    const memberIds = new Set(members.map((m) => m.id));
    const admins = members.filter((m) => m.role === "admin").map((m) => m.id);
    const add = (targetId: string, characterId: string, name: string, color: string, character?: Character, active = true) => {
      if (!targetId || targetId === user.id) return;
      const key = targetId + "|" + characterId;
      const old = map.get(key);
      map.set(key, {
        key, targetId, characterId, name, color, character,
        active: active || !!old?.active,
      });
    };

    // 전화번호부의 주인은 캐릭터에 부여된 플레이/편집 권한으로 결정.
    // own 캐릭터는 관리자 계정이 주인이고, grants가 있는 경우 해당 회원도 플레이어다.
    for (const c of chars) {
      const owners = new Set<string>([
        ...(c.own ? admins : []),
        ...(c.grants ?? []).map((g) => g.userId),
      ]);
      for (const uid of owners) {
        if (memberIds.has(uid)) add(uid, c.id, c.name, c.color || "#9a9da3", c);
      }
    }

    // 권한이 변경되거나 캐릭터가 삭제돼도 이미 주고받은 대화는 기록에 남긴다.
    for (const room of rooms) {
      if (!room.memberIds.includes(user.id)) continue;
      const other = room.characters?.find((p) => p.userId !== user.id);
      if (other) {
        const c = chars.find((x) => x.id === other.characterId);
        add(other.userId, other.characterId, c?.name ?? other.characterName, c?.color ?? "#92949b", c, false);
      } else {
        const uid = room.memberIds.find((id) => id !== user.id);
        if (!uid) continue;
        const key = "legacy:" + room.id;
        map.set(key, {
          key, targetId: uid, characterId: "", name: "이전 대화",
          color: "#858b95", active: false, legacyRoomId: room.id,
        });
      }
    }
    return [...map.values()];
  }, [chars, members, rooms, user?.id]);

  const contactRooms = useCallback((contact: Contact) => rooms.filter((r) => {
    if (contact.legacyRoomId) return r.id === contact.legacyRoomId;
    return r.memberIds.includes(user?.id ?? "") && r.characters?.some(
      (p) => p.userId === contact.targetId && p.characterId === contact.characterId
    );
  }), [rooms, user?.id]);

  const lastFor = useCallback((contact: Contact) => {
    const ids = new Set(contactRooms(contact).map((r) => r.id));
    return messages.filter((m) => ids.has(m.roomId)).sort((a, b) => b.date.localeCompare(a.date))[0];
  }, [contactRooms, messages]);

  const contactLastDate = useCallback((contact: Contact) => {
    const m = lastFor(contact);
    return m?.date ?? contactRooms(contact)[0]?.createdAt ?? "";
  }, [lastFor, contactRooms]);

  const recentContacts = useMemo(() =>
    contacts.filter((c) => contactRooms(c).length > 0)
      .sort((a, b) => contactLastDate(b).localeCompare(contactLastDate(a))),
  [contacts, contactRooms, contactLastDate]);

  const otherContacts = useMemo(() => {
    const recent = new Set(recentContacts.map((c) => c.key));
    const q = queryText.trim().toLowerCase();
    return contacts.filter((c) => !recent.has(c.key) && !c.legacyRoomId && c.active)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [contacts, recentContacts, queryText]);

  const filteredRecent = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return recentContacts.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [recentContacts, queryText]);

  const activeContact = contacts.find((c) => c.key === activeKey) ?? null;
  const sender = ownCharacters.find((c) => c.id === senderCharacterId);
  const activeRoomId = useMemo(() => {
    if (!user || !activeContact) return "";
    if (activeContact.legacyRoomId) return activeContact.legacyRoomId;
    if (!sender) return "";
    return conversationId(user.id, sender.id, activeContact.targetId, activeContact.characterId);
  }, [user?.id, activeContact?.key, sender?.id]);

  const roomMessages = useMemo(() =>
    messages.filter((m) => m.roomId === activeRoomId).sort((a, b) => a.date.localeCompare(b.date)),
  [messages, activeRoomId]);

  // 읽지 않은 메시지는 회원이 아니라 *대화방* 기준으로 보관한다.
  const unreadCount = messages.filter((m) =>
    user && m.senderId !== user.id && m.date > (seen[m.roomId] ?? "")
  ).length;

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

  function chooseContact(c: Contact, preferredSenderId?: string) {
    if (!c.legacyRoomId) {
      const previous = contactRooms(c)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      const myPreviousCharacter = previous?.characters?.find((p) => p.userId === user?.id)?.characterId;
      const selected =
        ownCharacters.find((ch) => ch.id === preferredSenderId) ??
        ownCharacters.find((ch) => ch.id === myPreviousCharacter) ??
        ownCharacters.find((ch) => ch.id === senderCharacterId) ??
        ownCharacters[0];
      setSenderCharacterId(selected?.id ?? "");
    }
    setActiveKey(c.key);
    setMessage("");
    setDmError("");
    setScreen("chat");
    setArrival(null);
  }

  function openArrival() {
    if (!arrival || !user) return;
    const room = rooms.find((r) => r.id === arrival.roomId);
    const other = room?.characters?.find((p) => p.userId !== user.id);
    const mine = room?.characters?.find((p) => p.userId === user.id);
    const contact = other
      ? contacts.find((c) => c.targetId === other.userId && c.characterId === other.characterId)
      : contacts.find((c) => c.legacyRoomId === arrival.roomId);
    setOpen(true);
    if (contact) chooseContact(contact, mine?.characterId);
    else setScreen("contacts");
    setArrival(null);
  }

  async function sendMessage(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user || !activeContact || !sender || !activeRoomId || !message.trim() || sending) return;
    if (!activeContact.active || activeContact.legacyRoomId) {
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
        onClick={() => { setOpen((v) => !v); setScreen("contacts"); setArrival(null); }}
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
              <strong>{rooms.find((r) => r.id === arrival.roomId)?.characters?.find((p) => p.userId !== user.id)?.characterName ?? arrival.characterName}</strong>
              <small>{arrival.text}</small>
            </span>
          </button>
          <button className="dm-arrival-close" aria-label="알림 닫기" onClick={() => setArrival(null)}>×</button>
        </div>
      )}

      {open && (
        <aside className="dm-phone-panel">
          {screen === "contacts" ? (
            <>
              <header className="dm-phone-header">
                <div className="dm-heading"><small>PRIVATE LINE / DIRECTORY</small><strong>MESSAGES</strong></div>
                <button className="dm-close" aria-label="닫기" onClick={() => setOpen(false)}>×</button>
              </header>
              <div className="dm-directory-top">
                <div className="dm-directory-intro"><span>PHONEBOOK</span><small>{contacts.length} CONTACTS</small></div>
                <input
                  className="dm-search"
                  placeholder="캐릭터 이름 검색"
                  aria-label="캐릭터 이름 검색"
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                />
              </div>
              <div className="dm-directory-list">
                {!dmLoaded && <p className="dm-empty">메시지를 불러오는 중입니다…</p>}
                {memberError && <p className="dm-inline-error">{memberError}</p>}
                {dmError && <p className="dm-inline-error">{dmError}</p>}
                {filteredRecent.length > 0 && (
                  <section className="dm-directory-section">
                    <h3>RECENT <span>최근 대화</span></h3>
                    {filteredRecent.map((c) => {
                      const last = lastFor(c);
                      const unread = messages.filter((m) =>
                        contactRooms(c).some((r) => r.id === m.roomId) &&
                        m.senderId !== user.id && m.date > (seen[m.roomId] ?? "")
                      ).length;
                      return (
                        <button key={c.key} className="dm-contact" onClick={() => chooseContact(c)}>
                          <ContactPortrait contact={c} />
                          <span className="dm-contact-copy">
                            <strong>{c.name}</strong>
                            <small>{last?.text ?? "대화 기록"}</small>
                          </span>
                          <span className="dm-contact-end">
                            <time>{displayTime(last?.date)}</time>
                            {unread > 0 && <i>{unread > 9 ? "9+" : unread}</i>}
                          </span>
                        </button>
                      );
                    })}
                  </section>
                )}
                {otherContacts.length > 0 && (
                  <section className="dm-directory-section">
                    <h3>CONTACTS <span>캐릭터 전화번호부</span></h3>
                    {otherContacts.map((c) => (
                      <button key={c.key} className="dm-contact" onClick={() => chooseContact(c)}>
                        <ContactPortrait contact={c} />
                        <span className="dm-contact-copy">
                          <strong>{c.name}</strong>
                          <small>새 대화 시작</small>
                        </span>
                        <span className="dm-contact-chevron">›</span>
                      </button>
                    ))}
                  </section>
                )}
                {dmLoaded && filteredRecent.length === 0 && otherContacts.length === 0 && (
                  <div className="dm-empty">
                    {queryText ? "검색 결과가 없습니다." : "연락처가 없습니다."}
                    <small>캐릭터에 회원의 플레이 권한이 연결되면 연락처에 표시됩니다.</small>
                  </div>
                )}
              </div>
              <footer className="dm-directory-footer">PRIVATE MESSAGES · CHARACTER LINE</footer>
            </>
          ) : (
            <>
              <header className="dm-phone-header dm-chat-header">
                <button className="dm-back" onClick={() => { setScreen("contacts"); setDmError(""); }} aria-label="연락처 목록으로">‹</button>
                {activeContact && <ContactPortrait contact={activeContact} small />}
                <div className="dm-heading">
                  <strong>{activeContact?.name ?? "MESSAGE"}</strong>
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
              {activeContact?.legacyRoomId ? (
                <div className="dm-archive-note">이전 버전의 대화 기록입니다. 전화번호부에서 캐릭터를 선택해 새 대화를 시작할 수 있습니다.</div>
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
                      disabled={!activeContact?.active || !sender || sending}
                    />
                    <button type="submit" disabled={!message.trim() || !activeContact?.active || !sender || sending}>
                      {sending ? "···" : "전송"} <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                  {!activeContact?.active && <small className="dm-inline-note">현재 캐릭터 사용 권한이 없어 읽기만 가능합니다.</small>}
                </form>
              )}
            </>
          )}
        </aside>
      )}
    </>
  );
}
